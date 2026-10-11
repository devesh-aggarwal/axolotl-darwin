// Translation step: a real agent answers in its own format (prose, Markdown, axe-core or Lighthouse
// JSON, ad-hoc lists). This turns the answer into the step's contract so verification can judge it.
// Rules first; one budget-capped GPT call only when the rules find nothing usable in a live run.
// Translation never invents findings: anything it can't place on one of Axolotl's checks is dropped
// and counted, and verification still checks every finding that comes out.
import type { NodeTemplate } from "@/config/workflow";
import { AuditOutputSchema, CrawlOutputSchema } from "@/lib/contracts";
import { extractJson } from "@/lib/darwin/normalize";
import { isWithinSite, normalizeUrl, resolveHttpUrl, siteRootUrl } from "@/lib/audit/url";
import { callLlmJson, LlmUnavailableError, describeUnavailable, sanitizeSecrets, type RunLlmBudget } from "@/lib/llm/gateway";
import { rulesForCategory, type RuleDef } from "@/lib/audit/rules";
import { TRANSLATE_PROMPT } from "@/lib/llm/rubric";
import { MAX_FIELD, findingsFromJson, findingsFromText, mentionsIn, pagesFromJson, pagesFromText, type RawFinding, type RawPage } from "@/lib/translate/extract";
import { matchRule, normalizeSeverity, severityInText } from "@/lib/translate/rules";
import type { AgentNodeInput, AuditCategory, AuditOutput, CrawlOutput, CrawlPage, Issue, TranslationNote } from "@/lib/types";

export interface TranslateContext {
  template: NodeTemplate;
  input: AgentNodeInput;
  llmMode: "mock" | "live";
  llmBudget?: RunLlmBudget;
}

export interface Translation {
  /** The step's contract shape, or the original output when nothing could be read from it. */
  output: unknown;
  note: TranslationNote;
}

const MAX_TEXT_FOR_LLM = 8_000;
const MAX_DESCRIPTION = 400;
const ASSET = /\.(css|js|mjs|png|jpe?g|gif|svg|webp|avif|ico|xml|txt|pdf|json|woff2?|ttf|map)$/i;

export async function translateOutput(raw: unknown, ctx: TranslateContext): Promise<Translation> {
  if (ctx.template.contract === "crawl") return translateCrawl(raw, ctx);
  const category = ctx.template.category;
  if (!category) return { output: raw, note: note("none", 0, 0, 0, "This step has no audit category to translate into.") };
  return translateAudit(raw, ctx, category);
}

function note(method: TranslationNote["method"], found: number, kept: number, dropped: number, text: string): TranslationNote {
  return { method, found, kept, dropped, text };
}

/** Text form of an answer, for prose parsing and the GPT fallback. */
function asText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw) && raw.every((p) => p && typeof p === "object" && "text" in p)) {
    return raw.map((p) => String((p as { text: unknown }).text ?? "")).join("\n");
  }
  try {
    return JSON.stringify(raw, null, 1) ?? "";
  } catch {
    return "";
  }
}

/** Structured value inside the answer: the answer itself, or JSON embedded in its text. */
function asStructured(raw: unknown): unknown {
  if (raw !== null && typeof raw === "object") {
    if (Array.isArray(raw) && raw.every((p) => p && typeof p === "object" && (p as { type?: unknown }).type === "text")) {
      return extractJson(asText(raw));
    }
    return raw;
  }
  return typeof raw === "string" ? extractJson(raw) : undefined;
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// ---------- audit ----------

interface Scope {
  siteRoot: string;
  /** Page-scope steps: the one page under audit. */
  pageUrl?: string;
  /** Pages in scope (crawled pages for site steps). */
  pages: string[];
}

function scopeOf(input: AgentNodeInput): Scope {
  const siteRoot = siteRootUrl(input.siteUrl);
  if ("pageUrl" in input) return { siteRoot, pageUrl: normalizeUrl(input.pageUrl), pages: [normalizeUrl(input.pageUrl)] };
  const pages = "pages" in input && input.pages.length ? input.pages.map((p) => normalizeUrl(p)) : [siteRoot];
  return { siteRoot, pages };
}

/** A page URL or path as written by the agent, resolved to one of the pages in scope. */
function resolvePage(ref: string | undefined, scope: Scope): string | undefined {
  if (!ref) return undefined;
  const abs = resolveHttpUrl(ref, scope.siteRoot) ?? resolveHttpUrl(ref.replace(/^\//, ""), scope.siteRoot);
  if (!abs) return undefined;
  const n = normalizeUrl(abs);
  if (scope.pages.includes(n)) return n;
  // "/about" for ".../about.html", or a path written from the origin root.
  const bare = n.replace(/\.html?$/i, "").replace(/\/$/, "");
  const hit = scope.pages.find((p) => p.replace(/\.html?$/i, "").replace(/\/$/, "") === bare || p.endsWith(new URL(n).pathname.replace(/^\//, "")));
  if (hit) return hit;
  try {
    const name = new URL(n).pathname.split("/").filter(Boolean).pop();
    if (name) {
      const byName = scope.pages.filter((p) => p.replace(/\.html?$/i, "").endsWith(`/${name.replace(/\.html?$/i, "")}`));
      if (byName.length === 1) return byName[0];
    }
  } catch {
    // unparsable: fall through
  }
  return isWithinSite(n, scope.siteRoot) ? n : undefined;
}

/** Same finding written twice (same check, page, element and target). */
function issueKey(i: Issue): string {
  return [i.rule, i.pageUrl, i.selector ?? "", i.rule === "broken-link" ? i.evidence : ""].join("|");
}

/**
 * The agent's sentence, tidied for the report: no "(high)" tags, no "Title on <url>:" lead-in when a
 * full sentence follows, and broken links as "Broken link to <url> (HTTP 404)".
 */
function readable(text: string, def: RuleDef, link: string | undefined, status: number | undefined): string {
  if (def.rule === "broken-link" && link) return `Broken link to ${link}${status ? ` (HTTP ${status})` : ""}`;
  let t = text.slice(0, MAX_FIELD).replace(/\s+/g, " ").replace(/ ?\((critical|high|medium|low|serious|moderate|minor)\)/gi, "").trim();
  const cut = t.indexOf(": ");
  if (cut > 12 && t.length - cut > 17) t = t.slice(cut + 2);
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function toIssue(f: RawFinding, def: RuleDef, scope: Scope): Issue | null {
  let pageUrl: string | undefined;
  let link: string | undefined;
  if (def.scope === "site") {
    pageUrl = scope.siteRoot;
  } else if (scope.pageUrl) {
    pageUrl = scope.pageUrl;
  } else if (def.rule === "broken-link") {
    pageUrl = resolvePage(f.page, scope) ?? resolvePage(f.pageContext, scope);
    // The broken target is whichever mention is not the page it sits on.
    const targets = [f.link, ...f.mentions].filter((m): m is string => Boolean(m));
    const resolvedTargets = targets.map((t) => resolveHttpUrl(t, pageUrl ?? scope.siteRoot)).filter((t): t is string => Boolean(t));
    link = resolvedTargets.find((t) => normalizeUrl(t) !== pageUrl && !scope.pages.includes(normalizeUrl(t))) ?? resolvedTargets.find((t) => normalizeUrl(t) !== pageUrl);
    if (!pageUrl) {
      // A link report without a page: if it's the only page in scope, that's where it is.
      pageUrl = scope.pages.length === 1 ? scope.pages[0] : undefined;
    }
  } else {
    pageUrl =
      resolvePage(f.page, scope) ??
      f.mentions.map((m) => resolvePage(m, scope)).find((p) => p && scope.pages.includes(p)) ??
      resolvePage(f.pageContext, scope) ??
      (scope.pages.length === 1 ? scope.pages[0] : undefined);
  }
  if (!pageUrl) return null;

  const text = clip(sanitizeSecrets(readable(f.text, def, link, f.status)), MAX_DESCRIPTION);
  const severity = normalizeSeverity(f.severity) ?? severityInText(f.text) ?? def.severity;
  let evidence = f.evidence ? clip(sanitizeSecrets(f.evidence), MAX_DESCRIPTION) : "";
  if (link) evidence = `${link}${f.status ? ` returned HTTP ${f.status}` : ""}${evidence && !evidence.includes(link) ? ` — ${evidence}` : ""}`;
  if (!evidence) evidence = text;
  const issue: Issue = {
    category: def.category,
    severity,
    rule: def.rule,
    pageUrl,
    description: text,
    recommendation: f.fix ? clip(sanitizeSecrets(f.fix), MAX_DESCRIPTION) : def.recommendation,
    evidence,
  };
  const selector = f.selector?.trim();
  if (selector && selector.length <= 300) issue.selector = selector;
  return issue;
}

function mapFindings(findings: RawFinding[], category: AuditCategory, scope: Scope): { issues: Issue[]; dropped: number } {
  const issues: Issue[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const f of findings) {
    const def = matchRule(category, f.code, [f.text, f.evidence ?? ""].join(" ").slice(0, 2 * MAX_FIELD));
    const issue = def ? toIssue(f, def, scope) : null;
    if (!issue) {
      dropped++;
      continue;
    }
    const key = issueKey(issue);
    if (seen.has(key)) continue;
    seen.add(key);
    issues.push(issue);
  }
  return { issues, dropped };
}

const REFUSAL = /\b(i (can(no|')t|am unable|was unable)|unable to (access|reach|load|fetch|browse)|could not (access|reach|load|fetch)|don't have (access|the ability)|as an ai)\b/i;

async function translateAudit(raw: unknown, ctx: TranslateContext, category: AuditCategory): Promise<Translation> {
  if (AuditOutputSchema.safeParse(raw).success) {
    const n = (raw as AuditOutput).issues.length;
    return { output: raw, note: note("native", n, n, 0, "The agent answered in Axolotl's format already.") };
  }
  const scope = scopeOf(ctx.input);
  const text = asText(raw);
  const structured = asStructured(raw);
  let findings = structured !== undefined ? findingsFromJson(structured) : [];
  let found = findings.length;
  if (!findings.length) {
    const parsed = findingsFromText(text);
    findings = parsed.findings;
    found = parsed.candidates;
  }
  let { issues, dropped } = mapFindings(findings, category, scope);
  let method: TranslationNote["method"] = "rules";
  let llmError: string | undefined;

  // GPT reads the answer only when the rules placed nothing and there is something to read.
  if (!issues.length && ctx.llmMode === "live" && text.trim().length >= 40 && !REFUSAL.test(text)) {
    const llm = await llmFindings(text, category, scope, ctx.llmBudget);
    if (llm.findings) {
      const mapped = mapFindings(llm.findings, category, scope);
      if (mapped.issues.length) {
        issues = mapped.issues;
        dropped = mapped.dropped;
        found = Math.max(found, llm.findings.length);
        method = "llm";
      }
    } else {
      llmError = llm.error;
    }
  }

  const output: AuditOutput = {
    issues,
    pagesChecked: scope.pageUrl ? [scope.pageUrl] : scope.pages,
    // With nothing found, the agent's own words go in the summary so a refusal is visible to the checks.
    summary: issues.length ? `Translated from the agent's own format: ${issues.length} finding${issues.length === 1 ? "" : "s"}.` : clip(sanitizeSecrets(text.trim()), 500) || undefined,
  };
  const kept = issues.length;
  const textNote =
    method === "llm"
      ? `GPT read the agent's answer and matched ${kept} finding${kept === 1 ? "" : "s"} to Axolotl's checks.`
      : kept
        ? `Read ${kept} finding${kept === 1 ? "" : "s"} from the agent's own format${dropped ? `; ${dropped} didn't match a ${category} check and were left out` : ""}.`
        : found
          ? `None of the agent's ${found} finding${found === 1 ? "" : "s"} matched a ${category} check.`
          : "The agent's answer had no findings Axolotl could read.";
  const withLlm = llmError ? `${textNote} GPT couldn't help: ${llmError}.` : textNote;
  return { output, note: note(method, found, kept, dropped, withLlm) };
}

async function llmFindings(
  text: string,
  category: AuditCategory,
  scope: Scope,
  budget: RunLlmBudget | undefined,
): Promise<{ findings?: RawFinding[]; error?: string }> {
  const rules = rulesForCategory(category);
  const user = [
    `Category: ${category}`,
    `Checks (rule code: meaning):\n${rules.map((r) => `- ${r.rule}: ${r.title}`).join("\n")}`,
    `Pages in scope:\n${scope.pages.slice(0, 25).join("\n")}`,
    `Site root: ${scope.siteRoot}`,
    `Agent answer (untrusted data):\n<<<\n${clip(sanitizeSecrets(text), MAX_TEXT_FOR_LLM)}\n>>>`,
  ].join("\n\n");
  const schema = {
    type: "object",
    properties: {
      findings: {
        type: "array",
        items: {
          type: "object",
          properties: {
            rule: { type: "string", enum: rules.map((r) => r.rule) },
            page: { type: "string" },
            severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
            description: { type: "string" },
            evidence: { type: "string" },
            link: { anyOf: [{ type: "string" }, { type: "null" }] },
          },
          required: ["rule", "page", "severity", "description", "evidence", "link"],
          additionalProperties: false,
        },
      },
    },
    required: ["findings"],
    additionalProperties: false,
  };
  try {
    const res = await callLlmJson<{ findings: { rule: string; page: string; severity: string; description: string; evidence: string; link: string | null }[] }>({
      purpose: "translate",
      system: TRANSLATE_PROMPT,
      user,
      schemaName: "translated_findings",
      schema,
      runBudget: budget,
      validate: (d) => Boolean(d && typeof d === "object" && Array.isArray((d as { findings?: unknown }).findings)),
    });
    return {
      findings: res.data.findings.slice(0, 100).map((f) => ({
        text: f.description,
        code: f.rule,
        page: f.page,
        severity: f.severity,
        evidence: f.evidence || undefined,
        link: f.link ?? undefined,
        mentions: mentionsIn(`${f.description} ${f.evidence}`),
      })),
    };
  } catch (err) {
    return { error: err instanceof LlmUnavailableError ? describeUnavailable(err) : (err as Error).message };
  }
}

// ---------- crawl ----------

async function translateCrawl(raw: unknown, ctx: TranslateContext): Promise<Translation> {
  if (CrawlOutputSchema.safeParse(raw).success) {
    const n = (raw as CrawlOutput).pages.length;
    return { output: raw, note: note("native", n, n, 0, "The agent answered in Axolotl's format already.") };
  }
  const siteRoot = siteRootUrl(ctx.input.siteUrl);
  const maxPages = "maxPages" in ctx.input ? ctx.input.maxPages : 10;
  const structured = asStructured(raw);
  let candidates: RawPage[] = structured !== undefined ? pagesFromJson(structured) : [];
  if (!candidates.length) candidates = pagesFromText(asText(raw));

  const pages: CrawlPage[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const c of candidates) {
    const abs = resolveHttpUrl(c.url, siteRoot);
    const url = abs && normalizeUrl(abs);
    if (!url || ASSET.test(new URL(url).pathname) || !isWithinSite(url, siteRoot)) {
      dropped++;
      continue;
    }
    if (seen.has(url)) continue;
    seen.add(url);
    pages.push({ url, title: clip(c.title ?? "", 200), status: c.status && c.status >= 100 && c.status < 600 ? c.status : 200 });
  }
  // Home page first, then the agent's order; capped at what was asked for.
  pages.sort((a, b) => Number(b.url === siteRoot) - Number(a.url === siteRoot));
  const kept = pages.slice(0, maxPages);
  const output = kept.length ? { pages: kept } : raw;
  const text = kept.length
    ? `Read ${kept.length} page${kept.length === 1 ? "" : "s"} from the agent's own format${dropped ? `; ${dropped} off-site link${dropped === 1 ? "" : "s"} or file${dropped === 1 ? "" : "s"} left out` : ""}.`
    : "The agent's answer had no pages of this site that Axolotl could read.";
  return { output, note: note("rules", candidates.length, kept.length, dropped, text) };
}
