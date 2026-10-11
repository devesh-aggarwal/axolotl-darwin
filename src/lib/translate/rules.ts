// Matching a real agent's finding to one of Axolotl's checks (src/lib/audit/rules.ts).
// Real agents name things their own way: axe-core and Lighthouse ids, ad-hoc codes, or plain sentences.
import { getRule, type RuleDef } from "@/lib/audit/rules";
import type { AuditCategory, Severity } from "@/lib/types";

/** Other tools' ids for the same check (axe-core and Lighthouse share most of ours already). */
const ALIASES: Record<string, string> = {
  "render-blocking-resources": "render-blocking-script",
  "render-blocking": "render-blocking-script",
  "uses-optimized-images": "oversized-image",
  "modern-image-formats": "oversized-image",
  "uses-responsive-images": "oversized-image",
  "efficient-animated-content": "oversized-image",
  "large-image": "oversized-image",
  "unsized-images": "unsized-image",
  "image-dimensions": "unsized-image",
  "select-name": "label",
  "label-title-only": "label",
  "missing-label": "label",
  "missing-alt": "image-alt",
  "alt-text": "image-alt",
  "html-lang": "html-has-lang",
  "missing-lang": "html-has-lang",
  title: "document-title",
  "title-tag": "document-title",
  "missing-title": "document-title",
  "missing-meta-description": "meta-description",
  "h1-multiple": "multiple-h1",
  "duplicate-h1": "multiple-h1",
  robots: "robots-txt",
  "missing-robots-txt": "robots-txt",
  "missing-sitemap": "sitemap",
  "sitemap-xml": "sitemap",
  "csp-xss": "missing-csp",
  csp: "missing-csp",
  "content-security-policy": "missing-csp",
  hsts: "missing-hsts",
  "strict-transport-security": "missing-hsts",
  "x-frame-options": "missing-x-frame-options",
  clickjacking: "missing-x-frame-options",
  "x-content-type-options": "missing-x-content-type-options",
  "referrer-policy": "missing-referrer-policy",
  "insecure-form": "insecure-form-action",
  "form-action-http": "insecure-form-action",
  "broken-links": "broken-link",
  "dead-link": "broken-link",
  "dead-links": "broken-link",
};

/** Keyword patterns, most specific first within each category. */
const KEYWORDS: [string, RegExp][] = [
  ["button-name", /\bbuttons?\b[^.\n]{0,50}\b(name|label|text|accessible|discernible)|\b(empty|unlabell?ed|icon[- ]only|nameless)\s+buttons?\b/i],
  ["image-alt", /\balt\b|alternative text|alt[- ]text|non-text content|\b1\.1\.1\b/i],
  ["color-contrast", /contrast/i],
  ["label", /\blabels?\b|unlabell?ed|form (field|control|input)s?[^.\n]{0,30}\bname\b|\binputs?\b[^.\n]{0,40}accessible name/i],
  ["html-has-lang", /\blang\b|\blanguage\b[^.\n]{0,40}(attribute|declar|not set|not specified|missing)|\b3\.1\.1\b/i],
  ["oversized-image", /\b(large|oversized|heavy|huge|big|unoptimi[sz]ed|uncompressed)\s+(hero\s+|banner\s+)?(images?|photos?|jpe?g|png)\b|\b(images?|photos?|jpe?g|png)\b[^.\n]{0,50}(\d+(\.\d+)?\s?(kb|mb|kib|mib)\b|too (large|big|heavy)|oversized|compress|optimi[sz])|properly size|modern image format|byte weight|efficiently encode/i],
  ["unsized-image", /\b(width|height|dimensions?)\b[^.\n]{0,40}\b(missing|not set|absent|explicit|unsized)|\b(missing|no|without|lacks?)\b[^.\n]{0,30}\b(width|height|dimensions?)\b|unsized|layout shift|\bcls\b/i],
  ["render-blocking-script", /render[- ]blocking|(blocking|synchronous)\s+(scripts?|resources?|javascript|js)\b|parser[- ]blocking|\bwithout (defer|async)\b/i],
  ["meta-description", /meta[- ]?description|description meta/i],
  ["multiple-h1", /\b(multiple|more than one|several|two|duplicate|\d+)\s+<?h1>?\b|\bh1 (tags|elements|headings)\b/i],
  ["document-title", /<title>|\btitle (tag|element)\b|\bpage title\b|\b(missing|no|empty|without a?)\s+(<title>|title)\b/i],
  ["robots-txt", /robots\.txt|robots-txt/i],
  ["sitemap", /sitemap/i],
  ["insecure-form-action", /\bforms?\b[^.\n]{0,60}(http:\/\/|insecure|unencrypted|plain http|not https|over http\b)|insecure[- ]form/i],
  ["missing-csp", /content[- ]security[- ]policy|\bcsp\b/i],
  ["missing-x-frame-options", /x-frame-options|clickjack|frame-ancestors/i],
  ["missing-x-content-type-options", /x-content-type-options|nosniff|mime[- ]sniff/i],
  ["missing-referrer-policy", /referrer[- ]policy/i],
  ["missing-hsts", /strict-transport-security|\bhsts\b/i],
  ["broken-link", /\bbroken\b|dead links?|\b404\b|\bnot found\b|\b(4\d\d|5\d\d)\b|unreachable|does not resolve|\bdns\b|\blinks?\b[^.\n]{0,30}\b(fail|error|timed? ?out)/i],
];

function normalizeCode(code: string): string {
  return code.trim().toLowerCase().replace(/[\s_]+/g, "-").replace(/[^a-z0-9.-]/g, "");
}

/** The check a finding belongs to, limited to this step's category; null when none fits. */
export function matchRule(category: AuditCategory, code: string | undefined, text: string): RuleDef | null {
  if (code) {
    const c = normalizeCode(code);
    const def = getRule(c) ?? (Object.hasOwn(ALIASES, c) ? getRule(ALIASES[c]) : undefined);
    if (def && def.category === category) return def;
  }
  const haystack = `${code ?? ""} ${text}`;
  for (const [rule, re] of KEYWORDS) {
    const def = getRule(rule);
    if (def && def.category === category && re.test(haystack)) return def;
  }
  return null;
}

const SEVERITY_WORDS: [Severity, RegExp][] = [
  ["critical", /^(critical|blocker|severe|p0|urgent)$/i],
  ["high", /^(high|serious|major|error|p1|important)$/i],
  ["medium", /^(medium|moderate|warning|warn|p2|med)$/i],
  ["low", /^(low|minor|info|notice|suggestion|p3|trivial|informational)$/i],
];

export function normalizeSeverity(value: unknown): Severity | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Lighthouse-style 0..1 scores: lower is worse.
    if (value <= 1) return value < 0.25 ? "high" : value < 0.5 ? "medium" : "low";
    return undefined;
  }
  if (typeof value !== "string") return undefined;
  const v = value.trim();
  return SEVERITY_WORDS.find(([, re]) => re.test(v))?.[0];
}

/** Severity written inside a line of text: "[High]", "Severity: low", "🔴". */
export function severityInText(input: string): Severity | undefined {
  // Whitespace collapsed and length capped first: runs of spaces made the "\s*" pattern quadratic.
  const text = input.slice(0, 2_000).replace(/\s+/g, " ");
  const m = /\b(critical|blocker|high|serious|major|medium|moderate|low|minor)\b(?=\s*(\]|\)|:|severity|priority|impact|-|—|–|$))|(?:severity|priority|impact) ?[:=]? ?(critical|high|medium|moderate|low|minor|serious)/i.exec(text);
  const word = m?.[1] ?? m?.[3];
  if (word) return normalizeSeverity(word);
  if (/🔴|‼️/.test(text)) return "high";
  if (/🟠|🟡/.test(text)) return "medium";
  if (/🟢|ℹ️/.test(text)) return "low";
  return undefined;
}
