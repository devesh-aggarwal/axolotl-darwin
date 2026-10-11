// Verification layer 4: a fixed-rubric judge. The mock judge is a deterministic heuristic;
// the live judge makes one guarded LLM call and falls back to the mock judge when it can't.
import type { AgentNodeInput, AuditCategory, Capability, LayerResult } from "@/lib/types";
import { normalizeUrl, siteRootUrl } from "@/lib/audit/url";
import { callLlmJson, describeUnavailable, LlmUnavailableError, type RunLlmBudget } from "@/lib/llm/gateway";
import { JUDGE_RUBRIC } from "@/lib/llm/rubric";

export interface JudgeInput {
  templateId: string;
  label: string;
  capability: Capability;
  category?: AuditCategory;
  input: AgentNodeInput;
  output: unknown;
  priorLayers: LayerResult[];
  crawledPages: string[];
}

const NAME = "LLM judge";
const MAX_ISSUES_SENT = 25;
const OUTPUT_CHAR_BUDGET = 5_500;

// First-person phrasing only, so findings like "screen readers cannot access…" are not refusals.
const REFUSAL_RE =
  /\b(?:i['’]?m sorry|i am sorry|i apologi[sz]e|my apologies|as an ai\b|as a language model|(?:i|we) (?:cannot|can['’]?t|am unable to|are unable to|am not able to|do not have access|don['’]?t have access)|i['’]?m (?:unable|not able) to|we['’]?re (?:unable|not able) to)/i;
const PLACEHOLDER_RE = /\blorem ipsum\b|<insert\b|\[insert\b|\{\{\s*\w+\s*\}\}/i;
const PLACEHOLDER_MARKER_RE = /\b(?:TODO|TBD|FIXME)\b/;
const GENERIC_PHRASE_RE =
  /\b(issues? (?:was |were )?(?:found|detected|identified)|problems? (?:found|detected)|various issues|some issues|multiple issues|several issues|needs? improvement|could be (?:improved|better)|general issue|potential issue|best practices?|not optimi[sz]ed|see (?:the )?report|n\/a|missing (?:critical |important |required )?(?:markup|elements|content|attributes|tags))\b/i;
const VAGUE_EVIDENCE_RE = /^(?:observed|found|detected|seen|noted|identified|confirmed|verified)\b|during (?:the )?(?:audit|scan|review)|see (?:above|description)|^(?:n\/?a|none|yes|true)\.?$/i;
const SPECIFIC_TOKEN_RE =
  /https?:\/\/|[#.][a-z][\w-]*|<\/?[a-z][\w-]*|\d|"[^"]+"|'[^']+'|\b[a-z]+(?:-[a-z]+)+\b|\.(?:html?|png|jpe?g|gif|webp|avif|svg|js|css|xml|txt)\b/i;
const GENERIC_RECOMMENDATION_RE =
  /^(?:add|include|provide|fix) the missing \w+\.?$|^(?:please )?(?:fix|resolve|address|correct|repair|handle|look into|investigate|review)(?: (?:this|the|that|these|it))?(?: (?:issue|problem|error|finding)s?)?\.?$|^(?:this |it )?(?:should|must|needs to) be (?:fixed|resolved|addressed|corrected)\.?$/i;
const ACTION_VERB_RE =
  /\b(add|set|use|remove|replace|compress|convert|resize|defer|move|rename|wrap|include|declare|serve|enable|configure|change|darken|lighten|update|point|redirect|create|provide|give|associate|specify|send|return|lazy|split|inline|preload|switch|drop|delete|keep|demote|merge|publish|list)\b/i;

// ---------- small helpers ----------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function normText(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function words(s: string): Set<string> {
  return new Set(normText(s).split(/[^a-z0-9#.-]+/).filter((w) => w.length > 2));
}

function jaccard(a: string, b: string): number {
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter += 1;
  return inter / (A.size + B.size - inter);
}

function verdict(pass: boolean, reason: string, confidence: number, details?: unknown): LayerResult {
  const c = Math.round(Math.min(1, Math.max(0, confidence)) * 100) / 100;
  return { layer: 4, name: NAME, pass, reason, confidence: c, source: "mock", ...(details ? { details } : {}) };
}

// ---------- expectations from earlier layers ----------

function expectedInDetails(v: unknown, depth: number): number {
  if (depth > 3 || !isRecord(v)) return 0;
  let max = 0;
  for (const [k, val] of Object.entries(v)) {
    if (/^expected(?:issues|count)?$/i.test(k)) {
      if (typeof val === "number" && Number.isFinite(val)) max = Math.max(max, val);
      if (Array.isArray(val)) max = Math.max(max, val.length);
    } else if (isRecord(val)) {
      max = Math.max(max, expectedInDetails(val, depth + 1));
    }
  }
  return max;
}

/** How many issues the earlier layers say should be present (0 when none flagged). */
export function expectedFromPriorLayers(layers: LayerResult[]): number {
  let max = 0;
  for (const l of layers) {
    max = Math.max(max, expectedInDetails(l.details, 0));
    const m = /\bexpect(?:s|ed|ing)?\b\D{0,24}?(\d+)/i.exec(l.reason ?? "");
    if (m) max = Math.max(max, Number(m[1]));
    if (/zero[- ]issue|empty report/i.test(l.reason ?? "") && !l.pass) max = Math.max(max, 1);
  }
  return max;
}

// ---------- mock judge: crawl ----------

function judgeCrawl(j: JudgeInput): LayerResult {
  const pages = isRecord(j.output) && Array.isArray(j.output.pages) ? j.output.pages : null;
  if (!pages) return verdict(false, "Crawl output has no pages array, so there is nothing to fan out over.", 0.9);
  if (pages.length === 0) return verdict(false, "Crawl output lists zero pages for a site that must have at least its home page.", 0.9);
  const site = "siteUrl" in j.input ? j.input.siteUrl : "";
  let origin = "";
  try {
    origin = new URL(site).origin;
  } catch {
    origin = "";
  }
  const seen = new Set<string>();
  let duplicates = 0;
  let offSite = 0;
  let bad = 0;
  let refusal = false;
  for (const p of pages) {
    const url = isRecord(p) ? str(p.url) : "";
    const n = normalizeUrl(url);
    if (seen.has(n)) duplicates += 1;
    seen.add(n);
    try {
      if (origin && new URL(url).origin !== origin) offSite += 1;
    } catch {
      offSite += 1;
    }
    if (!isRecord(p) || p.status !== 200) bad += 1;
    if (isRecord(p) && REFUSAL_RE.test(str(p.title))) refusal = true;
  }
  if (refusal) return verdict(false, "Crawl output contains refusal or apology text instead of page titles.", 0.9);
  if (offSite) return verdict(false, `Crawl output includes ${plural(offSite, "page")} outside ${origin || "the site"}.`, 0.9);
  if (duplicates) return verdict(false, `Crawl output lists ${plural(duplicates, "duplicate page")}.`, 0.85);
  if (bad) return verdict(false, `Crawl output includes ${plural(bad, "page")} without HTTP status 200.`, 0.85);
  const cap = "maxPages" in j.input ? j.input.maxPages : Infinity;
  if (pages.length > cap) return verdict(false, `Crawl returned ${pages.length} pages, more than the cap of ${cap}.`, 0.85);
  // `/demo-site` and `/demo-site/` both name the home page.
  const homeFound = site ? seen.has(normalizeUrl(site)) || seen.has(siteRootUrl(site)) : true;
  const reason = `Checked ${plural(pages.length, "crawled page")}: unique same-origin URLs, all HTTP 200, within the ${
    Number.isFinite(cap) ? cap : "requested"
  }-page cap${homeFound ? ", home page included" : "; the home page is not listed"}.`;
  return verdict(true, reason, homeFound ? 0.9 : 0.75);
}

// ---------- mock judge: audit ----------

interface IssueLike {
  category: string;
  rule: string;
  pageUrl: string;
  selector: string;
  description: string;
  recommendation: string;
  evidence: string;
}

function toIssue(v: unknown): IssueLike {
  const r = isRecord(v) ? v : {};
  return {
    category: str(r.category),
    rule: str(r.rule),
    pageUrl: str(r.pageUrl),
    selector: str(r.selector),
    description: str(r.description),
    recommendation: str(r.recommendation),
    evidence: str(r.evidence),
  };
}

function isGenericDescription(d: string): boolean {
  const t = d.trim();
  if (t.length < 12) return true;
  return GENERIC_PHRASE_RE.test(t) && !SPECIFIC_TOKEN_RE.test(t);
}

/** Evidence that is absent, or so vague it names nothing observable. */
function lacksEvidence(evidence: string): boolean {
  const t = evidence.trim();
  if (t.length < 3) return true;
  return !SPECIFIC_TOKEN_RE.test(t) && (t.length < 25 || VAGUE_EVIDENCE_RE.test(t));
}

function restatesProblem(i: IssueLike): boolean {
  const rec = i.recommendation.trim();
  if (!rec) return true;
  if (normText(rec) === normText(i.description)) return true;
  if (GENERIC_RECOMMENDATION_RE.test(rec)) return true;
  return jaccard(rec, i.description) >= 0.8 && !ACTION_VERB_RE.test(rec);
}

function allowedPages(j: JudgeInput): Set<string> | null {
  if (!j.crawledPages.length) return null;
  const set = new Set(j.crawledPages.map((u) => normalizeUrl(u)));
  if ("siteUrl" in j.input) {
    set.add(normalizeUrl(j.input.siteUrl));
    set.add(siteRootUrl(j.input.siteUrl));
  }
  if ("pageUrl" in j.input) set.add(normalizeUrl(j.input.pageUrl));
  return set;
}

function judgeEmptyAudit(j: JudgeInput, scope: string): LayerResult {
  const expected = expectedFromPriorLayers(j.priorLayers);
  if (expected > 0) {
    return verdict(false, `Report is empty for ${scope} although earlier layers expect ${plural(expected, "issue")} there.`, 0.9);
  }
  return verdict(true, `No findings reported for ${scope}; no earlier layer expected issues and the report has no refusal or placeholder text.`, 0.7);
}

function judgeAudit(j: JudgeInput): LayerResult {
  const out = isRecord(j.output) ? j.output : null;
  if (!out || !Array.isArray(out.issues)) return verdict(false, "Output is not an audit report (no issues array).", 0.9);
  const issues = out.issues.map(toIssue);
  const category = j.category ?? (j.capability === "crawl" ? undefined : j.capability);
  const scope = "pageUrl" in j.input ? j.input.pageUrl : "siteUrl" in j.input ? j.input.siteUrl : "the site";
  const allText = [str(out.summary), ...issues.flatMap((i) => [i.description, i.recommendation, i.evidence])].join("\n");

  const refusal = REFUSAL_RE.exec(allText);
  if (refusal) return verdict(false, `Output contains refusal/apology language ("${clip(refusal[0], 40)}") instead of findings.`, 0.95);
  const placeholder = PLACEHOLDER_RE.exec(allText) ?? PLACEHOLDER_MARKER_RE.exec(allText);
  if (placeholder) return verdict(false, `Output contains placeholder text ("${clip(placeholder[0], 30)}").`, 0.9);
  if (issues.length === 0) return judgeEmptyAudit(j, scope);

  const n = issues.length;
  const wrongCat = category ? issues.filter((i) => i.category !== category) : [];
  if (wrongCat.length) {
    return verdict(false, `${plural(wrongCat.length, "finding")} belong to "${wrongCat[0].category}", not the node's ${category} category.`, 0.9);
  }
  const allowed = allowedPages(j);
  const offPage = allowed ? issues.filter((i) => !allowed.has(normalizeUrl(i.pageUrl))) : [];
  if (offPage.length) {
    return verdict(false, `${plural(offPage.length, "finding")} point at pages that were never crawled (e.g. ${clip(offPage[0].pageUrl, 80)}).`, 0.9);
  }

  const keys = new Set<string>();
  let exactDupes = 0;
  for (const i of issues) {
    const k = [i.rule, normalizeUrl(i.pageUrl), i.selector, normText(i.description), normText(i.evidence)].join("|");
    if (keys.has(k)) exactDupes += 1;
    keys.add(k);
  }
  const distinctDescriptions = new Set(issues.map((i) => normText(i.description))).size;
  const generic = issues.filter((i) => isGenericDescription(i.description)).length;
  const noEvidence = issues.filter((i) => lacksEvidence(i.evidence)).length;
  const restated = issues.filter(restatesProblem).length;

  if (exactDupes) return verdict(false, `Report repeats ${plural(exactDupes, "identical finding")} verbatim.`, 0.85);
  if (n >= 4 && distinctDescriptions / n < 0.5) {
    return verdict(false, `Only ${distinctDescriptions} distinct descriptions across ${n} findings: boilerplate, not page-specific findings.`, 0.85);
  }
  if (generic / n >= 0.5) return verdict(false, `${generic} of ${n} findings have generic descriptions that name no element, file or value.`, 0.85);
  if (noEvidence / n > 0.5) return verdict(false, `${noEvidence} of ${n} findings carry no concrete evidence.`, 0.85);
  if (restated / n > 0.5) return verdict(false, `${restated} of ${n} recommendations only restate the problem instead of saying what to change.`, 0.85);

  const minor: string[] = [];
  if (generic) minor.push(`${generic} generic description${generic === 1 ? "" : "s"}`);
  if (noEvidence) minor.push(`${noEvidence} without evidence`);
  if (restated) minor.push(`${restated} vague recommendation${restated === 1 ? "" : "s"}`);
  const pages = new Set(issues.map((i) => normalizeUrl(i.pageUrl))).size;
  const confidence = 0.95 - 0.07 * minor.length - (n === 1 ? 0.05 : 0);
  const reason = `Checked ${plural(n, `${category ?? ""} finding`.trim())} on ${plural(pages, "page")}: specific descriptions, evidence, actionable recommendations, matching category and crawled pages${
    minor.length ? ` (minor: ${minor.join(", ")})` : ""
  }.`;
  return verdict(true, reason, Math.max(0.7, Math.min(0.95, confidence)));
}

/** Deterministic heuristic judge. No network. */
export function mockJudge(j: JudgeInput): LayerResult {
  return j.capability === "crawl" ? judgeCrawl(j) : judgeAudit(j);
}

// ---------- live judge ----------

const JUDGE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    pass: { type: "boolean" },
    reason: { type: "string" },
    confidence: { type: "number" },
  },
  required: ["pass", "reason", "confidence"],
  additionalProperties: false,
};

interface JudgeVerdict {
  pass: boolean;
  reason: string;
  confidence: number;
}

function compactIssue(v: unknown, fieldMax: number): Record<string, string> {
  const i = toIssue(v);
  const r = isRecord(v) ? v : {};
  return {
    category: clip(i.category, 20),
    severity: clip(str(r.severity), 10),
    rule: clip(i.rule, 40),
    pageUrl: clip(i.pageUrl, 160),
    ...(i.selector ? { selector: clip(i.selector, 100) } : {}),
    description: clip(i.description, fieldMax),
    recommendation: clip(i.recommendation, fieldMax),
    evidence: clip(i.evidence, fieldMax),
  };
}

/** Truncated JSON of the agent output that fits the prompt budget. */
export function compactOutput(output: unknown): { json: string; note: string } {
  if (isRecord(output) && Array.isArray(output.issues)) {
    const total = output.issues.length;
    let shown = Math.min(total, MAX_ISSUES_SENT);
    let fieldMax = 220;
    for (;;) {
      const body = {
        issues: output.issues.slice(0, shown).map((i) => compactIssue(i, fieldMax)),
        pagesChecked: Array.isArray(output.pagesChecked) ? output.pagesChecked.slice(0, 10).map((p) => clip(String(p), 160)) : output.pagesChecked,
        ...(output.summary !== undefined ? { summary: clip(String(output.summary), 300) } : {}),
      };
      const json = JSON.stringify(body);
      if (json.length <= OUTPUT_CHAR_BUDGET || shown <= 1) {
        const note = shown < total ? `showing ${shown} of ${total} issues` : `${total} issues`;
        return { json: clip(json, OUTPUT_CHAR_BUDGET), note };
      }
      if (fieldMax > 120) fieldMax -= 50;
      else shown -= 1;
    }
  }
  if (isRecord(output) && Array.isArray(output.pages)) {
    const total = output.pages.length;
    const pages = output.pages.slice(0, MAX_ISSUES_SENT).map((p) => {
      const r = isRecord(p) ? p : {};
      return { url: clip(str(r.url), 160), title: clip(str(r.title), 80), status: r.status };
    });
    const note = total > pages.length ? `showing ${pages.length} of ${total} pages` : `${total} pages`;
    return { json: clip(JSON.stringify({ pages }), OUTPUT_CHAR_BUDGET), note };
  }
  let json: string;
  try {
    json = JSON.stringify(output) ?? "undefined";
  } catch {
    json = String(output);
  }
  return { json: clip(json, OUTPUT_CHAR_BUDGET), note: "unrecognized output shape" };
}

function buildJudgePrompt(j: JudgeInput): string {
  const { json, note } = compactOutput(j.output);
  const input = { ...j.input } as Record<string, unknown>;
  if (Array.isArray(input.pages)) input.pages = (input.pages as string[]).slice(0, 25);
  const layers = j.priorLayers
    .map((l) => `- Layer ${l.layer} ${l.name}: ${l.skipped ? "skipped" : l.pass ? "pass" : "FAIL"}: ${clip(l.reason, 200)}`)
    .join("\n");
  return [
    `Node: ${j.label} (template "${j.templateId}"), capability: ${j.capability}${j.category ? `, required issue category: ${j.category}` : ""}`,
    `Node input: ${clip(JSON.stringify(input), 1500)}`,
    `Crawled pages (${j.crawledPages.length}): ${clip(j.crawledPages.slice(0, 25).join(", "), 1500) || "none yet"}`,
    `Earlier verification layers:\n${layers || "- none"}`,
    `Agent output (${note}, long fields clipped):\n${json}`,
  ].join("\n\n");
}

function parseVerdict(data: unknown): JudgeVerdict | null {
  if (!isRecord(data) || typeof data.pass !== "boolean" || typeof data.reason !== "string") return null;
  const reason = data.reason.trim();
  if (!reason) return null;
  const raw = typeof data.confidence === "number" && Number.isFinite(data.confidence) ? data.confidence : 0.5;
  return { pass: data.pass, reason: clip(reason, 400), confidence: Math.min(1, Math.max(0, raw)) };
}

function fallback(j: JudgeInput, why: string): LayerResult {
  const m = mockJudge(j);
  return { ...m, source: "budget_fallback", reason: `Live judge unavailable (${why}); heuristic judge: ${m.reason}` };
}

/** One guarded LLM call with the fixed rubric. Never throws. */
export async function liveJudge(j: JudgeInput, budget?: RunLlmBudget): Promise<LayerResult> {
  try {
    const res = await callLlmJson<JudgeVerdict>({
      purpose: "judge",
      system: JUDGE_RUBRIC,
      user: buildJudgePrompt(j),
      schemaName: "judge_verdict",
      schema: JUDGE_SCHEMA,
      runBudget: budget,
      validate: (d) => parseVerdict(d) !== null,
    });
    const v = parseVerdict(res.data);
    if (!v) return fallback(j, "unreadable model response");
    return {
      layer: 4,
      name: NAME,
      pass: v.pass,
      reason: v.reason,
      confidence: Math.round(v.confidence * 100) / 100,
      source: res.cached ? "cache" : "llm",
      ...(res.usage ? { details: { usage: res.usage } } : {}),
    };
  } catch (err) {
    return fallback(j, err instanceof LlmUnavailableError ? describeUnavailable(err) : "unexpected error");
  }
}
