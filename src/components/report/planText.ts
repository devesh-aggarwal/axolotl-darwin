// Plain-language wording for the report: site and step names, issue text without rule codes, and
// the built-in fix plan's headline and summary. Pure functions, shared by the fix-plan step on the
// server and by the report, which shows older built-in plans with the same wording.
import { stepNameFromLabel } from "@/components/ui/names";
import { CATEGORY_LABEL } from "@/components/ui/tokens";
import { RULES } from "@/lib/audit/rules";
import { normalizeUrl, siteRootUrl } from "@/lib/audit/url";
import { SEVERITIES, type AuditCategory, type PrioritizedIssue, type Severity } from "@/lib/types";

const HEADER_RULES = new Set(["missing-csp", "missing-hsts", "missing-x-frame-options", "missing-x-content-type-options", "missing-referrer-policy"]);

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function listJoin(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** Cuts at a word boundary. */
function clipWords(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const at = cut.lastIndexOf(" ");
  return `${(at > max * 0.6 ? cut.slice(0, at) : cut).replace(/[\s,.;:]+$/, "")}…`;
}

/** "the demo site" for the bundled demo (or anything on a local host), otherwise the host name. */
export function siteName(siteUrl: string): string {
  try {
    const u = new URL(siteUrl);
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
    if (local || new URL(siteRootUrl(siteUrl)).pathname.endsWith("/demo-site/")) return "the demo site";
    return u.hostname.replace(/^www\./, "");
  } catch {
    return siteUrl;
  }
}

/** Same as siteName, capitalized for the start of a line. */
export function siteNameStart(siteUrl: string): string {
  const s = siteName(siteUrl);
  return s.startsWith("the ") ? `T${s.slice(1)}` : s;
}

/** Workflow step names in one format: "Accessibility (WCAG) · contact.html" → "Accessibility · contact". */
export function stepLabel(label: string): string {
  return stepNameFromLabel(label);
}

// Rule codes agents prefix to descriptions: "[meta-description]", "[WCAG 1.1.1]", "[SC 1.4.3]".
const CODE_RE = /(^|\s)\[((?:WCAG|SC)\s*[\d.]+|[a-z0-9]+(?:-[a-z0-9]+)+)\](?=[\s.,:;]|$)/g;

/** Issue text for display, without bracketed rule codes. */
export function cleanText(text: string): string {
  return text.replace(CODE_RE, "$1").replace(/\s{2,}/g, " ").trim();
}

/** The bracketed codes cleanText removes ("WCAG 1.1.1"), for the Details view. */
export function codesIn(text: string): string[] {
  return [...text.matchAll(CODE_RE)].map((m) => m[2]);
}

export function isSiteWide(issue: Pick<PrioritizedIssue, "rule">): boolean {
  return RULES[issue.rule]?.scope === "site";
}

/** "the home page", "the contact page". */
function pagePhrase(pageUrl: string, siteUrl: string): string {
  if (normalizeUrl(pageUrl) === normalizeUrl(siteRootUrl(siteUrl))) return "the home page";
  try {
    const last = new URL(pageUrl).pathname.split("/").filter(Boolean).pop() ?? "";
    const base = last.replace(/\.[a-z0-9]+$/i, "").replace(/[-_]+/g, " ").trim().toLowerCase();
    return !base || base === "index" ? "the home page" : `the ${base} page`;
  } catch {
    return "the page";
  }
}

/** "#team-photo" → "team photo", "#hero-img" → "hero image". */
function thingFromSelector(selector: string | undefined): string | null {
  const id = /#([A-Za-z][\w-]*)/.exec(selector ?? "")?.[1];
  if (!id) return null;
  return id
    .replace(/[-_]+/g, " ")
    .replace(/\bimg\b/gi, "image")
    .replace(/\bbtn\b/gi, "button")
    .replace(/\bpic\b/gi, "picture")
    .trim()
    .toLowerCase();
}

function imagePhrase(i: PrioritizedIssue, siteUrl: string): string {
  const thing = thingFromSelector(i.selector);
  if (thing) return `the ${thing}${/image|photo|picture|logo|icon|banner|cover/.test(thing) ? "" : " image"}`;
  return `the images on ${pagePhrase(i.pageUrl, siteUrl)}`;
}

/** What to do first, in plain words and lower case: "add alt text to the team photo". */
export function firstStep(i: PrioritizedIssue, siteUrl: string): string {
  const page = pagePhrase(i.pageUrl, siteUrl);
  const thing = thingFromSelector(i.selector);
  if (HEADER_RULES.has(i.rule)) return "add the missing security headers";
  switch (i.rule) {
    case "image-alt":
      return `add alt text to ${imagePhrase(i, siteUrl)}`;
    case "oversized-image":
      return `shrink ${imagePhrase(i, siteUrl)}`;
    case "unsized-image":
      return `set the size of ${imagePhrase(i, siteUrl)}`;
    case "color-contrast":
      return `make the faint text on ${page} easier to read`;
    case "label":
      return `label the ${thing ? `${thing} ` : ""}field on ${page}`;
    case "button-name":
      return `name the ${thing ? thing.replace(/\s*button$/, "") + " " : ""}button on ${page}`;
    case "html-has-lang":
      return `set the language of ${page}`;
    case "meta-description":
      return `add a search description to ${page}`;
    case "document-title":
      return `add a title to ${page}`;
    case "multiple-h1":
      return `keep one main heading on ${page}`;
    case "robots-txt":
      return "add a robots.txt file";
    case "sitemap":
      return "publish a sitemap";
    case "insecure-form-action":
      return page === "the home page" ? "send the home page form over HTTPS" : `send the ${page.replace(/^the /, "").replace(/ page$/, "")} form over HTTPS`;
    case "render-blocking-script":
      return `stop a script from slowing down ${page}`;
    case "broken-link":
      return `fix the broken link on ${page}`;
    default: {
      const text = clipWords(cleanText(RULES[i.rule]?.title ?? i.description), 60).replace(/\.$/, "");
      return `fix "${text.charAt(0).toLowerCase()}${text.slice(1)}"`;
    }
  }
}

/** One short phrase for a group of site-wide problems: "missing security headers". */
export function siteWidePhrase(issues: PrioritizedIssue[]): string {
  const sorted = [...issues].sort((a, b) => a.priority - b.priority);
  const top = sorted[0];
  if (!top) return "";
  if (sorted.some((i) => HEADER_RULES.has(i.rule))) return "missing security headers";
  if (top.rule === "sitemap") return "no sitemap";
  if (top.rule === "robots-txt") return "no robots.txt file";
  const title = RULES[top.rule]?.title ?? cleanText(top.description);
  return `${title.charAt(0).toLowerCase()}${title.slice(1)}`.replace(/\.$/, "");
}

function byPriority(issues: PrioritizedIssue[]): PrioritizedIssue[] {
  return [...issues].sort((a, b) => a.priority - b.priority);
}

/** "25 problems found. Start with: add alt text to the team photo." */
export function planHeadline(issues: PrioritizedIssue[], siteUrl: string, partialCount = 0): string {
  const sorted = byPriority(issues);
  if (!sorted.length) {
    return partialCount
      ? `No problems found, but ${plural(partialCount, "check")} didn't finish.`
      : `No problems found on ${siteName(siteUrl)}.`;
  }
  return `${plural(sorted.length, "problem")} found. Start with: ${firstStep(sorted[0], siteUrl)}.`;
}

/** The sentence about checks that ran out of backups. Empty when every check finished. */
export function partialSentence(partial: { label: string }[]): string {
  if (!partial.length) return "";
  const names = listJoin(partial.map((p) => stepLabel(p.label)));
  return `${names} didn't finish because every backup failed, so ${partial.length === 1 ? "its" : "their"} findings are missing.`;
}

export function planSummary(a: {
  issues: PrioritizedIssue[];
  dedupedFrom: number;
  siteUrl: string;
  fixCount: number;
  /** Pass [] when the partial checks are shown elsewhere on screen. */
  partial: { label: string }[];
}): string {
  const sorted = byPriority(a.issues);
  const partial = partialSentence(a.partial);
  if (!sorted.length) return [`Every check that finished on ${siteName(a.siteUrl)} came back clean.`, partial].filter(Boolean).join(" ");

  const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const i of sorted) if (i.severity in counts) counts[i.severity] += 1;
  const sevParts = SEVERITIES.filter((s) => counts[s] > 0).map((s) => `${counts[s]} ${s}`);
  const pages = new Set(sorted.map((i) => normalizeUrl(i.pageUrl))).size;
  const merged = a.dedupedFrom > sorted.length ? `, after merging ${a.dedupedFrom} separate reports` : "";

  const byCat = new Map<AuditCategory, number>();
  for (const i of sorted) byCat.set(i.category, (byCat.get(i.category) ?? 0) + 1);
  const cats = [...byCat.entries()]
    .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
    .slice(0, 3)
    .map(([c, n]) => `${CATEGORY_LABEL[c] ?? c} (${n})`);

  const fixes =
    a.fixCount === 0 ? "" : a.fixCount === 1 ? "The drafted fix below covers the most urgent one." : `The ${a.fixCount} drafted fixes below cover the most urgent ones.`;
  return [
    `Found ${plural(sorted.length, "problem")} (${sevParts.join(", ")}) across ${plural(pages, "page")}${merged}.`,
    cats.length ? `Most are ${listJoin(cats)}.` : "",
    fixes,
    partial,
  ]
    .filter(Boolean)
    .join(" ");
}
