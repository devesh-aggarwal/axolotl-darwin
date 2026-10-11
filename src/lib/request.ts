// Reads a typed request ("Do a full accessibility audit of Tidepool Labs") into a run.
// Axolotl runs one kind of job today, a pre-launch website audit, so this only has to find the site
// and confirm the request is an audit. Anything else gets a plain answer instead of a pretend plan.
import type { Capability } from "@/lib/types";

export type ParsedRequest =
  | { kind: "audit"; siteUrl: string; siteLabel: string; maxPages?: number; focus: Capability[] }
  | { kind: "needs_site"; message: string }
  | { kind: "unsupported"; message: string };

/** Longest request kept on a run. */
export const MAX_REQUEST_CHARS = 300;

const AUDIT_WORDS = /\b(audit|check|scan|review|test|inspect|analy[sz]e|wcag|a11y|accessib\w*|seo|performance|speed|security|headers?|broken|links?|launch|ready|issues?|problems?)\b/i;
const FOCUS: [Capability, RegExp][] = [
  ["accessibility", /\b(accessib\w*|wcag|a11y|ada|screen ?readers?|contrast|alt text)\b/i],
  ["performance", /\b(performance|speed|fast|slow|load(ing)? time|core web vitals|lighthouse)\b/i],
  ["seo", /\b(seo|search|meta( tags)?|ranking)\b/i],
  ["security", /\b(security|headers?|hsts|csp|ssl|https)\b/i],
  ["links", /\b(broken|dead|404|links?)\b/i],
];
const URL_RE = /\bhttps?:\/\/[^\s"'<>]+/i;
const HOST_RE = /\b((?:[a-z0-9-]+\.)+(?:com|org|net|io|dev|app|co|ai|so|xyz|site|tech))(\/[^\s"'<>]*)?/i;
const DEMO_NAMES = /\b(tide ?pool( labs)?|demo ?site)\b/i;

export const SITE_CHECKS = "accessibility, performance, SEO, security headers and broken links";

export function parseRequest(text: string, demoSiteUrl: string): ParsedRequest {
  const t = text.trim();
  if (!t) return { kind: "needs_site", message: "Say what to audit, for example: Do a full accessibility audit of Tidepool Labs." };

  let siteUrl: string | undefined;
  let siteLabel = "";
  const url = t.match(URL_RE)?.[0].replace(/[.,;:!?)]+$/, "");
  const host = url ? undefined : t.match(HOST_RE);
  if (url) siteUrl = url;
  else if (host) siteUrl = `https://${host[1]}${host[2] ?? "/"}`.replace(/[.,;:!?)]+$/, "");
  else if (DEMO_NAMES.test(t)) {
    siteUrl = demoSiteUrl;
    siteLabel = "Tidepool (demo site)";
  }
  if (siteUrl && !siteLabel) {
    try {
      siteLabel = new URL(siteUrl).host;
    } catch {
      siteUrl = undefined;
    }
  }

  if (!AUDIT_WORDS.test(t)) {
    return {
      kind: "unsupported",
      message: `Axolotl runs website audits today (${SITE_CHECKS}). Try: Audit Tidepool Labs before launch.`,
    };
  }
  if (!siteUrl) return { kind: "needs_site", message: "Which site? Add its address, like https://your-site.com, or say Tidepool for the demo site." };

  const pages = t.match(/\b(\d{1,2})\s+pages?\b/i);
  const maxPages = pages ? Math.min(10, Math.max(1, Number(pages[1]))) : undefined;
  const focus = FOCUS.filter(([, re]) => re.test(t)).map(([c]) => c);
  return { kind: "audit", siteUrl, siteLabel, maxPages, focus };
}
