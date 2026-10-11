// Fix plan: the run's closing report. The template plan is deterministic and drafts concrete
// fixes per rule; live mode makes ONE guarded LLM call and falls back to the template.
import { z } from "zod";
import { normalizeUrl } from "@/lib/audit/url";
import { callLlmJson, type RunLlmBudget } from "@/lib/llm/gateway";
import { FIXPLAN_PROMPT } from "@/lib/llm/rubric";
import { partialSentence, planHeadline, planSummary } from "@/components/report/planText";
import type { AuditCategory, FixDraft, FixPlanOutput, PrioritizedIssue, PrioritizedOutput, Severity } from "@/lib/types";

export interface BuildFixPlanArgs {
  prioritized: PrioritizedOutput;
  siteUrl: string;
  partialBranches: { nodeId: string; label: string }[];
  llmMode: "mock" | "live";
  budget?: RunLlmBudget;
}

const TOP_FIXES = 5;
/** Headline and summary style for the live plan, added to the shared fix-plan prompt. */
const PLAIN_STYLE = `Write the headline and summary in plain words for a non-technical reader. The headline is two short sentences, at most 90 characters, like "25 problems found. Start with: add alt text to the team photo." Never put CSS selectors, rule codes, file paths, URLs or host names (such as localhost) in the headline or summary; call a site on localhost "the demo site".`;
const HEADER_RULES: Record<string, { key: string; value: string }> = {
  "missing-csp": {
    key: "Content-Security-Policy",
    value: "default-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; form-action 'self'",
  },
  "missing-hsts": { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  "missing-x-frame-options": { key: "X-Frame-Options", value: "DENY" },
  "missing-x-content-type-options": { key: "X-Content-Type-Options", value: "nosniff" },
  "missing-referrer-policy": { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
};

// ---------- small helpers ----------

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function plural(n: number, word: string): string {
  if (n === 1) return `${n} ${word}`;
  return `${n} ${/(?:x|s|ch|sh)$/.test(word) ? `${word}es` : `${word}s`}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Readable site name for drafted <title> tags: the domain's first label, or the site path on a local host. */
function siteBrand(siteUrl: string): string {
  const words = (s: string) => s.replace(/[-_.]+/g, " ").trim().replace(/\b\w/g, (c) => c.toUpperCase());
  try {
    const u = new URL(siteUrl);
    const local = u.hostname === "localhost" || /^[\d.]+$/.test(u.hostname) || u.hostname.includes(":");
    if (!local) return words(u.hostname.replace(/^www\./, "").split(".")[0]);
    const segment = u.pathname.split("/").filter(Boolean)[0];
    return segment ? words(segment) : "Home";
  } catch {
    return "Home";
  }
}

function pageName(pageUrl: string, siteUrl: string): string {
  if (normalizeUrl(pageUrl) === normalizeUrl(siteUrl)) return "Home";
  try {
    const last = new URL(pageUrl).pathname.split("/").filter(Boolean).pop() ?? "";
    const base = last.replace(/\.[a-z0-9]+$/i, "").replace(/[-_]+/g, " ").trim();
    return base ? base.replace(/\b\w/g, (c) => c.toUpperCase()) : "Home";
  } catch {
    return "this page";
  }
}

function issueText(i: PrioritizedIssue): string {
  return `${i.selector ?? ""} ${i.evidence} ${i.description}`;
}

function selectorId(i: PrioritizedIssue): string | null {
  return /#([A-Za-z][\w-]*)/.exec(i.selector ?? "")?.[1] ?? null;
}

function imageSrc(i: PrioritizedIssue): string {
  const t = issueText(i);
  const found = /src=["']([^"']+)["']/i.exec(t)?.[1] ?? /[\w:/.%-]+\.(?:png|jpe?g|gif|webp|avif|svg)\b/i.exec(t)?.[0];
  return found ? relativeTo(found, i.pageUrl) : "image.jpg";
}

function relativeTo(url: string, pageUrl: string): string {
  try {
    const u = new URL(url, pageUrl);
    const p = new URL(pageUrl);
    if (u.origin !== p.origin) return u.href;
    const dir = p.pathname.replace(/[^/]*$/, "");
    return u.pathname.startsWith(dir) ? u.pathname.slice(dir.length) || "./" : u.pathname;
  } catch {
    return url;
  }
}

function withExt(src: string, ext: string): string {
  return /\.[a-z0-9]+$/i.test(src) ? src.replace(/\.[a-z0-9]+$/i, `.${ext}`) : `${src}.${ext}`;
}

function byteSize(i: PrioritizedIssue): string | null {
  const t = `${i.evidence} ${i.description}`;
  const m = /(\d+(?:\.\d+)?)\s*(MB|KB|kB|bytes|B)\b/.exec(t.replace(/(\d),(\d{3})/g, "$1$2"));
  const raw = /\b(\d{6,})\b/.exec(t);
  const scale: Record<string, number> = { MB: 1_048_576, KB: 1024, kB: 1000, bytes: 1, B: 1 };
  const bytes = m ? Number(m[1]) * scale[m[2]] : raw ? Number(raw[1]) : NaN;
  if (!Number.isFinite(bytes) || bytes <= 0) return null;
  return bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

// ---------- color contrast ----------

function parseHex(hex: string): [number, number, number] | null {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (!/^[0-9a-f]{6}$/i.test(h)) return null;
  return [0, 2, 4].map((o) => parseInt(h.slice(o, o + 2), 16)) as [number, number, number];
}

function toHex(rgb: [number, number, number]): string {
  return `#${rgb.map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, "0")).join("")}`;
}

function luminance(rgb: [number, number, number]): number {
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const A = parseHex(a);
  const B = parseHex(b);
  if (!A || !B) return 0;
  const [hi, lo] = [luminance(A), luminance(B)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Closest shade of `fg` (darker on light backgrounds, lighter on dark ones) that reaches 4.5:1. */
export function passingColor(fg: string, bg: string, target = 4.5): string {
  const F = parseHex(fg) ?? [118, 118, 118];
  const B = parseHex(bg) ?? [255, 255, 255];
  const darken = luminance(B) > 0.18;
  for (let t = 0; t <= 1.0001; t += 0.02) {
    const c = F.map((v) => (darken ? v * (1 - t) : v + (255 - v) * t)) as [number, number, number];
    const hex = toHex(c);
    if (contrastRatio(hex, toHex(B)) >= target) return hex;
  }
  return darken ? "#000000" : "#ffffff";
}

// ---------- per-rule drafts ----------

function draftHeaders(issues: PrioritizedIssue[]): string {
  const rules = [...new Set(issues.filter((i) => i.rule in HEADER_RULES).map((i) => i.rule))];
  const lines = rules.map((r) => `  { key: "${HEADER_RULES[r].key}", value: "${HEADER_RULES[r].value}" },`);
  return [
    "// next.config.ts (static Vercel hosting: same key/value pairs under \"headers\" in vercel.json)",
    "const securityHeaders = [",
    ...lines,
    "];",
    "",
    "const nextConfig = {",
    "  async headers() {",
    '    return [{ source: "/:path*", headers: securityHeaders }];',
    "  },",
    "};",
    "",
    "export default nextConfig;",
  ].join("\n");
}

function draftContrast(i: PrioritizedIssue): { patch: string; title: string } {
  const colors = `${i.evidence} ${i.description}`.match(/#[0-9a-f]{6}\b|#[0-9a-f]{3}\b/gi) ?? [];
  const fg = colors[0] ?? "#999999";
  const bg = colors[1] ?? "#ffffff";
  const fixed = passingColor(fg, bg);
  const sel = i.selector || "/* the low-contrast text */";
  const patch = `${sel} {\n  color: ${fixed}; /* ${contrastRatio(fixed, bg).toFixed(2)}:1 on ${bg} (was ${fg}, ${contrastRatio(fg, bg).toFixed(2)}:1) */\n}`;
  return { patch, title: `Raise text contrast of ${i.selector || "text"} to at least 4.5:1` };
}

function draftBrokenLink(i: PrioritizedIssue, knownPages: string[]): { patch: string; title: string } {
  const href = /a\[href=["']([^"']+)["']\]/.exec(i.selector ?? "")?.[1] ?? /https?:\/\/[^\s"'<>)]+/.exec(i.evidence)?.[0] ?? "";
  let resolved = href;
  try {
    resolved = new URL(href, i.pageUrl).href;
  } catch {
    // keep as written
  }
  const internal = hostOf(resolved) === hostOf(i.pageUrl);
  const base = (u: string) => (u.split("/").filter(Boolean).pop() ?? "").replace(/\.[a-z0-9]+$/i, "").toLowerCase();
  const target = base(resolved);
  const candidate = internal
    ? knownPages.find((p) => normalizeUrl(p) !== normalizeUrl(resolved) && base(p).length >= 4 && target.startsWith(base(p)))
    : undefined;
  if (candidate) {
    const replacement = relativeTo(candidate, i.pageUrl);
    return {
      patch: `- <a href="${href}">\n+ <a href="${replacement}">`,
      title: `Point the broken link ${href} at ${replacement}`,
    };
  }
  return {
    patch: `<!-- ${href} ${internal ? "returns 404" : "does not resolve"}: link to a live page or remove it -->\n- <a href="${href}">…</a>\n+ …`,
    title: `Remove or replace the broken link ${href}`,
  };
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function sitemapXml(siteUrl: string, pages: string[]): string {
  const urls = pages.slice(0, 20).map((p) => `  <url><loc>${xmlEscape(p)}</loc></url>`);
  return ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">', ...urls, "</urlset>"].join("\n");
}

function sitemapUrl(siteUrl: string): string {
  try {
    return new URL("sitemap.xml", siteUrl).href;
  } catch {
    return `${siteUrl.replace(/\/?$/, "/")}sitemap.xml`;
  }
}

interface DraftContext {
  siteUrl: string;
  knownPages: string[];
  allIssues: PrioritizedIssue[];
}

/** Concrete drafted fix for one issue, by rule. */
export function draftFix(i: PrioritizedIssue, ctx: DraftContext): FixDraft {
  const page = pageName(i.pageUrl, ctx.siteUrl);
  const id = selectorId(i);
  const idAttr = id ? ` id="${id}"` : "";
  const make = (title: string, patch: string, language: string): FixDraft => ({ issueId: i.id, title, patch, language });
  switch (i.rule) {
    case "image-alt": {
      const src = imageSrc(i);
      return make(`Add alt text to ${i.selector || src} on ${page}`, `<img${idAttr} src="${src}" alt="Describe what the image shows and why it matters">\n<!-- purely decorative images use alt="" -->`, "html");
    }
    case "color-contrast": {
      const d = draftContrast(i);
      return make(`${d.title} on ${page}`, d.patch, "css");
    }
    case "label": {
      const fid = id ?? "field";
      return make(`Label the ${i.selector || "form field"} input on ${page}`, `<label for="${fid}">${fid.replace(/[-_]/g, " ").replace(/^\w/, (c) => c.toUpperCase())}</label>\n<input id="${fid}" name="${fid}" type="${fid === "email" ? "email" : "text"}">`, "html");
    }
    case "button-name": {
      const action = (id ?? "").replace(/[-_]?(btn|button)$/i, "").replace(/[-_]+/g, " ").trim();
      const label = action ? action.replace(/^\w/, (c) => c.toUpperCase()) : "Describe what the button does";
      return make(`Give ${i.selector || "the icon button"} an accessible name on ${page}`, `<button${idAttr} type="submit" aria-label="${label}">\n  <svg aria-hidden="true" focusable="false">…</svg>\n</button>`, "html");
    }
    case "html-has-lang":
      return make(`Declare the page language on ${page}`, `<!doctype html>\n<html lang="en">`, "html");
    case "meta-description":
      return make(`Add a meta description to ${page}`, `<head>\n  <meta name="description" content="${page}: one or two sentences (120-160 characters) that tell searchers what this page offers.">\n</head>`, "html");
    case "document-title":
      return make(`Add a <title> to ${page}`, `<head>\n  <title>${page} | ${siteBrand(ctx.siteUrl)}</title>\n</head>`, "html");
    case "multiple-h1":
      return make(`Keep a single <h1> on ${page}`, `<h1>${page}</h1>\n<!-- demote every other <h1> on the page -->\n<h2>…</h2>`, "html");
    case "robots-txt":
      return make("Add robots.txt at the site root", `User-agent: *\nAllow: /\n\nSitemap: ${sitemapUrl(ctx.siteUrl)}`, "text");
    case "sitemap":
      return make("Publish sitemap.xml at the site root", sitemapXml(ctx.siteUrl, ctx.knownPages), "xml");
    case "insecure-form-action": {
      const action = /http:\/\/[^\s"'<>)]+/.exec(issueText(i))?.[0];
      const https = action ? action.replace(/^http:/, "https:") : "/api/contact";
      return make(`Post the ${page} form over HTTPS`, `${action ? `- <form action="${action}" method="post">\n+ ` : ""}<form action="${https}" method="post">`, action ? "diff" : "html");
    }
    case "oversized-image": {
      const src = imageSrc(i);
      const size = byteSize(i);
      return make(
        `Compress ${src} and serve a next-gen format`,
        `<!-- re-encode ${src}${size ? ` (${size})` : ""} at its displayed size; aim for under 200 KB -->\n<picture>\n  <source srcset="${withExt(src, "avif")}" type="image/avif">\n  <source srcset="${withExt(src, "webp")}" type="image/webp">\n  <img${idAttr} src="${withExt(src, "jpg")}" width="1200" height="630" alt="…" decoding="async">\n</picture>`,
        "html",
      );
    }
    case "unsized-image": {
      const src = imageSrc(i);
      return make(`Reserve space for ${i.selector || src} on ${page}`, `<!-- use the image's intrinsic size; CSS can still scale it (max-width: 100%; height: auto) -->\n<img${idAttr} src="${src}" width="1200" height="630" alt="…">`, "html");
    }
    case "render-blocking-script": {
      const src = /script\[src=["']([^"']+)["']\]/.exec(i.selector ?? "")?.[1] ?? /[\w:/.%-]+\.js\b/.exec(issueText(i))?.[0] ?? "script.js";
      return make(`Defer ${src} on ${page}`, `- <script src="${src}"></script>\n+ <script src="${src}" defer></script>`, "diff");
    }
    case "broken-link": {
      const d = draftBrokenLink(i, ctx.knownPages);
      return make(`${d.title} on ${page}`, d.patch, "diff");
    }
    default:
      if (i.rule in HEADER_RULES) return make("Send the missing security headers on every response", draftHeaders(ctx.allIssues), "ts");
      return make(clip(i.description, 80), `/* ${clip(i.recommendation, 300)} */`, "text");
  }
}

// ---------- template plan ----------

function sortedIssues(p: PrioritizedOutput): PrioritizedIssue[] {
  return [...p.issues].sort((a, b) => a.priority - b.priority);
}

function knownPagesOf(issues: PrioritizedIssue[], siteUrl: string): string[] {
  return [...new Set([normalizeUrl(siteUrl), ...issues.map((i) => normalizeUrl(i.pageUrl))])];
}

function severityCounts(issues: PrioritizedIssue[]): Record<Severity, number> {
  const c: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const i of issues) if (i.severity in c) c[i.severity] += 1;
  return c;
}

function topCategories(issues: PrioritizedIssue[], n: number): [AuditCategory, number][] {
  const m = new Map<AuditCategory, number>();
  for (const i of issues) m.set(i.category, (m.get(i.category) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n);
}

/** Groups same-kind issues: every missing security header shares one combined draft. */
function fixGroup(rule: string): string {
  return rule in HEADER_RULES ? "security-headers" : rule;
}

/**
 * Drafts for the highest-priority issue of each kind, in priority order. Repeats of a kind
 * (the same fix on other pages, or other missing headers) are folded into that draft.
 */
function draftTopFixes(sorted: PrioritizedIssue[], siteUrl: string): FixDraft[] {
  const ctx: DraftContext = { siteUrl, knownPages: knownPagesOf(sorted, siteUrl), allIssues: sorted };
  const groupSize = new Map<string, number>();
  for (const i of sorted) groupSize.set(fixGroup(i.rule), (groupSize.get(fixGroup(i.rule)) ?? 0) + 1);
  const fixes: FixDraft[] = [];
  const drafted = new Set<string>();
  for (const i of sorted) {
    if (fixes.length >= TOP_FIXES) break;
    const group = fixGroup(i.rule);
    if (drafted.has(group)) continue;
    drafted.add(group);
    const draft = draftFix(i, ctx);
    const more = (groupSize.get(group) ?? 1) - 1;
    if (more > 0 && group !== "security-headers") draft.title = `${draft.title} (same fix for ${plural(more, "more issue")})`;
    fixes.push(draft);
  }
  return fixes;
}

export function templateFixPlan(a: Pick<BuildFixPlanArgs, "prioritized" | "siteUrl" | "partialBranches">): FixPlanOutput {
  const sorted = sortedIssues(a.prioritized);
  const topFixes = sorted.length ? draftTopFixes(sorted, a.siteUrl) : [];
  return {
    headline: planHeadline(sorted, a.siteUrl, a.partialBranches.length),
    summary: planSummary({
      issues: sorted,
      dedupedFrom: a.prioritized.dedupedFrom,
      siteUrl: a.siteUrl,
      fixCount: topFixes.length,
      partial: a.partialBranches,
    }),
    topFixes,
    source: "template",
  };
}

// ---------- live plan ----------

const FIXPLAN_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    headline: { type: "string" },
    summary: { type: "string" },
    topFixes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          issueId: { type: "string" },
          title: { type: "string" },
          patch: { type: "string" },
          language: { type: "string" },
        },
        required: ["issueId", "title", "patch", "language"],
        additionalProperties: false,
      },
    },
  },
  required: ["headline", "summary", "topFixes"],
  additionalProperties: false,
};

const LlmPlanSchema = z.object({
  headline: z.string().trim().min(1),
  summary: z.string().trim().min(1),
  topFixes: z.array(
    z.object({
      issueId: z.string().min(1),
      title: z.string().trim().min(1),
      patch: z.string().trim().min(1),
      language: z.string().trim().min(1),
    }),
  ),
});

function llmUserPrompt(a: BuildFixPlanArgs, top: PrioritizedIssue[], sorted: PrioritizedIssue[]): string {
  const counts = severityCounts(sorted);
  const cats = topCategories(sorted, 5).map(([c, n]) => `${c}: ${n}`);
  const issues = top.map((i) => ({
    issueId: i.id,
    priority: i.priority,
    severity: i.severity,
    category: i.category,
    rule: i.rule,
    pageUrl: clip(i.pageUrl, 160),
    ...(i.selector ? { selector: clip(i.selector, 100) } : {}),
    description: clip(i.description, 240),
    evidence: clip(i.evidence, 240),
    recommendation: clip(i.recommendation, 240),
    effort: i.effort,
  }));
  const otherHeaders = sorted.filter((i) => i.rule in HEADER_RULES && !top.includes(i)).map((i) => i.rule);
  return [
    `Site: ${a.siteUrl}`,
    `Totals: ${sorted.length} prioritized issues (critical ${counts.critical}, high ${counts.high}, medium ${counts.medium}, low ${counts.low}), deduplicated from ${a.prioritized.dedupedFrom} raw findings. By category: ${cats.join(", ")}.`,
    `Partial branches (audits missing from this report): ${a.partialBranches.map((p) => p.label).join(", ") || "none"}`,
    otherHeaders.length ? `Other missing security headers further down the list: ${otherHeaders.join(", ")}` : "",
    `Issues to draft fixes for (in order):\n${JSON.stringify(issues)}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function validatePlan(data: unknown, top: PrioritizedIssue[]): Omit<FixPlanOutput, "source"> | null {
  const parsed = LlmPlanSchema.safeParse(data);
  if (!parsed.success) return null;
  const ids = new Set(top.map((i) => i.id));
  const seen = new Set<string>();
  const topFixes: FixDraft[] = [];
  for (const f of parsed.data.topFixes) {
    if (!ids.has(f.issueId) || seen.has(f.issueId)) return null;
    seen.add(f.issueId);
    topFixes.push({ issueId: f.issueId, title: clip(f.title.trim(), 120), patch: clip(f.patch.trim(), 2000), language: clip(f.language.trim(), 20) });
  }
  if (!topFixes.length || topFixes.length > TOP_FIXES) return null;
  return { headline: clip(parsed.data.headline.trim(), 200), summary: clip(parsed.data.summary.trim(), 1200), topFixes };
}

async function llmFixPlan(a: BuildFixPlanArgs): Promise<FixPlanOutput | null> {
  const sorted = sortedIssues(a.prioritized);
  const top = sorted.slice(0, TOP_FIXES);
  const res = await callLlmJson<unknown>({
    purpose: "fixplan",
    system: `${FIXPLAN_PROMPT}\n${PLAIN_STYLE}`,
    user: llmUserPrompt(a, top, sorted),
    schemaName: "fix_plan",
    schema: FIXPLAN_SCHEMA,
    runBudget: a.budget,
    validate: (d) => validatePlan(d, top) !== null,
  });
  const plan = validatePlan(res.data, top);
  if (!plan) return null;
  const mentionsPartial = a.partialBranches.every((p) => plan.summary.toLowerCase().includes(p.label.toLowerCase()));
  const summary = a.partialBranches.length && !mentionsPartial ? `${plan.summary} ${partialSentence(a.partialBranches)}` : plan.summary;
  return { ...plan, summary, source: "llm" };
}

/** Fix plan for the run. Live mode: one guarded LLM call; any failure falls back to the template. */
export async function buildFixPlan(a: BuildFixPlanArgs): Promise<FixPlanOutput> {
  if (a.llmMode !== "live" || a.prioritized.issues.length === 0) return templateFixPlan(a);
  try {
    return (await llmFixPlan(a)) ?? templateFixPlan(a);
  } catch {
    return templateFixPlan(a);
  }
}
