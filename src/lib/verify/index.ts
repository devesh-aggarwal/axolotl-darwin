// Output verification, layers 1–4 (spec 7.3). A node passes only when every layer ran and passed.
// Each layer runs only after the earlier ones passed; nothing here throws.
import type { NodeTemplate } from "@/config/workflow";
import { CONTRACTS, type ContractId } from "@/lib/contracts";
import type { AgentNodeInput, AuditOutput, Capability, CrawlOutput, Issue, LayerResult, VerificationResult } from "@/lib/types";
import { fetchPage } from "@/lib/audit/fetcher";
import { expectedPages, isDemoSite, measureRecall, unmatchedIssues } from "@/lib/audit/groundTruth";
import { spotCheckIssues, type SpotCheckResult } from "@/lib/audit/spotcheck";
import { normalizeUrl, stripQueries } from "@/lib/audit/url";
import { sanitizeSecrets, type RunLlmBudget } from "@/lib/llm/gateway";
import { liveJudge, mockJudge, type JudgeInput } from "@/lib/llm/judge";
import { rngFor } from "@/lib/rng";
import {
  checkAuditRules,
  checkCrawlRules,
  clip,
  describeReport,
  expectedForNode,
  looseId,
  nodeCategory,
  nodeScope,
  pageId,
  shortUrl,
  type RuleContext,
  type RuleReport,
} from "@/lib/verify/rules";

export interface VerifyContext {
  template: NodeTemplate;
  input: AgentNodeInput;
  output: unknown;
  siteUrl: string;
  crawledPages: string[];
  seed: number;
  llmMode: "mock" | "live";
  llmBudget?: RunLlmBudget;
}

/** Claims re-checked per audit output. */
export const SPOT_CHECK_SAMPLE = 3;
/**
 * Crawled pages re-fetched per crawl output. Matches the engine's largest page cap, so every listed
 * page is checked: one invented page would otherwise fan out into audit nodes for a page that 404s.
 */
export const CRAWL_REFETCH_SAMPLE = 10;
/** Demo site: minimum share of planted issues an audit node must find. */
export const MIN_ISSUE_RECALL = 0.5;
/** Demo site: minimum share of ground-truth pages (up to the page cap) a crawl must list. */
export const MIN_PAGE_RECALL = 0.6;

const LAYER_NAMES = { 1: "Schema", 2: "Rules", 3: "Spot-check", 4: "LLM judge" } as const;
type LayerNo = keyof typeof LAYER_NAMES;

type Parsed = { kind: "crawl"; data: CrawlOutput } | { kind: "audit"; data: AuditOutput };
type Recall = NonNullable<VerificationResult["recall"]>;

/** State the layers hand to each other within one verification. */
interface Run {
  ctx: VerifyContext;
  layers: LayerResult[];
  parsed?: Parsed;
  recall?: Recall;
}

export async function verifyOutput(ctx: VerifyContext): Promise<VerificationResult> {
  const run: Run = { ctx, layers: [] };
  const steps: [LayerNo, (run: Run) => Promise<LayerResult> | LayerResult][] = [
    [1, schemaLayer],
    [2, rulesLayer],
    [3, spotCheckLayer],
    [4, judgeLayer],
  ];
  for (const [layer, step] of steps) {
    const earlierFailed = run.layers.some((l) => !l.pass);
    // Cleaned as each layer finishes, so the judge prompt never sees uncleaned earlier verdicts.
    run.layers.push(cleanLayer(earlierFailed ? skipped(layer) : await runLayer(layer, () => step(run))));
  }
  const layers = run.layers;
  const pass = layers.length === 4 && layers.every((l) => l.pass && !l.skipped);
  return { pass, layers, ...(run.recall ? { recall: run.recall } : {}) };
}

async function runLayer(layer: LayerNo, step: () => Promise<LayerResult> | LayerResult): Promise<LayerResult> {
  try {
    return await step();
  } catch (err) {
    return result(layer, false, `verifier error: ${clip(errorMessage(err), 200)}`);
  }
}

function skipped(layer: LayerNo): LayerResult {
  return { layer, name: LAYER_NAMES[layer], pass: false, skipped: true, reason: "Skipped: earlier layer failed" };
}

function result(layer: LayerNo, pass: boolean, reason: string, details?: unknown): LayerResult {
  return { layer, name: LAYER_NAMES[layer], pass, reason, ...(details === undefined ? {} : { details }) };
}

function errorMessage(err: unknown): string {
  try {
    return err instanceof Error ? err.message || err.name : String(err);
  } catch {
    return "unknown error";
  }
}

/** Reasons can quote agent output: drop query strings and anything key- or token-shaped. */
function cleanText(text: string): string {
  return sanitizeSecrets(stripQueries(text))
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/\b(?:gh[pousr]|xox[abpr])[-_][A-Za-z0-9_-]{8,}/g, "[redacted]");
}

/** Details quote the same notes and URLs as reasons (fetch errors, spot-check notes), so they are cleaned too. */
function cleanDetails(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return cleanText(value);
  if (depth > 6 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => cleanDetails(v, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cleanDetails(v, depth + 1)]));
}

function cleanLayer(layer: LayerResult): LayerResult {
  const cleaned: LayerResult = { ...layer, reason: cleanText(String(layer.reason ?? "")) };
  if (layer.details === undefined) return cleaned;
  try {
    cleaned.details = cleanDetails(layer.details);
  } catch {
    delete cleaned.details;
  }
  return cleaned;
}

function ruleContext(ctx: VerifyContext): RuleContext {
  return { template: ctx.template, input: ctx.input, siteUrl: ctx.siteUrl, crawledPages: ctx.crawledPages };
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// ---------- layer 1: schema ----------

function contractFor(template: NodeTemplate): ContractId | undefined {
  if (template.contract) return template.contract;
  if (template.kind !== "agent") return undefined;
  return template.capability === "crawl" ? "crawl" : "audit";
}

function schemaLayer(run: Run): LayerResult {
  const contract = contractFor(run.ctx.template);
  if (!contract) return result(1, false, `Node "${run.ctx.template.id}" has no output contract`);
  const parsed = contract === "crawl" ? CONTRACTS.crawl.safeParse(run.ctx.output) : CONTRACTS.audit.safeParse(run.ctx.output);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${formatPath(i.path)}: ${clip(i.message, 80)}`);
    const more = issues.length > 3 ? ` (+${issues.length - 3} more)` : "";
    const reason = `Output does not match the ${contract} contract: ${issues.slice(0, 3).join("; ")}${more}`;
    return result(1, false, reason, { contract, issues: issues.slice(0, 10) });
  }
  if (contract === "crawl") {
    const data = parsed.data as CrawlOutput;
    run.parsed = { kind: "crawl", data };
    return result(1, true, `Matches the crawl contract (${plural(data.pages.length, "page")})`);
  }
  const data = parsed.data as AuditOutput;
  run.parsed = { kind: "audit", data };
  return result(1, true, `Matches the audit contract (${plural(data.issues.length, "issue")}, ${plural(data.pagesChecked.length, "page")} checked)`);
}

function formatPath(path: readonly PropertyKey[]): string {
  return path.length === 0 ? "(root)" : path.map((p) => String(p)).join(".");
}

function requireParsed(run: Run): Parsed {
  if (!run.parsed) throw new Error("schema layer produced no parsed output");
  return run.parsed;
}

// ---------- layer 2: rules ----------

function rulesLayer(run: Run): LayerResult {
  const parsed = requireParsed(run);
  const rc = ruleContext(run.ctx);
  const report: RuleReport = parsed.kind === "crawl" ? checkCrawlRules(rc, parsed.data) : checkAuditRules(rc, parsed.data);
  return result(2, report.violations.length === 0, describeReport(report), {
    checks: report.checks,
    violations: report.violations.slice(0, 10),
  });
}

// ---------- layer 3: spot-check ----------

async function spotCheckLayer(run: Run): Promise<LayerResult> {
  const parsed = requireParsed(run);
  return parsed.kind === "crawl" ? spotCheckCrawl(run.ctx, parsed.data) : spotCheckAudit(run, parsed.data);
}

async function spotCheckAudit(run: Run, output: AuditOutput): Promise<LayerResult> {
  const { ctx } = run;
  const failures: string[] = [];
  const notes: string[] = [];
  const details: Record<string, unknown> = {};

  if (output.issues.length === 0) {
    notes.push("No issues reported, so there are no claims to re-check");
  } else {
    const spot = await spotCheckSample(ctx, output.issues);
    details.spotCheck = summarizeSpotCheck(spot, ctx.siteUrl);
    for (const s of spot.samples.filter((x) => x.verdict === "refuted")) {
      failures.push(`refuted ${describeClaim(s.issue, ctx.siteUrl)}: ${clip(s.note, 120)}`);
    }
    notes.push(spotCheckNote(spot));
  }

  if (isDemoSite(ctx.siteUrl)) {
    const recall = nodeRecall(ctx, output.issues);
    run.recall = { found: recall.found, expected: recall.expected, ratio: recall.ratio };
    details.recall = { ...run.recall, missing: recall.missing };
    const where = recallScopeLabel(ctx);
    // Pass-side wording avoids "expect…<number>": the mock judge reads that as a count of expected issues.
    if (recall.ratio < MIN_ISSUE_RECALL) {
      const missing = recall.missing.slice(0, 3).join(", ");
      failures.push(`recall ${recall.found}/${recall.expected} (${recall.ratio.toFixed(2)}) of planted issues on ${where} is below ${MIN_ISSUE_RECALL}; missing ${missing}`);
    } else if (recall.expected === 0) {
      notes.push(`ground truth lists no planted ${nodeCategory(ctx.template)} problems on ${where}`);
    } else {
      notes.push(`recall ${recall.found}/${recall.expected} of planted issues on ${where}`);
    }
  } else if (output.issues.length === 0) {
    notes.push("no ground truth for this site");
  }

  if (failures.length > 0) return result(3, false, failures.slice(0, 3).join("; "), details);
  return result(3, true, `${notes.join("; ")}.`, details);
}

/**
 * spotCheckIssues over a seeded sample. On the demo site, claims that match no ground-truth item
 * (the likeliest fabrications) fill the sample first; the rest is drawn from the matched claims.
 */
async function spotCheckSample(ctx: VerifyContext, issues: Issue[]): Promise<SpotCheckResult> {
  const opts = { sample: SPOT_CHECK_SAMPLE, seed: ctx.seed };
  if (!isDemoSite(ctx.siteUrl)) return spotCheckIssues(issues, opts);
  const aligned = alignPages(issues);
  const unmatched = new Set(unmatchedIssues(ctx.siteUrl, aligned));
  const suspicious = issues.filter((_, i) => unmatched.has(aligned[i]));
  const matched = issues.filter((_, i) => !unmatched.has(aligned[i]));
  const first = await spotCheckIssues(suspicious, opts);
  const rest = await spotCheckIssues(matched, { ...opts, sample: SPOT_CHECK_SAMPLE - first.checked });
  return {
    checked: first.checked + rest.checked,
    confirmed: first.confirmed + rest.confirmed,
    refuted: first.refuted + rest.refuted,
    unverifiable: first.unverifiable + rest.unverifiable,
    samples: [...first.samples, ...rest.samples],
  };
}

/** Issues with page URLs in page-id form, so ".../demo-site" matches the ground-truth home page. */
function alignPages(issues: Issue[]): Issue[] {
  return issues.map((issue) => ({ ...issue, pageUrl: pageId(issue.pageUrl) }));
}

function describeClaim(issue: Issue, siteUrl: string): string {
  return `${clip(issue.rule, 40)} on ${shortUrl(issue.pageUrl, siteUrl)}${issue.selector ? ` (${clip(issue.selector, 60)})` : ""}`;
}

function spotCheckNote(spot: SpotCheckResult): string {
  const parts = [`${spot.confirmed} confirmed`];
  if (spot.unverifiable > 0) parts.push(`${spot.unverifiable} not independently checkable`);
  return `Re-checked ${plural(spot.checked, "sampled claim")}: ${parts.join(", ")}`;
}

function summarizeSpotCheck(spot: SpotCheckResult, siteUrl: string): unknown {
  return {
    checked: spot.checked,
    confirmed: spot.confirmed,
    refuted: spot.refuted,
    unverifiable: spot.unverifiable,
    samples: spot.samples.map((s) => ({ claim: describeClaim(s.issue, siteUrl), verdict: s.verdict, note: clip(s.note, 160) })),
  };
}

/**
 * measureRecall for the node's category (and page, for fan-out nodes). Site-wide nodes are only
 * held to the pages they were given, so a capped crawl does not count as missed issues.
 */
function nodeRecall(ctx: VerifyContext, issues: Issue[]): Recall & { missing: string[] } {
  const rc = ruleContext(ctx);
  const scope = nodeScope(rc);
  const category = nodeCategory(ctx.template);
  const filter = { category, ...(scope.kind === "page" ? { pageUrl: scope.pageUrl } : {}) };
  const full = measureRecall(ctx.siteUrl, alignPages(issues), filter);
  if (scope.kind === "page") {
    return { found: full.found, expected: full.expected, ratio: full.ratio, missing: full.missing.map((gt) => gt.id) };
  }
  const inScope = new Set(expectedForNode(rc).map((gt) => gt.id));
  const missing = full.missing.filter((gt) => inScope.has(gt.id)).map((gt) => gt.id);
  const expected = inScope.size;
  const found = expected - missing.length;
  return { found, expected, ratio: expected === 0 ? 1 : found / expected, missing };
}

function recallScopeLabel(ctx: VerifyContext): string {
  const scope = nodeScope(ruleContext(ctx));
  return scope.kind === "page" ? shortUrl(scope.pageUrl, ctx.siteUrl) : plural(scope.pages.length, "page");
}

async function spotCheckCrawl(ctx: VerifyContext, output: CrawlOutput): Promise<LayerResult> {
  const urls = [...new Set(output.pages.map((p) => normalizeUrl(p.url)))];
  const demo = isDemoSite(ctx.siteUrl);
  const groundTruthPages = demo ? expectedPages(ctx.siteUrl).map(pageId) : [];
  // On the demo site a page outside ground truth is the likeliest invention, so it is re-fetched first.
  const unexpected = new Set(urls.filter((u) => demo && !groundTruthPages.includes(pageId(u))));
  const sample = samplePages(urls, ctx.seed, unexpected);
  const fetched = await Promise.all(sample.map(async (url) => ({ url, page: await fetchPage(url) })));
  const failures = fetched.filter((f) => f.page.status !== 200).map((f) => refetchFailure(f.url, f.page.status, f.page.error, ctx.siteUrl));
  const details: Record<string, unknown> = { refetched: fetched.map((f) => ({ url: f.url, status: f.page.status })) };
  const notes = [`Re-fetched ${sample.length} of ${plural(urls.length, "page")}: all HTTP 200`];
  const home = await missingHome(ctx, urls);
  if (home) failures.unshift(home);

  if (demo) {
    const recall = pageRecall(ctx, urls, groundTruthPages);
    details.pageRecall = recall;
    if (recall.ratio < MIN_PAGE_RECALL) {
      failures.push(`crawl found ${recall.found}/${recall.expected} ground-truth pages (${recall.ratio.toFixed(2)}), below ${MIN_PAGE_RECALL}`);
    } else {
      notes.push(`${recall.found}/${recall.expected} ground-truth pages found`);
    }
  }
  if (failures.length > 0) return result(3, false, failures.slice(0, 3).join("; "), details);
  return result(3, true, `${notes.join("; ")}.`, details);
}

/**
 * The crawl must list the home page: the site root, or the page the root redirects to
 * (`/` ⇒ `/en/`), which is where a crawl that follows redirects starts.
 */
async function missingHome(ctx: VerifyContext, urls: string[]): Promise<string | null> {
  const listed = new Set(urls.map(looseId));
  const root = pageId(ctx.siteUrl);
  if (listed.has(looseId(root))) return null;
  const landed = await fetchPage(root);
  const redirected = landed.status === 200 && looseId(landed.finalUrl) !== looseId(root);
  if (redirected && listed.has(looseId(landed.finalUrl))) return null;
  const via = redirected ? ` (nor ${shortUrl(landed.finalUrl, ctx.siteUrl)}, where it redirects)` : "";
  return `home page ${shortUrl(root, ctx.siteUrl)} is not listed${via}`;
}

function refetchFailure(url: string, status: number | null, error: string | undefined, siteUrl: string): string {
  const what = status === null ? `did not load (${clip(error ?? "no response", 60)})` : `returned HTTP ${status}`;
  return `${shortUrl(url, siteUrl)} ${what} on re-fetch`;
}

/** Priority pages first, then a seeded shuffle of the rest. */
function samplePages(urls: string[], seed: number, priority: Set<string>): string[] {
  const rest = urls.filter((u) => !priority.has(u));
  const rand = rngFor(seed, "verify-crawl", urls.length);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  return [...urls.filter((u) => priority.has(u)), ...rest].slice(0, CRAWL_REFETCH_SAMPLE);
}

/** Ground-truth pages found, out of as many as the page cap allows. */
function pageRecall(ctx: VerifyContext, urls: string[], groundTruthPages: string[]): { found: number; expected: number; ratio: number } {
  const cap = (ctx.input as unknown as Record<string, unknown>).maxPages;
  const expected = typeof cap === "number" && cap > 0 ? Math.min(cap, groundTruthPages.length) : groundTruthPages.length;
  const ids = new Set(urls.map(pageId));
  const found = Math.min(groundTruthPages.filter((p) => ids.has(p)).length, expected);
  return { found, expected, ratio: expected === 0 ? 1 : found / expected };
}

// ---------- layer 4: judge ----------

async function judgeLayer(run: Run): Promise<LayerResult> {
  const j = judgeInput(run);
  const verdict = run.ctx.llmMode === "live" ? await liveJudge(j, run.ctx.llmBudget) : mockJudge(j);
  return { ...verdict, layer: 4, name: verdict.name || LAYER_NAMES[4] };
}

function judgeInput(run: Run): JudgeInput {
  const { ctx } = run;
  const category = nodeCategory(ctx.template);
  const capability: Capability | undefined = ctx.template.capability ?? (contractFor(ctx.template) === "crawl" ? "crawl" : category);
  if (!capability) throw new Error(`node "${ctx.template.id}" has no capability`);
  return {
    templateId: ctx.template.id,
    label: ctx.template.label,
    capability,
    ...(category ? { category } : {}),
    input: ctx.input,
    output: ctx.output,
    priorLayers: run.layers.slice(0, 3),
    crawledPages: ctx.crawledPages,
  };
}
