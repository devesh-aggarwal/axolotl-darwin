// Ground truth for the demo site: every planted issue, resolved against the URL it is served at.
import { z } from "zod";
import type { AuditCategory, Issue } from "@/lib/types";
import { AuditCategorySchema } from "@/lib/contracts";
import { hrefFromLinkSelector, normalizeUrl, resolveHttpUrl, siteRootUrl, urlsInText } from "@/lib/audit/url";
import rawGroundTruth from "../../../demo-site/ground-truth.json";

const GroundTruthIssueSchema = z.object({
  id: z.string(),
  category: AuditCategorySchema,
  rule: z.string(),
  /** Relative to the site root; "" is the home page. */
  page: z.string(),
  selector: z.string().optional(),
  /** broken-link only: the href as written on the page. */
  target: z.string().optional(),
  description: z.string(),
  optional: z.boolean().optional(),
});

const GroundTruthSchema = z.object({
  site: z.string(),
  notes: z.string().optional(),
  pages: z.array(z.string()),
  issues: z.array(GroundTruthIssueSchema),
});

export type GroundTruthIssue = z.infer<typeof GroundTruthIssueSchema>;
export type GroundTruth = z.infer<typeof GroundTruthSchema>;

export interface ResolvedGroundTruthIssue extends GroundTruthIssue {
  /** Absolute, normalized page URL. */
  pageUrl: string;
  /** broken-link only: absolute, normalized link target. */
  targetUrl?: string;
}

export interface GroundTruthFilter {
  category?: AuditCategory;
  pageUrl?: string;
}

let cachedGroundTruth: GroundTruth | null = null;

export function loadGroundTruth(): GroundTruth {
  cachedGroundTruth ??= GroundTruthSchema.parse(rawGroundTruth);
  return cachedGroundTruth;
}

/** The local demo site (path ends in /demo-site/) or whatever DEMO_SITE_URL points at. */
export function isDemoSite(siteUrl: string): boolean {
  const root = siteRootUrl(siteUrl);
  if (!resolveHttpUrl(root)) return false;
  if (new URL(root).pathname.endsWith("/demo-site/")) return true;
  const configured = process.env.DEMO_SITE_URL;
  return Boolean(configured) && siteRootUrl(configured as string) === root;
}

/** Absolute URLs of the ground-truth pages, home first. */
export function expectedPages(siteUrl: string): string[] {
  const root = siteRootUrl(siteUrl);
  return loadGroundTruth().pages.map((p) => normalizeUrl(p, root));
}

export function expectedIssues(siteUrl: string, filter?: GroundTruthFilter): ResolvedGroundTruthIssue[] {
  if (!isDemoSite(siteUrl)) return [];
  const root = siteRootUrl(siteUrl);
  const pageFilter = filter?.pageUrl ? normalizeUrl(filter.pageUrl) : null;
  return loadGroundTruth()
    .issues.map((gt) => resolveIssue(gt, root))
    .filter((gt) => (!filter?.category || gt.category === filter.category) && (!pageFilter || gt.pageUrl === pageFilter));
}

function resolveIssue(gt: GroundTruthIssue, root: string): ResolvedGroundTruthIssue {
  const pageUrl = normalizeUrl(gt.page, root);
  const resolved: ResolvedGroundTruthIssue = { ...gt, pageUrl };
  if (gt.target !== undefined) resolved.targetUrl = normalizeUrl(gt.target, pageUrl);
  return resolved;
}

/** Same rule, same page, and the same element (loosely) or, for broken links, the same target. */
export function matchesGroundTruth(gt: ResolvedGroundTruthIssue, issue: Issue): boolean {
  if (issue.rule !== gt.rule) return false;
  if (normalizeUrl(issue.pageUrl) !== gt.pageUrl) return false;
  if (gt.rule === "broken-link" && gt.targetUrl) return linkTargets(issue).includes(gt.targetUrl);
  if (gt.selector && issue.selector) return selectorsOverlap(gt.selector, issue.selector);
  return true;
}

export function measureRecall(
  siteUrl: string,
  issues: Issue[],
  filter?: GroundTruthFilter,
): { found: number; expected: number; ratio: number; missing: ResolvedGroundTruthIssue[] } {
  const expected = expectedIssues(siteUrl, filter).filter((gt) => !gt.optional);
  const missing = expected.filter((gt) => !issues.some((issue) => matchesGroundTruth(gt, issue)));
  const found = expected.length - missing.length;
  return { found, expected: expected.length, ratio: expected.length === 0 ? 1 : found / expected.length, missing };
}

/** Issues that match no ground-truth item, optional ones included (false positives on the demo site). */
export function unmatchedIssues(siteUrl: string, issues: Issue[]): Issue[] {
  const expected = expectedIssues(siteUrl);
  return issues.filter((issue) => !expected.some((gt) => matchesGroundTruth(gt, issue)));
}

function selectorsOverlap(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/'/g, "\"").replace(/\s+/g, " ").trim().toLowerCase();
  const x = norm(a);
  const y = norm(b);
  return x.includes(y) || y.includes(x);
}

/** Normalized link targets an issue refers to: the href in its selector, else the URLs in its text. */
function linkTargets(issue: Issue): string[] {
  const href = hrefFromLinkSelector(issue.selector);
  const resolved = href !== null ? resolveHttpUrl(href, issue.pageUrl) : null;
  if (resolved) return [normalizeUrl(resolved)];
  return urlsInText(`${issue.evidence} ${issue.description}`).map((url) => normalizeUrl(url));
}
