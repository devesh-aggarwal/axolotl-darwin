// Pulls candidate findings and pages out of a real agent's answer, whatever its shape:
// axe-core or Lighthouse JSON, ad-hoc JSON lists, Markdown bullets and tables, or prose.
// Nothing here decides which check a finding belongs to; that is rules.ts.
import { severityInText } from "@/lib/translate/rules";

export interface RawFinding {
  /** What the agent said, as one line. */
  text: string;
  /** The agent's own rule id or name, when it gave one. */
  code?: string;
  /** Page the agent attributed the finding to (URL or path, as written). */
  page?: string;
  /** Page named by the heading the finding sits under. */
  pageContext?: string;
  /** URLs and paths mentioned in the finding itself. */
  mentions: string[];
  severity?: unknown;
  selector?: string;
  evidence?: string;
  fix?: string;
  /** Broken-link target, when the agent named it separately. */
  link?: string;
  status?: number;
}

export interface RawPage {
  url: string;
  title?: string;
  status?: number;
}

type Rec = Record<string, unknown>;

const MAX_FINDINGS = 300;
/** Longest piece of text any pattern here runs on; longer lines and fields are cut first. */
export const MAX_FIELD = 2_000;
const MAX_DEPTH = 6;

const isRec = (v: unknown): v is Rec => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const num = (v: unknown): number | undefined => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
};

function pick(rec: Rec, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = str(rec[k]);
    if (v) return v;
  }
  return undefined;
}

// ---------- shared text helpers ----------

/** Trailing punctuation off a URL, without a regex (a long run of dots made the regex quadratic). */
function trimTrailing(u: string): string {
  let end = u.length;
  while (end > 0 && ".,;:!?*_".includes(u[end - 1])) end--;
  return u.slice(0, end);
}

/** URLs plus relative page paths ("/about", "contact.html") mentioned in a piece of text. */
export function mentionsIn(input: string): string[] {
  const text = input.slice(0, MAX_FIELD);
  const urls = text.match(/https?:\/\/[^\s"'<>()\]|`]+/g)?.map(trimTrailing) ?? [];
  const rest = text.replace(/https?:\/\/[^\s"'<>()\]|`]+/g, " ");
  const paths = rest.match(/(?:^|[\s(`"'[])(\/?[\w.-]+(?:\/[\w.-]+)*\.html?|\/[\w-]+(?:\/[\w-]+)*\/?)(?=[\s)`"'\],.;:!?]|$)/g) ?? [];
  return [...urls, ...paths.map((p) => p.trim().replace(/^[(`"'[]/, ""))].filter((m) => m.length > 1 && m.length < 300);
}

/** "Missing", "broken", "404"… — what separates a finding from a passing check or chatter. */
const ISSUE_SIGNAL =
  /\b(missing|no|not|lacks?|lacking|without|absent|empty|too|low|insufficient|fails?|failed|failing|broken|dead|errors?|invalid|oversized|large|heavy|exceeds?|multiple|duplicate|blocking|insecure|unencrypted|should|needs?|issues?|problems?|violations?|warnings?|unlabell?ed|unsized|4\d\d|5\d\d)\b|❌|✗|✘|⚠/i;

/** Lines that report a pass, or that nothing was found. */
const NOTHING_FOUND =
  /^(✅|✓|✔|pass(ed)?\b|ok\b|good\b)|\bno (issues|problems|errors|violations|findings)( were)? (found|detected|reported)\b|\bnothing (found|to report)\b|\ball (checks|tests) passed\b/i;

/**
 * Lines that say something is fine: "HSTS is set correctly", "CSP header present, no action needed",
 * "There are no broken links". These mention a check's keyword without reporting a problem.
 */
const SAYS_FINE =
  /\b(is|are) (set|present|configured|enabled|in place)\b|\b(header|policy|file|tag|attribute)s? (is |are )?(present|found|set)\b|\bcorrectly (set|configured)\b|\b(set|configured) correctly\b|\bno (action|changes?) (is |are )?needed\b|\bnothing (should|needs to) change\b|\blooks? (good|fine|correct)\b|\bthere (are|were|is) no\b|\bfound no\b|\bno [\w-]+( [\w-]+)? (were |was )?(found|detected)\b/i;

/** Text that reports a problem: it has an issue word and doesn't say the thing is fine. */
function reportsProblem(text: string): boolean {
  return ISSUE_SIGNAL.test(text) && !NOTHING_FOUND.test(text) && !SAYS_FINE.test(text);
}

function cleanLine(line: string): string {
  return line
    .slice(0, MAX_FIELD)
    .replace(/^\s*(?:[-*+•▪◦]|\d+[.)]|[a-z][.)])\s+/i, "")
    .replace(/\*\*|__|`/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------- JSON ----------

const TEXT_KEYS = ["description", "message", "title", "issue", "problem", "summary", "finding", "help", "name", "detail", "details", "text", "check"];
const CODE_KEYS = ["rule", "ruleId", "rule_id", "id", "code", "check", "audit", "auditId", "type"];
const PAGE_KEYS = ["pageUrl", "page_url", "page", "foundOn", "found_on", "sourcePage", "source_page", "source", "parent", "referrer", "file", "path", "location"];
const LINK_KEYS = ["link", "href", "brokenUrl", "broken_url", "targetUrl", "target_url", "linkUrl", "link_url"];
const SEVERITY_KEYS = ["severity", "impact", "priority", "level", "risk"];
const SELECTOR_KEYS = ["selector", "cssSelector", "css", "element"];
const EVIDENCE_KEYS = ["evidence", "html", "snippet", "actual", "value", "context", "failureSummary"];
const FIX_KEYS = ["recommendation", "fix", "suggestion", "remediation", "solution", "howToFix", "how_to_fix"];
const STATUS_KEYS = ["status", "statusCode", "status_code", "httpStatus", "http_status"];
/** Lists whose entries are problems by definition. */
const ISSUE_KEYS = ["issues", "findings", "problems", "violations", "errors", "warnings", "recommendations", "brokenLinks", "broken_links", "missingHeaders", "missing_headers", "missing"];
/** Lists that may hold passes as well as problems: each entry has to say it's a problem. */
const NEUTRAL_KEYS = ["results", "items", "checks", "audits", "report", "data", "output", "result"];
const CONTAINER_KEYS = [...ISSUE_KEYS, ...NEUTRAL_KEYS];

interface WalkContext {
  page?: string;
  label?: string;
  /** Inside a list the agent labelled as problems ("issues", "violations"…). */
  issueList?: boolean;
}
const PASSED = /^(pass|passed|ok|good|success|compliant|present|valid)$/i;

function isPassed(rec: Rec): boolean {
  if (rec.passed === true || rec.pass === true || rec.ok === true || rec.success === true) return true;
  const s = str(rec.result) ?? str(rec.outcome) ?? (typeof rec.status === "string" ? rec.status : undefined);
  return s !== undefined && PASSED.test(s);
}

function looksLikePage(key: string): boolean {
  return /^https?:\/\//i.test(key) || /^\/[\w./-]*$/.test(key) || /\.html?$/i.test(key);
}

function findingFromRecord(rec: Rec, context: WalkContext): RawFinding | null {
  if (isPassed(rec)) return null;
  const title = str(rec.title);
  const desc = pick(rec, TEXT_KEYS.filter((k) => k !== "title"));
  const text = cleanLine([title, desc && desc !== title ? desc : undefined].filter(Boolean).join(": ") || (context.label ?? ""));
  if (!text) return null;
  const severity = SEVERITY_KEYS.map((k) => rec[k]).find((v) => v !== undefined && v !== null && v !== "");
  // Outside a problems list, a record counts only if it reads as a problem or carries a severity:
  // {name: "Content-Security-Policy", value: "default-src 'self'"} is a header that's present.
  if (!context.issueList && severity === undefined && !reportsProblem(text)) return null;
  if (SAYS_FINE.test(text) || NOTHING_FOUND.test(text)) return null;
  const rawCode = pick(rec, CODE_KEYS);
  const code = rawCode && rawCode.length <= 60 && !/\s{2,}/.test(rawCode) ? rawCode : undefined;
  let page = pick(rec, PAGE_KEYS);
  let link = pick(rec, LINK_KEYS);
  const url = str(rec.url) ?? str(rec.uri);
  const status = STATUS_KEYS.map((k) => num(rec[k])).find((n) => n !== undefined && n >= 100 && n < 600);
  // A record with its own `url` and a failing status is a link report: the url is the broken target.
  if (url && !link && (status !== undefined && status >= 400) && page) link = url;
  else if (url && !page) page = url;
  if (!page) page = context.page;
  const target = rec.target ?? rec.selector;
  const selector = Array.isArray(target)
    ? target.flat(3).filter((t): t is string => typeof t === "string").join(" ")
    : pick(rec, SELECTOR_KEYS) ?? (typeof target === "string" ? target : undefined);
  const rawEvidence = pick(rec, EVIDENCE_KEYS);
  const evidence = rawEvidence ? cleanLine(rawEvidence) : undefined;
  return {
    text,
    code,
    page,
    mentions: mentionsIn([text, evidence ?? ""].join(" ")),
    severity,
    selector: selector?.trim() || undefined,
    evidence,
    fix: pick(rec, FIX_KEYS),
    link,
    status,
  };
}

function fromAxe(rec: Rec, page?: string): RawFinding[] {
  const url = str(rec.url) ?? page;
  const out: RawFinding[] = [];
  for (const v of Array.isArray(rec.violations) ? rec.violations : []) {
    if (!isRec(v)) continue;
    const base = { code: str(v.id), text: str(v.help) ?? str(v.description) ?? str(v.id) ?? "", severity: v.impact, page: url, mentions: [] as string[] };
    const nodes = Array.isArray(v.nodes) ? v.nodes.filter(isRec) : [];
    if (!nodes.length) out.push(base);
    for (const n of nodes) {
      const target = Array.isArray(n.target) ? n.target.flat(3).filter((t): t is string => typeof t === "string").join(" ") : str(n.target);
      out.push({ ...base, selector: target, evidence: str(n.html) ?? str(n.failureSummary), fix: str(n.failureSummary) });
    }
  }
  return out;
}

const LH_SKIP_MODES = new Set(["notApplicable", "manual", "informative", "error"]);

function fromLighthouse(rec: Rec): RawFinding[] {
  const lhr = isRec(rec.lhr) ? rec.lhr : rec;
  const audits = isRec(lhr.audits) ? lhr.audits : {};
  const page = str(lhr.finalDisplayedUrl) ?? str(lhr.finalUrl) ?? str(lhr.requestedUrl) ?? str(lhr.mainDocumentUrl);
  const out: RawFinding[] = [];
  for (const [id, a] of Object.entries(audits)) {
    if (!isRec(a)) continue;
    const score = num(a.score);
    if (score === undefined || score >= 0.9 || LH_SKIP_MODES.has(String(a.scoreDisplayMode))) continue;
    const text = [str(a.title), str(a.displayValue)].filter(Boolean).join(" — ") || id;
    const items = isRec(a.details) && Array.isArray(a.details.items) ? a.details.items.filter(isRec) : [];
    if (!items.length) {
      out.push({ text, code: id, page, mentions: [], severity: score });
      continue;
    }
    for (const it of items.slice(0, 50)) {
      const node = isRec(it.node) ? it.node : undefined;
      const url = str(it.url);
      const bytes = num(it.totalBytes) ?? num(it.wastedBytes);
      const evidence = [str(node?.snippet), url, bytes !== undefined ? `${Math.round(bytes / 1024)} KB` : undefined].filter(Boolean).join(" ");
      out.push({
        text,
        code: id,
        page,
        mentions: url ? [url] : [],
        severity: score,
        selector: str(node?.selector),
        evidence: evidence || undefined,
      });
    }
  }
  return out;
}

/** Findings in structured output. Returns [] when nothing finding-shaped is in it. */
export function findingsFromJson(value: unknown): RawFinding[] {
  const out: RawFinding[] = [];
  walk(value, {}, 0, out);
  return out.slice(0, MAX_FINDINGS);
}

function walk(value: unknown, ctx: WalkContext, depth: number, out: RawFinding[]): void {
  if (depth > MAX_DEPTH || out.length >= MAX_FINDINGS) return;
  if (typeof value === "string") {
    // A string inside a problems list is one finding ("Missing alt on hero image"); elsewhere it has to read as one.
    const text = cleanLine(value);
    const counts = ctx.issueList ? !NOTHING_FOUND.test(text) && !SAYS_FINE.test(text) : reportsProblem(text);
    if (text && counts) {
      const full = ctx.label ? `${ctx.label}: ${text}` : text;
      out.push({ text: full, page: ctx.page, mentions: mentionsIn(text) });
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) walk(v, ctx, depth + 1, out);
    return;
  }
  if (!isRec(value)) return;

  if (Array.isArray(value.violations) && value.violations.some((v) => isRec(v) && "nodes" in v)) {
    out.push(...fromAxe(value, ctx.page));
    return;
  }
  if (isRec(value.audits) || (isRec(value.lhr) && isRec(value.lhr.audits))) {
    out.push(...fromLighthouse(value));
    return;
  }

  const page = str(value.pageUrl) ?? str(value.page) ?? (CONTAINER_KEYS.some((k) => k in value) ? str(value.url) : undefined) ?? ctx.page;
  const containers = CONTAINER_KEYS.filter((k) => k in value);
  if (containers.length) {
    for (const k of containers) {
      walk(value[k], { page, label: /missing/i.test(k) ? "Missing" : ctx.label, issueList: ISSUE_KEYS.includes(k) || (ctx.issueList && NEUTRAL_KEYS.includes(k)) }, depth + 1, out);
    }
    return;
  }

  const finding = TEXT_KEYS.some((k) => typeof value[k] === "string") ? findingFromRecord(value, ctx) : null;
  if (finding) {
    out.push(finding);
    return;
  }

  // Keyed by page ({"/about": [...]}) or by check ({"content-security-policy": "missing"}).
  for (const [k, v] of Object.entries(value)) {
    if (looksLikePage(k) && (Array.isArray(v) || isRec(v))) {
      walk(v, { ...ctx, page: k }, depth + 1, out);
    } else if (v === null || v === false || (typeof v === "string" && /^(missing|absent|not set|none|no|not present|fail(ed)?)$/i.test(v.trim()))) {
      out.push({ text: `${k}: missing`, code: k, page, mentions: [] });
    } else if (Array.isArray(v) || isRec(v)) {
      walk(v, { ...ctx, page }, depth + 1, out);
    }
  }
}

// ---------- text ----------

interface TableState {
  /** Column names as written. */
  header: string[] | null;
}

function tableCells(line: string): string[] {
  return line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => cleanLine(c));
}

/** A short line that names a page and is a heading or label rather than a finding. */
function pageMarker(line: string): string | undefined {
  const t = line.trim();
  const heading = /^#{1,6}\s/.test(t) || /^(\*\*|__).+(\*\*|__):?$/.test(t) || (/:$/.test(t) && t.length < 100);
  const labelled = /^(page|url|on page|for page|file)\s*[:\-–—]/i.exec(t);
  if (!heading && !labelled) return undefined;
  if (heading && ISSUE_SIGNAL.test(t.replace(/https?:\/\/\S+/g, "")) && t.length > 60) return undefined;
  return mentionsIn(t)[0];
}

/** Findings in a text answer: bullets, numbered items, Markdown tables or sentences of prose. */
export function findingsFromText(text: string): { findings: RawFinding[]; candidates: number } {
  const findings: RawFinding[] = [];
  let candidates = 0;
  let pageContext: string | undefined;
  let inFence = false;
  const table: TableState = { header: null };

  const lines = text.split(/\r?\n/);
  for (const rawLine of lines) {
    if (findings.length >= MAX_FINDINGS) break;
    const line = rawLine.slice(0, MAX_FIELD).trim();
    if (/^```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || !line) {
      if (!line) table.header = null;
      continue;
    }

    const marker = pageMarker(line);
    if (marker) {
      pageContext = marker;
      continue;
    }

    if (/^\|/.test(line)) {
      if (/^\|?\s*:?-{3,}/.test(line)) continue;
      const cells = tableCells(line);
      if (!table.header) {
        table.header = cells;
        continue;
      }
      const col = (re: RegExp) => {
        const i = table.header!.findIndex((h) => re.test(h.toLowerCase()));
        return i >= 0 ? cells[i] : undefined;
      };
      // Column names carry meaning ("Broken link"), so rows read as "Page: x — Broken link: y".
      const rowText = cells.map((c, i) => (table.header![i] && c ? `${table.header![i]}: ${c}` : c)).filter(Boolean).join(" — ");
      if (NOTHING_FOUND.test(cells.join(" "))) continue;
      candidates++;
      const statusText = col(/status|code/);
      findings.push({
        text: col(/issue|problem|finding|description|message|check|error/) ?? rowText,
        code: col(/^rule|^id$/),
        page: col(/^(page|found on|source|url|location|file)/),
        pageContext,
        link: col(/link|href|target|broken/),
        status: statusText ? Number(/\d{3}/.exec(statusText)?.[0]) || undefined : undefined,
        severity: col(/severity|impact|priority/),
        fix: col(/fix|recommend|suggest/),
        mentions: mentionsIn(rowText),
      });
      continue;
    }
    table.header = null;

    const bulleted = /^(?:[-*+•▪◦]|\d+[.)])\s+/.test(line);
    const pieces = !bulleted && line.length > 220 ? line.split(/(?<=[.!?])\s+(?=[A-Z])/) : [line];
    for (const piece of pieces) {
      const t = cleanLine(piece);
      if (t.length < 8 || !reportsProblem(t)) continue;
      candidates++;
      findings.push({
        text: t,
        pageContext,
        mentions: mentionsIn(t),
        severity: severityInText(t),
        status: Number(/\b([45]\d\d)\b/.exec(t)?.[1]) || undefined,
      });
    }
  }
  return { findings, candidates };
}

// ---------- pages (crawl) ----------

const PAGE_URL_KEYS = ["url", "href", "loc", "link", "page", "path", "pageUrl", "page_url"];

/** Pages listed in structured output: URL strings, or records with a url and maybe a title and status. */
export function pagesFromJson(value: unknown, depth = 0, out: RawPage[] = []): RawPage[] {
  if (depth > MAX_DEPTH || out.length > 500) return out;
  if (typeof value === "string") {
    if (looksLikePage(value.trim())) out.push({ url: value.trim() });
  } else if (Array.isArray(value)) {
    for (const v of value) pagesFromJson(v, depth + 1, out);
  } else if (isRec(value)) {
    const url = pick(value, PAGE_URL_KEYS);
    if (url && looksLikePage(url)) {
      out.push({ url, title: str(value.title) ?? str(value.name), status: STATUS_KEYS.map((k) => num(value[k])).find((n) => n !== undefined) });
    }
    for (const [k, v] of Object.entries(value)) {
      if (PAGE_URL_KEYS.includes(k) && typeof v === "string") continue;
      if (looksLikePage(k) && !Array.isArray(v)) out.push({ url: k, title: isRec(v) ? str(v.title) : str(v) });
      else pagesFromJson(v, depth + 1, out);
    }
  }
  return out;
}

/** Pages listed in a text answer: URLs, Markdown links and relative page paths. */
export function pagesFromText(text: string): RawPage[] {
  const out: RawPage[] = [];
  // Bounded, line-local patterns: an unclosed "[" repeated many times must not go quadratic.
  const LINK = /\[([^\]\n]{0,200})\]\(([^)\s]{1,500})\)/g;
  for (const rawLine of text.split(/\r?\n/)) {
    if (out.length > 500) break;
    const line = rawLine.slice(0, MAX_FIELD);
    for (const m of line.matchAll(LINK)) out.push({ url: m[2], title: m[1].trim() || undefined });
    const status = Number(/\b([1-5]\d\d)\b/.exec(line.replace(/https?:\/\/\S+/g, ""))?.[1]) || undefined;
    for (const url of mentionsIn(line.replace(LINK, " "))) out.push({ url, status });
  }
  return out;
}
