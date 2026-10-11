// Stable rule codes for every finding in the shared audit format.
import type { AuditCategory, Issue, Severity } from "@/lib/types";

export interface RuleDef {
  rule: string;
  category: AuditCategory;
  severity: Severity;
  title: string;
  recommendation: string;
  effort: "small" | "medium" | "large";
  scope: "page" | "site";
}

/** Images above this many bytes are reported as oversized (500 KB). */
export const OVERSIZED_IMAGE_BYTES = 500 * 1024;
/** WCAG 2.2 AA minimum contrast for normal text. */
export const MIN_CONTRAST_RATIO = 4.5;

const DEFS: RuleDef[] = [
  {
    rule: "image-alt",
    category: "accessibility",
    severity: "high",
    title: "Image has no alt text",
    recommendation: "Add an alt attribute that describes the image, or alt=\"\" if it is purely decorative.",
    effort: "small",
    scope: "page",
  },
  {
    rule: "color-contrast",
    category: "accessibility",
    severity: "medium",
    title: "Text contrast is too low",
    recommendation: "Darken the text or lighten the background until the contrast ratio is at least 4.5:1.",
    effort: "small",
    scope: "page",
  },
  {
    rule: "label",
    category: "accessibility",
    severity: "high",
    title: "Form field has no label",
    recommendation: "Associate a visible <label for=\"…\"> with the field, or give it an aria-label. Placeholders are not labels.",
    effort: "small",
    scope: "page",
  },
  {
    rule: "button-name",
    category: "accessibility",
    severity: "high",
    title: "Button has no accessible name",
    recommendation: "Give the button visible text, or an aria-label describing its action (e.g. aria-label=\"Send message\").",
    effort: "small",
    scope: "page",
  },
  {
    rule: "html-has-lang",
    category: "accessibility",
    severity: "medium",
    title: "Page language is not declared",
    recommendation: "Add a lang attribute to the <html> element, e.g. <html lang=\"en\">.",
    effort: "small",
    scope: "page",
  },
  {
    rule: "oversized-image",
    category: "performance",
    severity: "high",
    title: "Image is oversized",
    recommendation: "Resize and compress the image (WebP/AVIF, responsive srcset) to keep it well under 500 KB.",
    effort: "medium",
    scope: "page",
  },
  {
    rule: "unsized-image",
    category: "performance",
    severity: "medium",
    title: "Image has no explicit dimensions",
    recommendation: "Set width and height attributes on the image so the browser reserves space and avoids layout shift.",
    effort: "small",
    scope: "page",
  },
  {
    rule: "render-blocking-script",
    category: "performance",
    severity: "medium",
    title: "Render-blocking script in <head>",
    recommendation: "Load the script with defer or async, or move it to the end of <body>.",
    effort: "small",
    scope: "page",
  },
  {
    rule: "meta-description",
    category: "seo",
    severity: "medium",
    title: "Missing meta description",
    recommendation: "Add a unique <meta name=\"description\"> of roughly 120–160 characters summarizing the page.",
    effort: "small",
    scope: "page",
  },
  {
    rule: "document-title",
    category: "seo",
    severity: "high",
    title: "Missing page title",
    recommendation: "Add a unique, descriptive <title> to the page's <head>.",
    effort: "small",
    scope: "page",
  },
  {
    rule: "multiple-h1",
    category: "seo",
    severity: "low",
    title: "More than one <h1>",
    recommendation: "Keep a single <h1> for the page's main heading and demote the others to <h2>.",
    effort: "small",
    scope: "page",
  },
  {
    rule: "robots-txt",
    category: "seo",
    severity: "low",
    title: "No robots.txt",
    recommendation: "Publish a robots.txt at the site root that allows crawling and points to the sitemap.",
    effort: "small",
    scope: "site",
  },
  {
    rule: "sitemap",
    category: "seo",
    severity: "low",
    title: "No sitemap.xml",
    recommendation: "Publish a sitemap.xml at the site root listing every public page, and reference it from robots.txt.",
    effort: "small",
    scope: "site",
  },
  {
    rule: "missing-csp",
    category: "security",
    severity: "high",
    title: "No Content-Security-Policy header",
    recommendation: "Send a Content-Security-Policy header that restricts script, style and frame sources (start with default-src 'self').",
    effort: "medium",
    scope: "site",
  },
  {
    rule: "missing-x-frame-options",
    category: "security",
    severity: "medium",
    title: "No clickjacking protection",
    recommendation: "Send X-Frame-Options: DENY (or SAMEORIGIN), or a CSP frame-ancestors directive.",
    effort: "small",
    scope: "site",
  },
  {
    rule: "missing-x-content-type-options",
    category: "security",
    severity: "medium",
    title: "No X-Content-Type-Options header",
    recommendation: "Send X-Content-Type-Options: nosniff on every response.",
    effort: "small",
    scope: "site",
  },
  {
    rule: "missing-referrer-policy",
    category: "security",
    severity: "low",
    title: "No Referrer-Policy header",
    recommendation: "Send Referrer-Policy: strict-origin-when-cross-origin (or stricter).",
    effort: "small",
    scope: "site",
  },
  {
    rule: "missing-hsts",
    category: "security",
    severity: "high",
    title: "No Strict-Transport-Security header",
    recommendation: "Serve the site over HTTPS only and send Strict-Transport-Security: max-age=31536000; includeSubDomains.",
    effort: "small",
    scope: "site",
  },
  {
    rule: "insecure-form-action",
    category: "security",
    severity: "critical",
    title: "Form submits over plain HTTP",
    recommendation: "Change the form action to an https:// URL so submitted data is encrypted in transit.",
    effort: "small",
    scope: "page",
  },
  {
    rule: "broken-link",
    category: "links",
    severity: "medium",
    title: "Broken link",
    recommendation: "Update the link to a working URL or remove it; redirect moved internal pages.",
    effort: "small",
    scope: "page",
  },
];

/** Null prototype, so rule codes from agent output such as "constructor" never resolve to Object members. */
export const RULES: Record<string, RuleDef> = Object.assign(
  Object.create(null) as Record<string, RuleDef>,
  Object.fromEntries(DEFS.map((d) => [d.rule, d])),
);

export function getRule(rule: string): RuleDef | undefined {
  return Object.hasOwn(RULES, rule) ? RULES[rule] : undefined;
}

export function rulesForCategory(category: AuditCategory): RuleDef[] {
  return DEFS.filter((d) => d.category === category);
}

/** Builds an Issue with category, default severity and recommendation taken from RULES. */
export function buildIssue(
  rule: string,
  fields: { pageUrl: string; description: string; evidence: string; selector?: string; severity?: Severity },
): Issue {
  const def = getRule(rule);
  if (!def) throw new Error(`Unknown audit rule: ${rule}`);
  const issue: Issue = {
    category: def.category,
    severity: fields.severity ?? def.severity,
    rule,
    pageUrl: fields.pageUrl,
    description: fields.description,
    recommendation: def.recommendation,
    evidence: fields.evidence,
  };
  if (fields.selector) issue.selector = fields.selector;
  return issue;
}
