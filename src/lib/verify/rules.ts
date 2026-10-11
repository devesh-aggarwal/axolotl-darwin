// Verification layer 2: deterministic rule checks on an output that already matched its zod
// contract. No network. Also holds the node-scope helpers layer 3 shares (pages, ground truth).
import type { NodeTemplate } from "@/config/workflow";
import type { AgentNodeInput, AuditCategory, AuditOutput, CrawlOutput, Issue } from "@/lib/types";
import { SEVERITIES } from "@/lib/types";
import { getRule } from "@/lib/audit/rules";
import { expectedIssues, isDemoSite, type ResolvedGroundTruthIssue } from "@/lib/audit/groundTruth";
import { siteRootUrl, stripQueries } from "@/lib/audit/url";

/** More duplicate findings (same rule, page, selector and evidence) than this fails layer 2. */
export const MAX_DUPLICATE_ISSUES = 2;

export interface RuleContext {
  template: NodeTemplate;
  input: AgentNodeInput;
  siteUrl: string;
  crawledPages: string[];
}

/** Counts every check and keeps a message for each one that failed. */
export class RuleReport {
  checks = 0;
  readonly violations: string[] = [];

  expect(ok: boolean, violation: () => string): boolean {
    this.checks += 1;
    if (!ok) this.violations.push(violation());
    return ok;
  }
}

// ---------- refusal / placeholder text ----------

const FIRST_PERSON_REFUSAL =
  /\b(?:i['’]?m sorry|i am sorry|i apologi[sz]e|my apologies|as an ai\b|as a(?:n ai)? language model|(?:i|we) (?:cannot|can['’]?t|could not|couldn['’]?t|was unable to|were unable to|am unable to|are unable to|am not able to|do not have access|don['’]?t have access|have no access)|i['’]?m (?:unable|not able) to|we['’]?re (?:unable|not able) to)/i;

/** Apologies and present-tense first-person refusals only: "we could not reach X" reports a check result. */
const CAPABILITY_REFUSAL =
  /\b(?:i['’]?m sorry|i am sorry|i apologi[sz]e|my apologies|as an ai\b|as a(?:n ai)? language model|(?:i|we) (?:cannot|can['’]?t|am unable to|are unable to|am not able to|are not able to|do not have access|don['’]?t have access|have no access)|i['’]?m (?:unable|not able) to|we['’]?re (?:unable|not able) to)/i;

/** "Sorry, …" or "Unable to access the website" opening a sentence. */
const SENTENCE_REFUSAL =
  /(?:^|[.!?:;]\s+|\n\s*)(?:sorry\b|unfortunately,? (?:i|we)\b|(?:unable to|cannot|can['’]?t|could not|couldn['’]?t|failed to) (?:access|reach|browse|load|fetch|open|visit|retrieve|crawl|connect to) (?:the |this |that |your |any |external |live )?(?:web ?sites?|sites?|web ?pages?|pages?|urls?|internet|domains?|content|resources?)\b)/i;

/** "can't access the site" anywhere; skipped when a third party is the subject ("users can't access the page"). */
const ACCESS_FAILURE =
  /\b(?:can['’]?t|cannot|could not|couldn['’]?t|unable to|not able to) (?:access|reach|browse|load|fetch|open|retrieve|crawl|visit|connect to) (?:the |this |that |your |any |external |live )?(?:web ?sites?|sites?|web ?pages?|pages?|urls?|internet|domains?|links?|content|resources?)\b/gi;
const THIRD_PARTY_SUBJECT =
  /\b(?:users?|visitors?|people|customers?|readers?|screen ?readers?|assistive|keyboard|search engines?|crawlers?|bots?|browsers?|google|they|someone|anyone)\b[^.!?]{0,40}$/i;

const PLACEHOLDERS: RegExp[] = [
  /\blorem ipsum\b/i,
  /\b(?:TODO|TBD|FIXME)\b/,
  /[<[]\s*insert\b/i,
  /\{\{\s*[\w.-]+\s*\}\}/,
  /\byour(?:domain|site|website)\.com\b/i,
];
/** example.com used as a host; email addresses such as placeholder="you@example.com" are page content. */
const EXAMPLE_DOMAIN = /(?<![@\w.-])(?:https?:\/\/)?(?:[\w-]+\.)*example\.(?:com|org|net)\b/i;
const PLACEHOLDER_EVIDENCE = /^(?:n\/?a|none|null|undefined|nil|unknown|not applicable|not available|tbd|-+|\.{3}|…|\?+)\.?$/i;

/** The refusal phrase in `text`, or null. Findings about what users cannot do are not refusals. */
export function findRefusal(text: string): string | null {
  const direct = FIRST_PERSON_REFUSAL.exec(text) ?? SENTENCE_REFUSAL.exec(text);
  if (direct) return direct[0].trim();
  for (const m of text.matchAll(ACCESS_FAILURE)) {
    const before = text.slice(Math.max(0, (m.index ?? 0) - 60), m.index);
    if (!THIRD_PARTY_SUBJECT.test(before)) return m[0].trim();
  }
  return null;
}

/** The placeholder token in `text` (lorem ipsum, TODO, example.com on another site, …), or null. */
export function findPlaceholder(text: string, siteUrl: string): string | null {
  for (const re of PLACEHOLDERS) {
    const m = re.exec(text);
    if (m) return m[0];
  }
  const example = EXAMPLE_DOMAIN.exec(text);
  return example && !isExampleSite(siteUrl) ? example[0] : null;
}

/**
 * The refusal test for text that reports findings (issue fields, page titles, the summary of a
 * non-empty report). Only apologies and first-person refusals count, because "Could not connect to
 * the domain …" or "Googlebot cannot access the page" is exactly what a links or SEO finding says.
 */
export function findFindingRefusal(text: string): string | null {
  const m = CAPABILITY_REFUSAL.exec(text);
  return m ? m[0].trim() : null;
}

/** Evidence that says nothing: "N/A", "none", "-", "…". */
export function isPlaceholderEvidence(evidence: string): boolean {
  return PLACEHOLDER_EVIDENCE.test(evidence.trim());
}

/** Quoted placeholder="…" values are the page's own hint text (e.g. "https://example.com"), not agent filler. */
function withoutPlaceholderAttributes(markup: string): string {
  return markup.replace(/\bplaceholder\s*=\s*(["'])[\s\S]*?\1/gi, "placeholder=$1$1");
}

function isExampleSite(siteUrl: string): boolean {
  try {
    return /(?:^|\.)example\.(?:com|org|net)$/i.test(new URL(siteUrl).hostname);
  } catch {
    return false;
  }
}

// ---------- node scope ----------

export type NodeScope = { kind: "page"; pageUrl: string } | { kind: "site"; pages: string[] };

function inputField(input: AgentNodeInput, key: string): unknown {
  return (input as unknown as Record<string, unknown>)[key];
}

/**
 * Comparison key for page URLs: normalized (no hash, query or trailing index.html) with an
 * extensionless last segment read as a directory, so ".../demo-site" and ".../demo-site/" match.
 */
export function pageId(url: string): string {
  return siteRootUrl(url);
}

function uniquePages(urls: string[]): string[] {
  return [...new Set(urls.map(pageId))];
}

/** The page a fan-out node audits, or the pages a site-wide node covers (as page ids). */
export function nodeScope(ctx: RuleContext): NodeScope {
  if (ctx.template.scope === "page") {
    const pageUrl = inputField(ctx.input, "pageUrl");
    return { kind: "page", pageUrl: typeof pageUrl === "string" && pageUrl.trim() ? pageId(pageUrl) : "" };
  }
  const raw = inputField(ctx.input, "pages");
  const pages = Array.isArray(raw) ? raw.filter((p): p is string => typeof p === "string") : [];
  const list = pages.length > 0 ? pages : ctx.crawledPages.length > 0 ? ctx.crawledPages : [ctx.siteUrl];
  return { kind: "site", pages: uniquePages(list) };
}

/** Pages an issue may point at: the crawl, or the node's own pages when no crawl is known. */
export function knownPages(ctx: RuleContext): Set<string> {
  if (ctx.crawledPages.length > 0) return new Set(uniquePages(ctx.crawledPages));
  const scope = nodeScope(ctx);
  return new Set(scope.kind === "page" ? [scope.pageUrl] : scope.pages);
}

export function nodeCategory(template: NodeTemplate): AuditCategory | undefined {
  if (template.category) return template.category;
  return template.capability && template.capability !== "crawl" ? template.capability : undefined;
}

/**
 * Non-optional ground-truth issues this node should find on the demo site: its category, on its
 * page (fan-out nodes) or on the pages it was given (site nodes). Empty for any other site.
 */
export function expectedForNode(ctx: RuleContext): ResolvedGroundTruthIssue[] {
  const category = nodeCategory(ctx.template);
  if (!category || !isDemoSite(ctx.siteUrl)) return [];
  const scope = nodeScope(ctx);
  if (scope.kind === "page") {
    return scope.pageUrl ? expectedIssues(ctx.siteUrl, { category, pageUrl: scope.pageUrl }).filter((gt) => !gt.optional) : [];
  }
  const pages = new Set(scope.pages);
  const root = pageId(ctx.siteUrl);
  return expectedIssues(ctx.siteUrl, { category }).filter((gt) => {
    const page = pageId(gt.pageUrl);
    return !gt.optional && (pages.has(page) || (getRule(gt.rule)?.scope === "site" && page === root));
  });
}

// ---------- display helpers ----------

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Page URL relative to the site root ("/" for home), for short reasons. */
export function shortUrl(url: string, siteUrl: string): string {
  const root = pageId(siteUrl);
  const n = pageId(url);
  return clip(n.startsWith(root) ? `/${n.slice(root.length)}` : stripQueries(n), 100);
}

function issueLabel(issue: Issue, i: number): string {
  return `issue ${i + 1} (${clip(String(issue.rule), 40)})`;
}

// ---------- same site ----------

function hostKey(url: string): { host: string; port: string } | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return { host: u.hostname.toLowerCase().replace(/^www\./, ""), port: u.port };
  } catch {
    return null;
  }
}

/** Same origin, allowing the http→https upgrade and a "www." prefix (sites commonly redirect to either). */
export function sameSite(a: string, b: string): boolean {
  const x = hostKey(a);
  const y = hostKey(b);
  return x !== null && y !== null && x.host === y.host && x.port === y.port;
}

/** Page id that also ignores "www." and http vs https, for finding the home page. */
export function looseId(url: string): string {
  const key = hostKey(url);
  if (!key) return url;
  return `${key.host}:${key.port}${new URL(pageId(url)).pathname}`;
}

// ---------- audit outputs ----------

export function checkAuditRules(ctx: RuleContext, output: AuditOutput): RuleReport {
  const report = new RuleReport();
  const category = nodeCategory(ctx.template);
  report.expect(category !== undefined, () => `node "${ctx.template.id}" has no audit category`);
  const scope = nodeScope(ctx);
  if (scope.kind === "page") report.expect(scope.pageUrl !== "", () => "page-scope node input has no pageUrl");

  output.issues.forEach((issue, i) => {
    checkIssueClassification(report, issue, i, category);
    checkIssueText(report, ctx, issue, i);
    checkIssuePage(report, ctx, scope, issue, i);
  });
  checkPagesChecked(report, ctx, scope, output);
  checkSummary(report, ctx, output);
  checkZeroIssues(report, ctx, output);
  checkDuplicates(report, ctx, output.issues);
  return report;
}

function checkIssueClassification(report: RuleReport, issue: Issue, i: number, category: AuditCategory | undefined): void {
  const label = issueLabel(issue, i);
  if (category) {
    report.expect(issue.category === category, () => `${label} has category "${clip(String(issue.category), 20)}", but this is the ${category} node`);
  }
  const def = getRule(issue.rule);
  report.expect(def !== undefined && (!category || def.category === category), () =>
    def ? `${label}: rule belongs to ${def.category}, not ${category}` : `${label}: "${clip(issue.rule, 40)}" is not a known ${category ?? "audit"} rule`,
  );
  report.expect(SEVERITIES.includes(issue.severity), () => `${label} has an invalid severity`);
}

function checkIssueText(report: RuleReport, ctx: RuleContext, issue: Issue, i: number): void {
  const label = issueLabel(issue, i);
  for (const field of ["description", "recommendation", "evidence"] as const) {
    report.expect(issue[field].trim() !== "", () => `${label} has an empty ${field}`);
  }
  if (issue.selector !== undefined) report.expect(issue.selector.trim() !== "", () => `${label} has a blank selector`);
  if (issue.evidence.trim() !== "") {
    report.expect(!isPlaceholderEvidence(issue.evidence), () => `${label} evidence is a placeholder ("${clip(issue.evidence.trim(), 20)}")`);
  }
  const text = [issue.description, issue.recommendation, issue.evidence, issue.selector ?? ""].join("\n");
  const refusal = findFindingRefusal(text);
  report.expect(refusal === null, () => `${label} contains refusal text ("${clip(refusal ?? "", 40)}")`);
  const placeholder = findPlaceholder(withoutPlaceholderAttributes(text), ctx.siteUrl);
  report.expect(placeholder === null, () => `${label} contains placeholder text ("${clip(placeholder ?? "", 30)}")`);
}

function checkIssuePage(report: RuleReport, ctx: RuleContext, scope: NodeScope, issue: Issue, i: number): void {
  const label = issueLabel(issue, i);
  const page = pageId(issue.pageUrl);
  const siteRule = getRule(issue.rule)?.scope === "site";
  const known = knownPages(ctx).has(page) || (siteRule && page === pageId(ctx.siteUrl));
  if (!report.expect(known, () => `${label} is on a page that was never crawled: ${shortUrl(page, ctx.siteUrl)}`)) return;
  if (scope.kind === "page" && scope.pageUrl) {
    report.expect(page === scope.pageUrl, () => `${label} is on ${shortUrl(page, ctx.siteUrl)}, not this node's page ${shortUrl(scope.pageUrl, ctx.siteUrl)}`);
  }
}

function checkPagesChecked(report: RuleReport, ctx: RuleContext, scope: NodeScope, output: AuditOutput): void {
  const checked = output.pagesChecked.map(pageId);
  if (scope.kind === "page") {
    if (scope.pageUrl) {
      report.expect(checked.includes(scope.pageUrl), () => `pagesChecked does not include this node's page ${shortUrl(scope.pageUrl, ctx.siteUrl)}`);
    }
  } else {
    report.expect(checked.length > 0, () => "pagesChecked is empty: the report says no page was audited");
  }
  const offSite = checked.find((p) => !sameSite(p, ctx.siteUrl));
  report.expect(offSite === undefined, () => `pagesChecked lists an off-site page: ${clip(stripQueries(offSite ?? ""), 100)}`);
}

function checkSummary(report: RuleReport, ctx: RuleContext, output: AuditOutput): void {
  const summary = output.summary ?? "";
  // With findings, "could not reach https://…" in the summary describes them; with none, it is the refusal.
  const refusal = output.issues.length === 0 ? findRefusal(summary) : findFindingRefusal(summary);
  report.expect(refusal === null, () =>
    output.issues.length === 0
      ? `zero issues reported and the summary is a refusal ("${clip(refusal ?? "", 40)}")`
      : `summary contains refusal text ("${clip(refusal ?? "", 40)}")`,
  );
  const placeholder = findPlaceholder(summary, ctx.siteUrl);
  report.expect(placeholder === null, () => `summary contains placeholder text ("${clip(placeholder ?? "", 30)}")`);
}

function checkZeroIssues(report: RuleReport, ctx: RuleContext, output: AuditOutput): void {
  if (output.issues.length > 0) return;
  const expected = expectedForNode(ctx);
  const scope = nodeScope(ctx);
  const where = scope.kind === "page" ? shortUrl(scope.pageUrl, ctx.siteUrl) : `${scope.pages.length} page${scope.pages.length === 1 ? "" : "s"}`;
  report.expect(expected.length === 0, () => {
    const ids = expected.slice(0, 3).map((gt) => gt.id).join(", ");
    return `zero issues reported, but ground truth has ${expected.length} planted ${nodeCategory(ctx.template)} issue${expected.length === 1 ? "" : "s"} on ${where} (${ids})`;
  });
}

function checkDuplicates(report: RuleReport, ctx: RuleContext, issues: Issue[]): void {
  const seen = new Set<string>();
  let duplicates = 0;
  let example: Issue | undefined;
  for (const issue of issues) {
    // Evidence is part of the key: findings without a selector (or with a generic one like "img")
    // are told apart by what they quote, e.g. four different broken links on one page.
    const evidence = issue.evidence.replace(/\s+/g, " ").trim().toLowerCase();
    const key = [issue.rule, pageId(issue.pageUrl), (issue.selector ?? "").trim(), evidence].join("|");
    if (seen.has(key)) {
      duplicates += 1;
      example ??= issue;
    }
    seen.add(key);
  }
  report.expect(duplicates <= MAX_DUPLICATE_ISSUES, () => {
    const at = example ? ` (e.g. ${clip(example.rule, 40)} on ${shortUrl(example.pageUrl, ctx.siteUrl)}${example.selector ? ` ${clip(example.selector, 40)}` : ""})` : "";
    return `${duplicates} duplicate issues with the same rule, page, selector and evidence${at}`;
  });
}

// ---------- crawl outputs ----------

export function checkCrawlRules(ctx: RuleContext, output: CrawlOutput): RuleReport {
  const report = new RuleReport();
  const pages = output.pages;
  report.expect(pages.length > 0, () => "crawl returned no pages");
  const seen = new Map<string, number>();
  pages.forEach((page, i) => {
    const label = `page ${i + 1} (${shortUrl(page.url, ctx.siteUrl)})`;
    report.expect(sameSite(page.url, ctx.siteUrl), () => `${label} is not on the site being audited`);
    report.expect(page.status === 200, () => `${label} has status ${page.status}, not 200`);
    const key = pageId(page.url);
    const first = seen.get(key);
    report.expect(first === undefined, () => `${label} duplicates page ${(first ?? 0) + 1}`);
    if (first === undefined) seen.set(key, i);
    // Titles are page content ("Can't access your account?"), so only agent refusals count.
    const refusal = findFindingRefusal(page.title);
    report.expect(refusal === null, () => `${label} title contains refusal text ("${clip(refusal ?? "", 40)}")`);
    const placeholder = findPlaceholder(page.title, ctx.siteUrl);
    report.expect(placeholder === null, () => `${label} title contains placeholder text ("${clip(placeholder ?? "", 30)}")`);
  });
  // The home page check needs the site root's redirect target, so it runs in layer 3.
  const cap = inputField(ctx.input, "maxPages");
  if (typeof cap === "number" && cap > 0) {
    report.expect(pages.length <= cap, () => `${pages.length} pages exceed the requested cap of ${cap}`);
  }
  return report;
}

/** "N checks passed" or the first three violations. */
export function describeReport(report: RuleReport): string {
  if (report.violations.length === 0) return `${report.checks} checks passed`;
  const shown = report.violations.slice(0, 3).map((v) => clip(v, 200));
  const more = report.violations.length - shown.length;
  return `${shown.join("; ")}${more > 0 ? ` (+${more} more)` : ""}`;
}
