// Verification layer 3: re-check a seeded sample of reported claims with our own fetches.
// Each rule has its own small check here; none of them reuse the analyzers' logic.
import { load, type CheerioAPI } from "cheerio";
import type { AnyNode, Element } from "domhandler";
import type { Issue } from "@/lib/types";
import { checkUrl, fetchPage, mapLimit } from "@/lib/audit/fetcher";
import { MIN_CONTRAST_RATIO, OVERSIZED_IMAGE_BYTES } from "@/lib/audit/rules";
import { hrefFromLinkSelector, normalizeUrl, resolveHttpUrl, siteRootUrl, urlsInText } from "@/lib/audit/url";
import { rngFor } from "@/lib/rng";

export type SpotCheckVerdict = "confirmed" | "refuted" | "unverifiable";

export interface SpotCheckSample {
  issue: Issue;
  verdict: SpotCheckVerdict;
  note: string;
}

export interface SpotCheckResult {
  checked: number;
  confirmed: number;
  refuted: number;
  unverifiable: number;
  samples: SpotCheckSample[];
}

interface Outcome {
  verdict: SpotCheckVerdict;
  note: string;
}

const SPOTCHECK_CONCURRENCY = 4;

export async function spotCheckIssues(issues: Issue[], opts: { sample: number; seed: number }): Promise<SpotCheckResult> {
  const picked = pickSample(issues, opts.sample, opts.seed);
  const samples = await mapLimit(picked, SPOTCHECK_CONCURRENCY, async (issue) => ({ issue, ...(await verifyClaim(issue)) }));
  return {
    checked: samples.length,
    confirmed: samples.filter((s) => s.verdict === "confirmed").length,
    refuted: samples.filter((s) => s.verdict === "refuted").length,
    unverifiable: samples.filter((s) => s.verdict === "unverifiable").length,
    samples,
  };
}

/** Seeded sample without replacement, returned in input order. */
function pickSample(issues: Issue[], size: number, seed: number): Issue[] {
  const count = Math.min(Math.max(0, Math.floor(size)), issues.length);
  const rand = rngFor(seed, "spotcheck", issues.length);
  const order = issues.map((_, i) => i);
  for (let i = 0; i < count; i++) {
    const j = i + Math.floor(rand() * (order.length - i));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order
    .slice(0, count)
    .sort((a, b) => a - b)
    .map((i) => issues[i]);
}

/** Re-verifies one claim. Never throws. */
export async function verifyClaim(issue: Issue): Promise<Outcome> {
  // Own keys only: a rule like "constructor" must not resolve to an Object member.
  const check = Object.hasOwn(CHECKS, issue.rule) ? CHECKS[issue.rule] : undefined;
  if (!check) return unverifiable(`no independent check for rule "${String(issue.rule).slice(0, 60)}"`);
  try {
    return await check(issue);
  } catch (err) {
    return unverifiable(`check failed: ${err instanceof Error ? err.message.slice(0, 120) : "unknown error"}`);
  }
}

const confirmed = (note: string): Outcome => ({ verdict: "confirmed", note });
const refuted = (note: string): Outcome => ({ verdict: "refuted", note });
const unverifiable = (note: string): Outcome => ({ verdict: "unverifiable", note });

// ---------- page loading ----------

interface LoadedPage {
  $: CheerioAPI;
  base: string;
  headers: Record<string, string>;
}

async function openPage(pageUrl: string): Promise<LoadedPage | Outcome> {
  if (!resolveHttpUrl(pageUrl)) return refuted(`pageUrl ${pageUrl} is not an absolute http(s) URL`);
  const page = await fetchPage(pageUrl);
  if (page.status === null) return refuted(`page did not load (${page.error ?? "no response"})`);
  if (page.status >= 400) return refuted(`page returned HTTP ${page.status}`);
  const $ = load(page.html);
  const baseHref = $("base[href]").attr("href");
  return { $, base: (baseHref && resolveHttpUrl(baseHref, page.finalUrl)) || page.finalUrl, headers: page.headers };
}

function isOutcome(x: LoadedPage | Outcome): x is Outcome {
  return "verdict" in x;
}

// ---------- element rules ----------

/** true = the element violates the rule, false = it does not, null = cannot tell. */
type ElementTest = (el: Element, page: LoadedPage) => boolean | null | Promise<boolean | null>;

/**
 * With a selector: the claim holds if any matched element violates the rule.
 * Without one: the claim holds if any candidate element on the page does.
 */
function elementCheck(candidates: string, test: ElementTest, what: string): (issue: Issue) => Promise<Outcome> {
  return async (issue) => {
    const page = await openPage(issue.pageUrl);
    if (isOutcome(page)) return page;
    // A selector cheerio cannot parse (pseudo-elements, Playwright syntax) says nothing about the
    // page, so the claim is checked against every candidate element as if it had no selector.
    const selector = issue.selector && parsesAsCss(page.$, issue.selector) ? issue.selector : undefined;
    const targets = page.$(selector ?? candidates).toArray().filter(isElementNode);
    if (selector && targets.length === 0) return refuted(`selector ${selector} matches nothing on the page`);
    let undecided = false;
    for (const el of targets) {
      const verdict = await test(el, page);
      if (verdict === true) return confirmed(`${describe(el)} ${what}`);
      if (verdict === null) undecided = true;
    }
    if (undecided) return unverifiable(`could not evaluate ${selector ?? candidates}`);
    return refuted(selector ? `${selector} does not have this problem` : `no element on the page has this problem`);
  };
}

function parsesAsCss($: CheerioAPI, selector: string): boolean {
  try {
    $(selector);
    return true;
  } catch {
    return false;
  }
}

function isElementNode(node: AnyNode): node is Element {
  return node.type === "tag" || node.type === "script" || node.type === "style";
}

const tagIs = (el: Element, ...tags: string[]) => tags.includes(el.tagName.toLowerCase());
const attr = (el: Element, name: string) => el.attribs[name];
const filled = (value: string | undefined) => (value ?? "").trim() !== "";

function lacksAlt(el: Element): boolean {
  if (!tagIs(el, "img")) return false;
  const role = (attr(el, "role") ?? "").toLowerCase();
  if (role === "presentation" || role === "none" || attr(el, "aria-hidden") === "true") return false;
  return attr(el, "alt") === undefined && !filled(attr(el, "aria-label")) && !filled(attr(el, "aria-labelledby"));
}

function lacksLabel(el: Element, { $ }: LoadedPage): boolean {
  if (!tagIs(el, "input", "select", "textarea")) return false;
  const type = (attr(el, "type") ?? "text").toLowerCase();
  if (tagIs(el, "input") && ["hidden", "submit", "button", "reset", "image"].includes(type)) return false;
  if (filled(attr(el, "aria-label")) || filled(attr(el, "aria-labelledby"))) return false;
  const id = attr(el, "id");
  if (id && $("label").toArray().some((l) => attr(l, "for") === id)) return false;
  return $(el).parents("label").length === 0;
}

function lacksButtonName(el: Element, { $ }: LoadedPage): boolean {
  if (!tagIs(el, "button")) return false;
  if ($(el).text().trim() !== "") return false;
  if (filled(attr(el, "aria-label")) || filled(attr(el, "aria-labelledby")) || filled(attr(el, "title"))) return false;
  return !$(el)
    .find("img")
    .toArray()
    .some((img) => filled(attr(img, "alt")));
}

function lacksLang(el: Element): boolean {
  return tagIs(el, "html") && !filled(attr(el, "lang"));
}

function lacksDimensions(el: Element): boolean {
  return tagIs(el, "img") && (attr(el, "width") === undefined || attr(el, "height") === undefined);
}

function blocksRender(el: Element, { $ }: LoadedPage): boolean {
  if (!tagIs(el, "script") || !filled(attr(el, "src"))) return false;
  if ($(el).parents("head").length === 0) return false;
  if (attr(el, "async") !== undefined || attr(el, "defer") !== undefined) return false;
  const type = (attr(el, "type") ?? "").trim().toLowerCase();
  return ["", "text/javascript", "application/javascript"].includes(type);
}

function postsOverHttp(el: Element): boolean {
  return tagIs(el, "form") && /^http:\/\//i.test((attr(el, "action") ?? "").trim());
}

async function isOversized(el: Element, page: LoadedPage): Promise<boolean | null> {
  if (!tagIs(el, "img")) return false;
  const src = resolveHttpUrl(attr(el, "src") ?? "", page.base);
  if (!src) return null;
  const res = await checkUrl(src);
  if (!res.ok || res.bytes === null || res.bytes === undefined) return null;
  return res.bytes > OVERSIZED_IMAGE_BYTES;
}

function hasLowContrast(el: Element, { $ }: LoadedPage): boolean | null {
  if ($(el).text().trim() === "") return false;
  const chain = [el, ...$(el).parents().toArray()];
  const fgRaw = chain.map((n) => styleValue(n, "color")).find((v) => v !== undefined);
  if (fgRaw === undefined) return null;
  const fg = rgba(fgRaw);
  let bg: number[] | null = WHITE_RGB;
  for (const node of chain) {
    const shorthand = styleValue(node, "background");
    const raw = styleValue(node, "background-color") ?? (shorthand === undefined ? undefined : shorthand.trim().split(/\s+/)[0]);
    if (raw === undefined || raw.trim().toLowerCase() === "transparent") continue;
    const parsed = rgba(raw);
    if (parsed && parsed[3] === 0) continue;
    bg = parsed && over(parsed, WHITE_RGB);
    break;
  }
  if (!fg || !bg) return null;
  // Large text (>= 24px, i.e. 18pt) only; bold 14pt is left at 4.5:1, which is never laxer than the analyzer.
  const min = fontPx(styleValue(el, "font-size")) >= 24 ? 3 : MIN_CONTRAST_RATIO;
  return contrast(over(fg, bg), bg) < min;
}

const WHITE_RGB = [255, 255, 255];

/** Font size in px for px/pt values; 0 when it cannot be known from the markup (em, %, keywords). */
function fontPx(value: string | undefined): number {
  const m = /^([\d.]+)(px|pt)$/i.exec((value ?? "").trim());
  if (!m) return 0;
  return parseFloat(m[1]) * (m[2].toLowerCase() === "pt" ? 4 / 3 : 1);
}

function styleValue(el: Element, prop: string): string | undefined {
  const decls = (attr(el, "style") ?? "").split(";").map((d) => d.split(":"));
  const hit = decls.reverse().find(([name]) => (name ?? "").trim().toLowerCase() === prop);
  return hit ? hit.slice(1).join(":").replace(/!important/i, "").trim() : undefined;
}

/** [r, g, b, alpha] from #rgb, #rrggbb, rgb()/rgba() with integer channels, or white/black; null otherwise. */
function rgba(value: string): number[] | null {
  const v = value.trim().toLowerCase();
  if (v === "white") return [255, 255, 255, 1];
  if (v === "black") return [0, 0, 0, 1];
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(v);
  if (short) return [...short.slice(1).map((c) => parseInt(c + c, 16)), 1];
  const long = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/.exec(v);
  if (long) return [...long.slice(1).map((c) => parseInt(c, 16)), 1];
  const fn = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)\s*(?:[,/]\s*([\d.]+)(%?)\s*)?\)$/.exec(v);
  if (!fn) return null;
  const alpha = fn[4] === undefined ? 1 : parseFloat(fn[4]) / (fn[5] ? 100 : 1);
  return Number.isNaN(alpha) ? null : [...fn.slice(1, 4).map(Number), Math.min(1, alpha)];
}

/** `top` composited over the opaque `under`, as an opaque [r, g, b]. */
function over(top: number[], under: number[]): number[] {
  const a = top[3] ?? 1;
  return [0, 1, 2].map((i) => top[i] * a + under[i] * (1 - a));
}

function contrast(a: number[], b: number[]): number {
  const lum = (c: number[]) => {
    const [r, g, bl] = c.map((x) => {
      const s = x / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function describe(el: Element): string {
  const id = attr(el, "id");
  return `<${el.tagName.toLowerCase()}${id ? `#${id}` : ""}>`;
}

// ---------- page-level rules ----------

async function checkTitle(issue: Issue): Promise<Outcome> {
  const page = await openPage(issue.pageUrl);
  if (isOutcome(page)) return page;
  const title = page.$("title")
    .toArray()
    .find((t) => page.$(t).parents("svg").length === 0);
  const text = title ? page.$(title).text().trim() : "";
  return text ? refuted(`page has a title: "${text.slice(0, 80)}"`) : confirmed(title ? "<title> is empty" : "no <title> element");
}

async function checkMetaDescription(issue: Issue): Promise<Outcome> {
  const page = await openPage(issue.pageUrl);
  if (isOutcome(page)) return page;
  const meta = page.$("meta")
    .toArray()
    .find((m) => (attr(m, "name") ?? "").trim().toLowerCase() === "description");
  if (meta && filled(attr(meta, "content"))) return refuted("page has a non-empty meta description");
  return confirmed(meta ? "meta description is empty" : "no meta description");
}

async function checkMultipleH1(issue: Issue): Promise<Outcome> {
  const page = await openPage(issue.pageUrl);
  if (isOutcome(page)) return page;
  const count = page.$("h1").length;
  return count >= 2 ? confirmed(`${count} <h1> elements`) : refuted(`page has ${count} <h1> element${count === 1 ? "" : "s"}`);
}

function headerCheck(header: string): (issue: Issue) => Promise<Outcome> {
  return async (issue) => {
    const page = await openPage(issue.pageUrl);
    if (isOutcome(page)) return page;
    const value = (page.headers[header] ?? "").trim();
    if (header === "x-frame-options" && /frame-ancestors/i.test(page.headers["content-security-policy"] ?? "")) {
      return refuted("CSP sets frame-ancestors");
    }
    return value ? refuted(`${header} is present: ${value.slice(0, 80)}`) : confirmed(`response has no ${header} header`);
  };
}

function rootFileCheck(file: "robots.txt" | "sitemap.xml"): (issue: Issue) => Promise<Outcome> {
  return async (issue) => {
    const page = await openPage(issue.pageUrl);
    if (isOutcome(page)) return page;
    const root = siteRootUrl(issue.pageUrl);
    const url = new URL(file, root).toString();
    const res = await checkUrl(url);
    if (res.ok) return refuted(`${url} returned ${res.status}`);
    if (file === "sitemap.xml" && (await sitemapListedInRobots(root))) return refuted("robots.txt lists a reachable sitemap");
    if (res.status === 404 || res.status === 410) return confirmed(`${url} returned ${res.status}`);
    return unverifiable(`${url} answered ${res.status ?? res.error ?? "nothing"}`);
  };
}

async function sitemapListedInRobots(root: string): Promise<boolean> {
  const robotsUrl = new URL("robots.txt", root).toString();
  const robots = await fetchPage(robotsUrl);
  if (robots.status !== 200) return false;
  const listed = [...robots.html.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => resolveHttpUrl(m[1], robotsUrl));
  for (const url of listed) {
    if (url && (await checkUrl(url)).ok) return true;
  }
  return false;
}

// ---------- broken links ----------

async function checkBrokenLink(issue: Issue): Promise<Outcome> {
  const page = await openPage(issue.pageUrl);
  if (isOutcome(page)) return page;
  const anchors = page.$("a[href]").toArray();
  const href = hrefFromLinkSelector(issue.selector);
  let target: string | null;
  if (href !== null) {
    if (!anchors.some((a) => attr(a, "href") === href)) return refuted(`no <a href="${href}"> on the page`);
    target = resolveHttpUrl(href, page.base);
    if (!target) return unverifiable(`link "${href}" is not an http(s) URL`);
  } else {
    const onPage = new Set(anchors.map((a) => resolveHttpUrl(attr(a, "href") ?? "", page.base)).filter((u): u is string => u !== null).map((u) => normalizeUrl(u)));
    const claimed = urlsInText(`${issue.evidence} ${issue.description}`);
    if (claimed.length === 0) return unverifiable("claim does not say which link is broken");
    target = claimed.find((u) => onPage.has(normalizeUrl(u))) ?? null;
    if (!target) return refuted("the page does not link to the URL in the claim");
  }
  const res = await checkUrl(target);
  if (res.status === null) return confirmed(`${target} failed: ${res.error ?? "no response"}`);
  if (res.status >= 400) return confirmed(`${target} returned ${res.status}`);
  return refuted(`${target} returned ${res.status}`);
}

// ---------- registry ----------

const CHECKS: Record<string, (issue: Issue) => Promise<Outcome>> = {
  "image-alt": elementCheck("img", lacksAlt, "has no alt attribute"),
  "color-contrast": elementCheck("[style]", hasLowContrast, "has insufficient text contrast"),
  label: elementCheck("input, select, textarea", lacksLabel, "has no label"),
  "button-name": elementCheck("button", lacksButtonName, "has no accessible name"),
  "html-has-lang": elementCheck("html", lacksLang, "has no lang attribute"),
  "oversized-image": elementCheck("img[src]", isOversized, `is larger than ${OVERSIZED_IMAGE_BYTES} bytes`),
  "unsized-image": elementCheck("img", lacksDimensions, "has no width/height attributes"),
  "render-blocking-script": elementCheck("head script[src]", blocksRender, "blocks rendering"),
  "insecure-form-action": elementCheck("form[action]", postsOverHttp, "posts over plain http"),
  "document-title": checkTitle,
  "meta-description": checkMetaDescription,
  "multiple-h1": checkMultipleH1,
  "robots-txt": rootFileCheck("robots.txt"),
  sitemap: rootFileCheck("sitemap.xml"),
  "missing-csp": headerCheck("content-security-policy"),
  "missing-x-frame-options": headerCheck("x-frame-options"),
  "missing-x-content-type-options": headerCheck("x-content-type-options"),
  "missing-referrer-policy": headerCheck("referrer-policy"),
  "missing-hsts": headerCheck("strict-transport-security"),
  "broken-link": checkBrokenLink,
};

/** Rules spotCheckIssues can verify (others come back "unverifiable"). */
export const SPOT_CHECKABLE_RULES = Object.keys(CHECKS);
