// Local audit analyzers: crawl plus the five audit categories, on real fetched HTML.
import { load, type CheerioAPI } from "cheerio";
import type { AnyNode, Element } from "domhandler";
import type { AuditCategory, AuditOutput, CrawlInput, CrawlOutput, CrawlPage, Issue, PageAuditInput, SiteAuditInput } from "@/lib/types";
import { checkUrl, fetchPage, isHtmlResponse, mapLimit, type FetchedPage, type UrlCheck } from "@/lib/audit/fetcher";
import { MIN_CONTRAST_RATIO, OVERSIZED_IMAGE_BYTES, buildIssue } from "@/lib/audit/rules";
import { isWithinSite, normalizeUrl, resolveHttpUrl, sameOrigin, siteRootUrl, urlDirectory } from "@/lib/audit/url";

const CRAWL_CONCURRENCY = 4;
const CHECK_CONCURRENCY = 8;
const MAX_CRAWL_PAGES = 200;
const ASSET_EXTENSIONS = /\.(png|jpe?g|gif|svg|webp|avif|ico|bmp|css|js|mjs|map|json|xml|txt|pdf|zip|gz|tgz|mp3|mp4|webm|mov|woff2?|ttf|otf|eot|csv|docx?|xlsx?|pptx?)$/i;
const SKIPPED_HREF = /^(mailto:|tel:|javascript:|data:|sms:|#)/i;

interface Doc {
  pageUrl: string;
  page: FetchedPage;
  $: CheerioAPI;
  /** Base URL for resolving relative references (honors <base href>). */
  base: string;
}

// ---------- crawl ----------

/** BFS over same-site <a href> links. Only HTML pages answering 200 are kept; home first. */
export async function crawlSite(input: CrawlInput): Promise<CrawlOutput> {
  const start = siteRootUrl(input.siteUrl);
  const root = crawlRoot(start, await fetchPage(start));
  const maxPages = Math.min(Math.max(1, Math.floor(input.maxPages || 1)), MAX_CRAWL_PAGES);
  const fetchBudget = maxPages * 4 + 10;
  const queue = [start];
  const queued = new Set(queue);
  const recorded = new Set<string>();
  const pages: CrawlPage[] = [];
  let fetched = 0;

  while (queue.length > 0 && pages.length < maxPages && fetched < fetchBudget) {
    const batch = queue.splice(0, Math.min(CRAWL_CONCURRENCY, fetchBudget - fetched));
    fetched += batch.length;
    const results = await Promise.all(batch.map((url) => fetchPage(url)));
    for (const page of results) {
      if (pages.length >= maxPages) break;
      if (page.status !== 200 || !isHtmlResponse(page)) continue;
      const url = normalizeUrl(page.finalUrl);
      if (recorded.has(url) || !isWithinSite(url, root)) continue;
      recorded.add(url);
      queued.add(url);
      const $ = load(page.html);
      pages.push({ url, title: pageTitle($), status: 200 });
      for (const link of crawlableLinks($, documentBase($, page.finalUrl), root)) {
        if (queued.has(link)) continue;
        queued.add(link);
        queue.push(link);
      }
    }
  }
  return { pages };
}

/**
 * The site the crawl stays inside. When the home page redirects elsewhere (http → https,
 * apex → www, /docs → /docs/en/) the crawl follows it; otherwise every page would fall
 * outside the original root and the crawl would come back empty.
 */
function crawlRoot(start: string, home: FetchedPage): string {
  if (home.status !== 200) return start;
  const landed = normalizeUrl(home.finalUrl);
  if (isWithinSite(landed, start)) return start;
  const u = new URL(landed);
  const startDir = urlDirectory(start);
  u.pathname = u.pathname.startsWith(startDir) ? startDir : urlDirectory(landed);
  return u.toString();
}

function crawlableLinks($: CheerioAPI, base: string, root: string): string[] {
  const links: string[] = [];
  $("a[href]").each((_, el) => {
    const href = el.attribs.href ?? "";
    if (SKIPPED_HREF.test(href.trim())) return;
    const resolved = resolveHttpUrl(href, base);
    if (!resolved) return;
    const url = normalizeUrl(resolved);
    if (isWithinSite(url, root) && !ASSET_EXTENSIONS.test(new URL(url).pathname)) links.push(url);
  });
  return links;
}

// ---------- entry points ----------

export async function auditPage(category: "accessibility" | "performance", input: PageAuditInput): Promise<AuditOutput> {
  const pageUrl = normalizeUrl(input.pageUrl);
  const doc = await loadDoc(pageUrl);
  if (!doc.ok) return { issues: [], pagesChecked: [], summary: `Could not load ${pageUrl}: ${doc.reason}.` };
  const issues = category === "accessibility" ? accessibilityIssues(doc.doc) : await performanceIssues(doc.doc);
  return { issues, pagesChecked: [pageUrl], summary: summarize(category, issues, 1) };
}

export async function auditSite(category: "seo" | "security" | "links", input: SiteAuditInput): Promise<AuditOutput> {
  const root = siteRootUrl(input.siteUrl);
  if (!resolveHttpUrl(root)) return { issues: [], pagesChecked: [], summary: `Site URL ${root} is not an absolute http(s) URL.` };
  const pageUrls = uniqueUrls(input.pages.length > 0 ? input.pages : [root]);
  const loaded = await mapLimit(pageUrls, CRAWL_CONCURRENCY, (url) => loadDoc(url));
  const docs = loaded.flatMap((d) => (d.ok ? [d.doc] : []));
  const checked = docs.map((d) => d.pageUrl);

  if (category === "seo") {
    const issues = [...docs.flatMap(seoPageIssues), ...(await seoSiteIssues(root))];
    return { issues, pagesChecked: checked, summary: summarize(category, issues, checked.length) };
  }
  if (category === "security") {
    const issues = [...(await securityHeaderIssues(root)), ...docs.flatMap(insecureFormIssues)];
    const pagesChecked = uniqueUrls([root, ...checked]);
    return { issues, pagesChecked, summary: summarize(category, issues, pagesChecked.length) };
  }
  const issues = await brokenLinkIssues(docs);
  return { issues, pagesChecked: checked, summary: summarize(category, issues, checked.length) };
}

// ---------- accessibility ----------

function accessibilityIssues(doc: Doc): Issue[] {
  return [...imageAltIssues(doc), ...contrastIssues(doc), ...labelIssues(doc), ...buttonNameIssues(doc), ...htmlLangIssues(doc)];
}

function imageAltIssues({ $, pageUrl }: Doc): Issue[] {
  return $("img")
    .toArray()
    .filter((el) => el.attribs.alt === undefined && !isHiddenFromAT(el) && !hasAriaName(el))
    .map((el) =>
      buildIssue("image-alt", {
        pageUrl,
        selector: selectorFor($, el),
        description: `Image ${el.attribs.src ?? "(no src)"} has no alt attribute.`,
        evidence: openTag(el),
      }),
    );
}

function contrastIssues({ $, pageUrl }: Doc): Issue[] {
  const issues: Issue[] = [];
  $("[style]").each((_, el) => {
    const colorValue = inlineStyle(el, "color");
    if (!colorValue || $(el).text().trim() === "") return;
    const fg = parseCssColor(colorValue);
    const bg = effectiveBackground(el);
    if (!fg || !bg) return;
    const ratio = contrastRatio(blend(fg, bg.color), bg.color);
    const min = isLargeText(el) ? 3 : MIN_CONTRAST_RATIO;
    if (ratio >= min) return;
    issues.push(
      buildIssue("color-contrast", {
        pageUrl,
        selector: selectorFor($, el),
        description: `Text color ${colorValue} on ${bg.source} has a contrast ratio of ${ratio.toFixed(2)}:1 (minimum ${min}:1).`,
        evidence: `color ${colorValue} on background ${bg.source}: ${ratio.toFixed(2)}:1 < ${min}:1; ${openTag(el)}`,
      }),
    );
  });
  return issues;
}

function labelIssues({ $, pageUrl }: Doc): Issue[] {
  const labelFor = new Set($("label[for]").toArray().map((l) => l.attribs.for));
  return $("input, select, textarea")
    .toArray()
    .filter((el) => needsLabel(el) && !isLabelled($, el, labelFor))
    .map((el) =>
      buildIssue("label", {
        pageUrl,
        selector: selectorFor($, el),
        description: `Form field ${describeField(el)} has no associated label.`,
        evidence: openTag(el),
      }),
    );
}

function needsLabel(el: Element): boolean {
  if (el.tagName.toLowerCase() !== "input") return true;
  const type = (el.attribs.type ?? "text").toLowerCase();
  return !["hidden", "submit", "button", "reset", "image"].includes(type);
}

function isLabelled($: CheerioAPI, el: Element, labelFor: Set<string>): boolean {
  const id = el.attribs.id;
  if (id && labelFor.has(id)) return true;
  if ($(el).closest("label").length > 0) return true;
  return hasAriaName(el);
}

function buttonNameIssues({ $, pageUrl }: Doc): Issue[] {
  return $("button")
    .toArray()
    .filter((el) => !hasButtonName($, el))
    .map((el) =>
      buildIssue("button-name", {
        pageUrl,
        selector: selectorFor($, el),
        description: "Button has no text, aria-label or title, so screen readers cannot announce what it does.",
        evidence: openTag(el),
      }),
    );
}

function hasButtonName($: CheerioAPI, el: Element): boolean {
  if ($(el).text().trim() !== "") return true;
  if (hasAriaName(el) || (el.attribs.title ?? "").trim() !== "") return true;
  return $(el)
    .find("img[alt]")
    .toArray()
    .some((img) => (img.attribs.alt ?? "").trim() !== "");
}

function htmlLangIssues({ $, pageUrl }: Doc): Issue[] {
  const html = $("html").get(0);
  if (!html || (html.attribs.lang ?? "").trim() !== "") return [];
  return [
    buildIssue("html-has-lang", {
      pageUrl,
      selector: "html",
      description: "The <html> element has no lang attribute.",
      evidence: openTag(html),
    }),
  ];
}

function isHiddenFromAT(el: Element): boolean {
  const role = (el.attribs.role ?? "").toLowerCase();
  return role === "presentation" || role === "none" || el.attribs["aria-hidden"] === "true";
}

function hasAriaName(el: Element): boolean {
  return (el.attribs["aria-label"] ?? "").trim() !== "" || (el.attribs["aria-labelledby"] ?? "").trim() !== "";
}

function describeField(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const type = el.attribs.type ? ` type="${el.attribs.type}"` : "";
  const name = el.attribs.name ? ` name="${el.attribs.name}"` : "";
  return `<${tag}${type}${name}>`;
}

// ---------- color contrast ----------

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 };
const NAMED_COLORS: Record<string, string> = {
  black: "#000000",
  white: "#ffffff",
  gray: "#808080",
  grey: "#808080",
  silver: "#c0c0c0",
  lightgray: "#d3d3d3",
  lightgrey: "#d3d3d3",
  darkgray: "#a9a9a9",
  darkgrey: "#a9a9a9",
  red: "#ff0000",
  green: "#008000",
  blue: "#0000ff",
  yellow: "#ffff00",
  orange: "#ffa500",
  purple: "#800080",
  navy: "#000080",
  teal: "#008080",
  maroon: "#800000",
};

/** Parses hex, rgb()/rgba() and a few named colors. Returns null for anything else (variables, currentColor…). */
export function parseCssColor(raw: string): Rgba | null {
  const value = raw.trim().toLowerCase();
  if (value === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  // Own keys only: page CSS like `color: constructor` must not reach Object members.
  if (Object.hasOwn(NAMED_COLORS, value)) return parseCssColor(NAMED_COLORS[value]);
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(value);
  if (hex) {
    const h = hex[1].length <= 4 ? [...hex[1]].map((c) => c + c).join("") : hex[1];
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
  }
  const fn = /^rgba?\(([^)]+)\)$/.exec(value);
  if (!fn) return null;
  const parts = fn[1].split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const channel = (p: string) => (p.endsWith("%") ? (parseFloat(p) * 255) / 100 : parseFloat(p));
  const alpha = parts[3] === undefined ? 1 : parts[3].endsWith("%") ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
  const [r, g, b] = parts.slice(0, 3).map(channel);
  if ([r, g, b, alpha].some((x) => Number.isNaN(x))) return null;
  return { r, g, b, a: alpha };
}

/** WCAG 2.x contrast ratio between two opaque colors. */
export function contrastRatio(a: Rgba, b: Rgba): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function relativeLuminance({ r, g, b }: Rgba): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function blend(top: Rgba, under: Rgba): Rgba {
  if (top.a >= 1) return top;
  const mix = (t: number, u: number) => t * top.a + u * (1 - top.a);
  return { r: mix(top.r, under.r), g: mix(top.g, under.g), b: mix(top.b, under.b), a: 1 };
}

/** Nearest inline background color on the element or an ancestor; white when none is set. */
function effectiveBackground(el: Element): { color: Rgba; source: string } | null {
  for (let node: Element | null = el; node; node = parentElement(node)) {
    const raw = inlineStyle(node, "background-color") ?? backgroundShorthandColor(node);
    if (raw === undefined) continue;
    const color = parseCssColor(raw);
    if (!color) return null;
    if (color.a === 0) continue;
    return { color: blend(color, WHITE), source: raw };
  }
  return { color: WHITE, source: "#ffffff (default)" };
}

function backgroundShorthandColor(el: Element): string | undefined {
  const value = inlineStyle(el, "background");
  if (value === undefined) return undefined;
  if (parseCssColor(value)) return value;
  return value.split(/\s+(?![^(]*\))/).find((token) => parseCssColor(token) !== null);
}

/** WCAG large text: at least 18pt (24px), or 14pt (18.66px) bold. Sizes other than px/pt count as normal text. */
function isLargeText(el: Element): boolean {
  const size = /^([\d.]+)(px|pt)$/i.exec(inlineStyle(el, "font-size") ?? "");
  const px = size ? parseFloat(size[1]) * (size[2].toLowerCase() === "pt" ? 4 / 3 : 1) : 0;
  const weight = (inlineStyle(el, "font-weight") ?? "").toLowerCase();
  const bold = weight === "bold" || weight === "bolder" || parseInt(weight, 10) >= 700;
  return px >= 24 || (bold && px >= 18.66);
}

function inlineStyle(el: Element, prop: string): string | undefined {
  const style = el.attribs.style;
  if (!style) return undefined;
  let found: string | undefined;
  for (const decl of style.split(";")) {
    const colon = decl.indexOf(":");
    if (colon < 0) continue;
    if (decl.slice(0, colon).trim().toLowerCase() !== prop) continue;
    found = decl
      .slice(colon + 1)
      .replace(/!important/i, "")
      .trim();
  }
  return found;
}

function parentElement(el: Element): Element | null {
  const parent = el.parent;
  return parent && isElementNode(parent) ? parent : null;
}

/** Element nodes (domhandler gives <script> and <style> their own node types). */
function isElementNode(node: AnyNode): node is Element {
  return node.type === "tag" || node.type === "script" || node.type === "style";
}

// ---------- performance ----------

async function performanceIssues(doc: Doc): Promise<Issue[]> {
  return [...(await oversizedImageIssues(doc)), ...unsizedImageIssues(doc), ...renderBlockingIssues(doc)];
}

/** Every http(s) image is sized, CDN-hosted ones included (that is where heavy images usually live). */
async function oversizedImageIssues({ $, pageUrl, base }: Doc): Promise<Issue[]> {
  const images = $("img[src]")
    .toArray()
    .map((el) => ({ el, url: resolveHttpUrl(el.attribs.src ?? "", base) }))
    .filter((img): img is { el: Element; url: string } => img.url !== null);
  const checks = await mapLimit(images, CHECK_CONCURRENCY, (img) => checkUrl(img.url));
  return images.flatMap(({ el, url }, i) => {
    const bytes = checks[i].ok ? (checks[i].bytes ?? null) : null;
    if (bytes === null || bytes <= OVERSIZED_IMAGE_BYTES) return [];
    return [
      buildIssue("oversized-image", {
        pageUrl,
        selector: selectorFor($, el),
        description: `Image ${el.attribs.src} is ${formatBytes(bytes)}, above the ${formatBytes(OVERSIZED_IMAGE_BYTES)} budget.`,
        evidence: `${url} is ${bytes} bytes (${formatBytes(bytes)}); threshold ${OVERSIZED_IMAGE_BYTES} bytes (500 KB).`,
      }),
    ];
  });
}

function unsizedImageIssues({ $, pageUrl }: Doc): Issue[] {
  return $("img")
    .toArray()
    .filter((el) => el.attribs.width === undefined || el.attribs.height === undefined)
    .map((el) => {
      const missing = [el.attribs.width === undefined ? "width" : "", el.attribs.height === undefined ? "height" : ""].filter(Boolean);
      return buildIssue("unsized-image", {
        pageUrl,
        selector: selectorFor($, el),
        description: `Image ${el.attribs.src ?? "(no src)"} has no ${missing.join(" or ")} attribute, so it shifts the layout when it loads.`,
        evidence: openTag(el),
      });
    });
}

function renderBlockingIssues({ $, pageUrl }: Doc): Issue[] {
  return $("head script[src]")
    .toArray()
    .filter((el) => isBlockingScript(el))
    .map((el) =>
      buildIssue("render-blocking-script", {
        pageUrl,
        selector: selectorFor($, el),
        description: `Script ${el.attribs.src} loads synchronously in <head> and blocks the first render.`,
        evidence: `${openTag(el)}</script> in <head> without async or defer`,
      }),
    );
}

function isBlockingScript(el: Element): boolean {
  if (el.attribs.async !== undefined || el.attribs.defer !== undefined) return false;
  const type = (el.attribs.type ?? "").trim().toLowerCase();
  return type === "" || type === "text/javascript" || type === "application/javascript";
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

// ---------- seo ----------

function seoPageIssues(doc: Doc): Issue[] {
  return [...titleIssues(doc), ...metaDescriptionIssues(doc), ...multipleH1Issues(doc)];
}

function titleIssues({ $, pageUrl }: Doc): Issue[] {
  const title = documentTitleElement($);
  if (title && $(title).text().trim() !== "") return [];
  return [
    buildIssue("document-title", {
      pageUrl,
      description: title ? `Page ${pagePath(pageUrl)} has an empty <title>.` : `Page ${pagePath(pageUrl)} has no <title> element.`,
      evidence: title ? "<title></title>" : "No <title> element in the document.",
    }),
  ];
}

function metaDescriptionIssues({ $, pageUrl }: Doc): Issue[] {
  const meta = $("meta[name]")
    .toArray()
    .find((el) => (el.attribs.name ?? "").trim().toLowerCase() === "description");
  if (meta && (meta.attribs.content ?? "").trim() !== "") return [];
  return [
    buildIssue("meta-description", {
      pageUrl,
      selector: meta ? selectorFor($, meta) : undefined,
      description: meta ? `Page ${pagePath(pageUrl)} has an empty meta description.` : `Page ${pagePath(pageUrl)} has no meta description.`,
      evidence: meta ? openTag(meta) : "No <meta name=\"description\"> in <head>.",
    }),
  ];
}

function multipleH1Issues({ $, pageUrl }: Doc): Issue[] {
  const headings = $("h1").toArray();
  if (headings.length < 2) return [];
  const texts = headings.map((h) => `"${$(h).text().replace(/\s+/g, " ").trim()}"`);
  return [
    buildIssue("multiple-h1", {
      pageUrl,
      selector: "h1",
      description: `Page ${pagePath(pageUrl)} has ${headings.length} <h1> elements.`,
      evidence: `${headings.length} <h1> elements: ${texts.join(", ")}`,
    }),
  ];
}

async function seoSiteIssues(root: string): Promise<Issue[]> {
  const robotsUrl = new URL("robots.txt", root).toString();
  const robots = await checkUrl(robotsUrl);
  const issues: Issue[] = [];
  if (isMissing(robots)) {
    issues.push(
      buildIssue("robots-txt", {
        pageUrl: root,
        description: "The site has no robots.txt.",
        evidence: `GET ${robotsUrl} returned ${robots.status}.`,
      }),
    );
  }
  // A sitemap counts when /sitemap.xml or any sitemap robots.txt lists is reachable.
  const sitemapUrl = new URL("sitemap.xml", root).toString();
  const listed = robots.ok ? await sitemapsFromRobots(robotsUrl) : [];
  const candidates = [...new Set([...listed, sitemapUrl])];
  const sitemaps = await mapLimit(candidates, CHECK_CONCURRENCY, (url) => checkUrl(url));
  if (!sitemaps.some((c) => c.ok) && isMissing(sitemaps[candidates.indexOf(sitemapUrl)])) {
    issues.push(
      buildIssue("sitemap", {
        pageUrl: root,
        description: "The site has no sitemap.xml.",
        evidence: candidates.map((url, i) => `GET ${url} returned ${sitemaps[i].status ?? sitemaps[i].error ?? "nothing"}.`).join(" "),
      }),
    );
  }
  return issues;
}

const MAX_LISTED_SITEMAPS = 5;

async function sitemapsFromRobots(robotsUrl: string): Promise<string[]> {
  const robots = await fetchPage(robotsUrl);
  if (robots.status !== 200) return [];
  return [...robots.html.matchAll(/^\s*sitemap:\s*(\S+)/gim)]
    .map((m) => resolveHttpUrl(m[1], robotsUrl))
    .filter((url): url is string => url !== null)
    .slice(0, MAX_LISTED_SITEMAPS);
}

function isMissing(check: UrlCheck): boolean {
  return check.status === 404 || check.status === 410;
}

// ---------- security ----------

const HEADER_RULES: { rule: string; header: string; label: string }[] = [
  { rule: "missing-csp", header: "content-security-policy", label: "Content-Security-Policy" },
  { rule: "missing-x-frame-options", header: "x-frame-options", label: "X-Frame-Options" },
  { rule: "missing-x-content-type-options", header: "x-content-type-options", label: "X-Content-Type-Options" },
  { rule: "missing-referrer-policy", header: "referrer-policy", label: "Referrer-Policy" },
  { rule: "missing-hsts", header: "strict-transport-security", label: "Strict-Transport-Security" },
];

async function securityHeaderIssues(root: string): Promise<Issue[]> {
  const res = await fetchPage(root);
  if (res.status === null) return [];
  const csp = res.headers["content-security-policy"] ?? "";
  return HEADER_RULES.filter(({ rule, header }) => {
    if ((res.headers[header] ?? "").trim() !== "") return false;
    return !(rule === "missing-x-frame-options" && /frame-ancestors/i.test(csp));
  }).map(({ rule, label }) =>
    buildIssue(rule, {
      pageUrl: root,
      description: `The site root response has no ${label} header.`,
      evidence: `GET ${root} returned ${res.status} with no ${label} header.`,
    }),
  );
}

function insecureFormIssues({ $, pageUrl }: Doc): Issue[] {
  return $("form[action]")
    .toArray()
    .filter((el) => (el.attribs.action ?? "").trim().toLowerCase().startsWith("http://"))
    .map((el) =>
      buildIssue("insecure-form-action", {
        pageUrl,
        selector: selectorFor($, el),
        description: `Form submits to ${el.attribs.action?.trim()} over plain HTTP.`,
        evidence: openTag(el),
      }),
    );
}

// ---------- links ----------

interface PageLink {
  doc: Doc;
  href: string;
  url: string;
}

async function brokenLinkIssues(docs: Doc[]): Promise<Issue[]> {
  const links = docs.flatMap(pageLinks);
  const checks = await mapLimit(links, CHECK_CONCURRENCY, (link) => checkUrl(link.url));
  return links.flatMap((link, i) => {
    const check = checks[i];
    if (check.status !== null && check.status < 400) return [];
    // Relative to the page the link is on, which stays right when the site root redirected.
    const internal = sameOrigin(link.url, link.doc.pageUrl);
    const outcome = check.status === null ? `failed: ${check.error ?? "no response"}` : `returned HTTP ${check.status}`;
    return [
      buildIssue("broken-link", {
        pageUrl: link.doc.pageUrl,
        severity: internal ? "medium" : "low",
        selector: `a[href="${cssString(link.href)}"]`,
        description:
          check.status === null
            ? `${internal ? "Internal" : "External"} link to ${link.url} does not resolve.`
            : `${internal ? "Internal" : "External"} link to ${link.href} returns ${check.status}.`,
        evidence: `${link.url} ${outcome}`,
      }),
    ];
  });
}

/** Every http(s) <a href> on the page, deduped by resolved URL. */
function pageLinks(doc: Doc): PageLink[] {
  const seen = new Set<string>();
  const links: PageLink[] = [];
  doc.$("a[href]").each((_, el) => {
    const href = el.attribs.href ?? "";
    if (href.trim() === "" || SKIPPED_HREF.test(href.trim())) return;
    const url = resolveHttpUrl(href, doc.base);
    if (!url || seen.has(url)) return;
    seen.add(url);
    links.push({ doc, href, url });
  });
  return links;
}

// ---------- shared helpers ----------

async function loadDoc(pageUrl: string): Promise<{ ok: true; doc: Doc } | { ok: false; reason: string }> {
  const page = await fetchPage(pageUrl);
  if (page.status === null) return { ok: false, reason: page.error ?? "no response" };
  if (page.status < 200 || page.status >= 300) return { ok: false, reason: `HTTP ${page.status}` };
  if (!isHtmlResponse(page)) return { ok: false, reason: "not an HTML page" };
  const $ = load(page.html);
  return { ok: true, doc: { pageUrl, page, $, base: documentBase($, page.finalUrl) } };
}

function documentBase($: CheerioAPI, finalUrl: string): string {
  const href = $("base[href]").attr("href");
  return (href && resolveHttpUrl(href, finalUrl)) || finalUrl;
}

function pageTitle($: CheerioAPI): string {
  const title = documentTitleElement($);
  return title ? $(title).text().replace(/\s+/g, " ").trim() : "";
}

function documentTitleElement($: CheerioAPI): Element | undefined {
  return $("title")
    .toArray()
    .find((el) => $(el).closest("svg").length === 0);
}

function pagePath(pageUrl: string): string {
  try {
    return new URL(pageUrl).pathname;
  } catch {
    return pageUrl;
  }
}

function uniqueUrls(urls: string[]): string[] {
  return [...new Set(urls.map((u) => normalizeUrl(u)))];
}

function summarize(category: AuditCategory, issues: Issue[], pages: number): string {
  const s = issues.length === 1 ? "" : "s";
  return `${issues.length} ${category} issue${s} across ${pages} page${pages === 1 ? "" : "s"}.`;
}

/** Short, mostly-unique CSS selector: #id, then tag.class or tag[attr="…"], then a structural path. */
export function selectorFor($: CheerioAPI, el: Element): string {
  const tag = el.tagName.toLowerCase();
  if (tag === "html" || tag === "head" || tag === "body") return tag;
  const id = (el.attribs.id ?? "").trim();
  if (id) return /^[A-Za-z][\w-]*$/.test(id) ? `#${id}` : `${tag}[id="${cssString(id)}"]`;
  for (const candidate of selectorCandidates(el, tag)) {
    if (matchesOnly($, candidate, el)) return candidate;
  }
  return structuralSelector(el);
}

function selectorCandidates(el: Element, tag: string): string[] {
  const classes = (el.attribs.class ?? "").split(/\s+/).filter((c) => /^-?[A-Za-z_][\w-]*$/.test(c));
  const attrs = ["src", "href", "name", "action", "for", "type", "aria-label"]
    .filter((a) => (el.attribs[a] ?? "") !== "")
    .map((a) => `${tag}[${a}="${cssString(el.attribs[a])}"]`);
  return [...classes.map((c) => `${tag}.${c}`), ...attrs];
}

function matchesOnly($: CheerioAPI, selector: string, el: Element): boolean {
  try {
    const found = $(selector);
    return found.length === 1 && found.get(0) === el;
  } catch {
    return false;
  }
}

function structuralSelector(el: Element): string {
  const parts: string[] = [];
  for (let node: Element | null = el; node; node = parentElement(node)) {
    const tag = node.tagName.toLowerCase();
    if (node !== el && (node.attribs.id ?? "") !== "" && /^[A-Za-z][\w-]*$/.test(node.attribs.id)) {
      parts.unshift(`#${node.attribs.id}`);
      break;
    }
    if (tag === "body" || tag === "html") {
      parts.unshift(tag);
      break;
    }
    const parent = parentElement(node);
    const sameTag = parent ? parent.children.filter((c): c is Element => isElementNode(c) && c.tagName.toLowerCase() === tag) : [node];
    parts.unshift(sameTag.length > 1 ? `${tag}:nth-of-type(${sameTag.indexOf(node) + 1})` : tag);
  }
  return parts.join(" > ");
}

/** The element's opening tag as written (attribute order preserved). */
function openTag(el: Element): string {
  const attrs = Object.entries(el.attribs)
    .map(([name, value]) => (value === "" ? ` ${name}` : ` ${name}="${value.replace(/"/g, "&quot;")}"`))
    .join("");
  const tag = `<${el.tagName.toLowerCase()}${attrs}>`;
  return tag.length > 300 ? `${tag.slice(0, 297)}…>` : tag;
}

function cssString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\n/g, "\\a ");
}
