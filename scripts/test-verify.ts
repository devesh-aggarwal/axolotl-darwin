// End-to-end test of src/lib/verify against the local demo site, mock judge only.
// Every request outside the local demo server is blocked (answered as a DNS failure).
// Usage: npx tsx --tsconfig tsconfig.json scripts/test-verify.ts
import { AGENT_TEMPLATES, getTemplate, type NodeTemplate } from "@/config/workflow";
import { normalizeUrl, runCapability } from "@/lib/audit";
import type { AgentNodeInput, AuditOutput, CrawlOutput, Issue, VerificationResult } from "@/lib/types";
import { verifyOutput, type VerifyContext } from "@/lib/verify";
import { checkAuditRules, findFindingRefusal, findPlaceholder, findRefusal, isPlaceholderEvidence } from "@/lib/verify/rules";
import { startDemoServer } from "./serve-demo-site";

/** 0 = the output must pass; 1–4 = the first layer that must fail. */
type ExpectedLayer = 0 | 1 | 2 | 3 | 4;

interface Case {
  name: string;
  expect: ExpectedLayer;
  ctx: VerifyContext;
  /** Extra assertion on the result; returns a problem description or null. */
  check?: (r: VerificationResult) => string | null;
}

interface Row {
  name: string;
  expect: ExpectedLayer;
  actual: ExpectedLayer;
  ok: boolean;
  reason: string;
}

/** Override with VERIFY_TEST_SEED to sweep seeds. */
const SEED = Number(process.env.VERIFY_TEST_SEED) || 7;

// ---------- network guard ----------

const realFetch = globalThis.fetch;
const blockedHosts: string[] = [];

function requestUrl(input: RequestInfo | URL): URL {
  return new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
}

function installFetchGuard(allowedOrigin: string): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    if (url.origin === allowedOrigin) return realFetch(input, init);
    blockedHosts.push(url.host);
    const cause = Object.assign(new Error(`getaddrinfo ENOTFOUND ${url.hostname}`), { code: "ENOTFOUND" });
    throw new TypeError("fetch failed", { cause });
  }) as typeof fetch;
}

// ---------- helpers ----------

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function clipText(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ");
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function failingLayer(r: VerificationResult): ExpectedLayer {
  if (r.pass) return 0;
  const failed = r.layers.find((l) => !l.pass && !l.skipped);
  return (failed?.layer ?? 4) as ExpectedLayer;
}

/** Layers are always 1–4 in order; layers after the failing one are skipped with pass false; the judge is the mock one. */
function structureProblem(r: VerificationResult): string | null {
  if (r.layers.map((l) => l.layer).join(",") !== "1,2,3,4") return `layers out of order: ${r.layers.map((l) => l.layer).join(",")}`;
  const judge = r.layers[3];
  if (!judge.skipped && judge.source !== "mock") return `layer 4 ran with source "${judge.source}", not the mock judge`;
  const actual = failingLayer(r);
  if (actual === 0) return r.layers.every((l) => l.pass && !l.skipped) ? null : "passed with a skipped or failing layer";
  for (const l of r.layers.filter((x) => x.layer > actual)) {
    if (!l.skipped || l.pass || l.reason !== "Skipped: earlier layer failed") return `layer ${l.layer} after the failing layer is not marked skipped`;
  }
  return null;
}

function rowReason(r: VerificationResult): string {
  const actual = failingLayer(r);
  if (actual === 0) {
    const l3 = r.layers[2]?.reason ?? "";
    const l4 = r.layers[3]?.reason ?? "";
    return `L3: ${clipText(l3, 70)} | L4: ${clipText(l4, 60)}`;
  }
  return `L${actual}: ${clipText(r.layers[actual - 1]?.reason ?? "", 150)}`;
}

async function runCase(c: Case): Promise<Row> {
  let r: VerificationResult;
  try {
    r = await verifyOutput(c.ctx);
  } catch (err) {
    return { name: c.name, expect: c.expect, actual: 0, ok: false, reason: `verifyOutput threw: ${(err as Error).message}` };
  }
  const actual = failingLayer(r);
  const problems = [actual === c.expect ? null : `expected ${c.expect ? `layer ${c.expect}` : "pass"}`, structureProblem(r), c.check?.(r) ?? null].filter(
    (p): p is string => p !== null,
  );
  const reason = problems.length > 0 ? `${problems.join("; ")} || ${rowReason(r)}` : rowReason(r);
  return { name: c.name, expect: c.expect, actual, ok: problems.length === 0, reason };
}

function printTable(rows: Row[]): void {
  const w = Math.max(...rows.map((r) => r.name.length), 4);
  const label = (n: ExpectedLayer) => (n === 0 ? "pass" : `L${n}`);
  console.log(`\n${"case".padEnd(w)}  expected  actual  result  reasons`);
  console.log(`${"-".repeat(w)}  --------  ------  ------  ${"-".repeat(60)}`);
  for (const r of rows) {
    console.log(`${r.name.padEnd(w)}  ${label(r.expect).padEnd(8)}  ${label(r.actual).padEnd(6)}  ${(r.ok ? "ok" : "FAIL").padEnd(6)}  ${r.reason}`);
  }
}

// ---------- detector unit checks ----------

function detectorChecks(): Row[] {
  const rows: Row[] = [];
  const add = (name: string, ok: boolean, detail: string) => rows.push({ name, expect: 0, actual: 0, ok, reason: detail });
  const refusals = [
    "I'm sorry, but I can't browse the web.",
    "As an AI language model, I cannot access websites.",
    "Unable to access the website.",
    "The agent was unable to access the site.",
    "Sorry, the page could not be audited.",
  ];
  const findings = [
    "Button has no text, aria-label or title, so screen readers cannot announce what it does.",
    "Users are unable to access the page because the link returns 404.",
    "Search engines cannot crawl the pages without a sitemap.",
    "External link to https://press.tidepool-demo.invalid/coverage does not resolve.",
    "https://press.tidepool-demo.invalid/coverage failed: DNS lookup failed (ENOTFOUND)",
  ];
  const missed = refusals.filter((t) => findRefusal(t) === null);
  add("detector: refusals are caught", missed.length === 0, missed.length ? `missed: ${missed.join(" | ")}` : `${refusals.length} refusal phrasings caught`);
  const falsePositives = findings.filter((t) => findRefusal(t) !== null);
  add(
    "detector: findings are not refusals",
    falsePositives.length === 0,
    falsePositives.length ? `flagged: ${falsePositives.map((t) => `${t} -> ${findRefusal(t)}`).join(" | ")}` : `${findings.length} legitimate findings left alone`,
  );
  const site = "http://127.0.0.1:9/demo-site/";
  const placeholders = [
    "Lorem ipsum dolor sit amet",
    "TODO: fill in",
    "See https://example.com/page",
    "Image https://cdn.example.org/hero.png is 3 MB",
    "{{pageUrl}}",
    "[insert selector]",
  ];
  const placeholderMissed = placeholders.filter((t) => findPlaceholder(t, site) === null);
  add("detector: placeholders are caught", placeholderMissed.length === 0, placeholderMissed.join(" | ") || `${placeholders.length} placeholders caught`);
  const clean = [
    "Email input has no associated label (placeholder only)",
    "Placeholders are not labels.",
    "<input id=\"email\" name=\"email\" type=\"email\" placeholder=\"you@example.com\">",
  ];
  const placeholderFalse = clean.filter((t) => findPlaceholder(t, site) !== null);
  const exampleOk = findPlaceholder("https://example.com/about", "https://example.com/") === null;
  add("detector: placeholder words and example.com sites allowed", placeholderFalse.length === 0 && exampleOk, placeholderFalse.join(" | ") || "ok");
  const evidenceOk = ["N/A", "n/a.", "none", "-", "…"].every(isPlaceholderEvidence) && !isPlaceholderEvidence("<img id=\"hero-img\" src=\"img/hero.png\">");
  add("detector: placeholder evidence", evidenceOk, evidenceOk ? "N/A, none, -, … flagged; real evidence kept" : "mismatch");

  // Findings about unreachable links or blocked crawlers are not refusals; agent apologies still are.
  const findingRefusals = ["I'm sorry, but I can't browse the web.", "As an AI language model, I cannot access websites.", "I am unable to open external URLs."];
  const findingText = [
    "Could not connect to the domain press.tidepool-demo.invalid (DNS lookup failed).",
    "Unable to reach the URL https://press.tidepool-demo.invalid/coverage: ENOTFOUND",
    "Failed to load the page https://site.test/old.html (HTTP 404).",
    "Googlebot cannot access the page because robots.txt disallows it.",
    "Could not fetch the resource /robots.txt (404).",
    "We could not reach https://cdn.site.test/app.js (timeout after 10 s).",
  ];
  const narrowMissed = findingRefusals.filter((t) => findFindingRefusal(t) === null);
  const narrowFlagged = findingText.filter((t) => findFindingRefusal(t) !== null);
  add(
    "detector: findings about unreachable links are not refusals",
    narrowMissed.length === 0 && narrowFlagged.length === 0,
    [...narrowMissed.map((t) => `missed: ${t}`), ...narrowFlagged.map((t) => `flagged: ${t}`)].join(" | ") || `${findingRefusals.length} refusals caught, ${findingText.length} findings left alone`,
  );
  return rows;
}

/** Layer-2 checks on a made-up site, without the network. */
function ruleUnitChecks(): Row[] {
  const rows: Row[] = [];
  const add = (name: string, ok: boolean, detail: string) => rows.push({ name, expect: 0, actual: 0, ok, reason: detail });
  const site = "https://shop.test/";
  const linkIssue = (href: string): Issue => ({
    category: "links",
    severity: "medium",
    rule: "broken-link",
    pageUrl: site,
    description: `Link to ${href} returns 404.`,
    recommendation: "Update the link to a working URL or remove it.",
    evidence: `${href} returned HTTP 404`,
  });
  const linksCtx = { template: getTemplate("links"), input: { siteUrl: site, pages: [site] }, siteUrl: site, crawledPages: [site] };
  const distinct = checkAuditRules(linksCtx, { issues: ["a", "b", "c", "d"].map((p) => linkIssue(`${site}${p}.html`)), pagesChecked: [site] });
  const repeated = checkAuditRules(linksCtx, { issues: [1, 2, 3, 4].map(() => linkIssue(`${site}a.html`)), pagesChecked: [site] });
  const dupOk = distinct.violations.length === 0 && repeated.violations.some((v) => v.includes("duplicate"));
  add("rules: selector-less distinct findings are not duplicates", dupOk, dupOk ? "4 different broken links kept; 4 identical ones flagged" : [...distinct.violations, ...repeated.violations].join(" | ") || "identical repeats not flagged");

  const labelIssue: Issue = {
    category: "accessibility",
    severity: "high",
    rule: "label",
    pageUrl: site,
    selector: "#website",
    description: "URL input #website has no associated label.",
    recommendation: "Associate a visible <label for=\"website\"> with the field.",
    evidence: "<input id=\"website\" type=\"url\" placeholder=\"https://example.com\">",
  };
  const a11yCtx = { template: getTemplate("a11y"), input: { siteUrl: site, pageUrl: site }, siteUrl: site, crawledPages: [site] };
  const attr = checkAuditRules(a11yCtx, { issues: [labelIssue], pagesChecked: [site] });
  const prose = checkAuditRules(a11yCtx, { issues: [{ ...labelIssue, description: "Input on https://example.com/signup has no label." }], pagesChecked: [site] });
  const attrOk = attr.violations.length === 0 && prose.violations.some((v) => v.includes("placeholder text"));
  add("rules: example.com in a placeholder attribute is page content", attrOk, attrOk ? "placeholder=\"https://example.com\" kept; example.com in prose flagged" : [...attr.violations, ...prose.violations].join(" | ") || "prose not flagged");
  return rows;
}

// ---------- cases ----------

interface Fixture {
  site: string;
  origin: string;
  crawl: CrawlOutput;
  /** Crawl of the server root, which redirects to /demo-site/ (not the demo site URL, so no ground truth). */
  rootCrawl: CrawlOutput;
  pages: string[];
  clean: Map<string, AuditOutput>;
}

function page(f: Fixture, rel: string): string {
  return normalizeUrl(rel, f.site);
}

function inputFor(f: Fixture, t: NodeTemplate, pageUrl?: string): AgentNodeInput {
  if (t.id === "crawl") return { siteUrl: f.site, maxPages: 5 };
  if (t.scope === "page") return { siteUrl: f.site, pageUrl: pageUrl ?? f.site };
  return { siteUrl: f.site, pages: f.pages };
}

interface CtxOptions {
  pageUrl?: string;
  input?: AgentNodeInput;
  siteUrl?: string;
  crawledPages?: string[];
  seed?: number;
}

function ctxFor(f: Fixture, templateId: string, output: unknown, opts: CtxOptions = {}): VerifyContext {
  const template = getTemplate(templateId);
  return {
    template,
    input: opts.input ?? inputFor(f, template, opts.pageUrl),
    output,
    siteUrl: opts.siteUrl ?? f.site,
    crawledPages: opts.crawledPages ?? (templateId === "crawl" ? [] : f.pages),
    seed: opts.seed ?? SEED,
    llmMode: "mock",
  };
}

function cleanKey(templateId: string, pageUrl?: string): string {
  return pageUrl ? `${templateId}|${pageUrl}` : templateId;
}

function cleanOf(f: Fixture, templateId: string, pageUrl?: string): AuditOutput {
  const out = f.clean.get(cleanKey(templateId, pageUrl));
  if (!out) throw new Error(`no clean output for ${cleanKey(templateId, pageUrl)}`);
  return clone(out);
}

async function buildFixture(origin: string): Promise<Fixture> {
  const site = `${origin}/demo-site/`;
  const crawl = (await runCapability("crawl", { siteUrl: site, maxPages: 5 })) as CrawlOutput;
  const rootCrawl = (await runCapability("crawl", { siteUrl: `${origin}/`, maxPages: 5 })) as CrawlOutput;
  const pages = crawl.pages.map((p) => p.url);
  const f: Fixture = { site, origin, crawl, rootCrawl, pages, clean: new Map() };
  for (const t of AGENT_TEMPLATES.filter((x) => x.id !== "crawl")) {
    const targets = t.scope === "page" ? pages : [undefined];
    for (const pageUrl of targets) {
      const out = (await runCapability(t.capability!, inputFor(f, t, pageUrl))) as AuditOutput;
      f.clean.set(cleanKey(t.id, pageUrl), out);
    }
  }
  return f;
}

function recallCheck(want: (ratio: number) => boolean, label: string): (r: VerificationResult) => string | null {
  return (r) => (r.recall && want(r.recall.ratio) ? null : `recall ${label} (got ${r.recall ? `${r.recall.found}/${r.recall.expected}` : "none"})`);
}

function reasonIncludes(layer: number, text: string): (r: VerificationResult) => string | null {
  return (r) => (r.layers[layer - 1]?.reason.includes(text) ? null : `layer ${layer} reason lacks "${text}"`);
}

function cleanCases(f: Fixture): Case[] {
  const cases: Case[] = [{ name: "crawl: clean output", expect: 0, ctx: ctxFor(f, "crawl", clone(f.crawl)) }];
  for (const t of AGENT_TEMPLATES.filter((x) => x.id !== "crawl")) {
    const targets = t.scope === "page" ? f.pages : [undefined];
    for (const pageUrl of targets) {
      const where = pageUrl ? ` ${pageUrl.slice(f.site.length - 1) || "/"}` : "";
      cases.push({
        name: `${t.id}: clean output${where}`,
        expect: 0,
        ctx: ctxFor(f, t.id, cleanOf(f, t.id, pageUrl), { pageUrl }),
        check: recallCheck((x) => x === 1, "should be 1"),
      });
    }
  }
  return cases;
}

function layer1Cases(f: Fixture): Case[] {
  const home = page(f, "");
  const broken = cleanOf(f, "a11y", home) as unknown as Record<string, unknown>;
  const issues = broken.issues as Record<string, unknown>[];
  issues[0].pageUrl = "/index.html";
  issues[0].severity = "urgent";
  delete broken.pagesChecked;
  const throwing = new Proxy(
    {},
    {
      get() {
        throw new Error("agent output exploded (token sk-test1234567890abcdef)");
      },
      has() {
        throw new Error("agent output exploded (token sk-test1234567890abcdef)");
      },
    },
  );
  return [
    {
      name: "audit: schema-broken output",
      expect: 1,
      ctx: ctxFor(f, "a11y", broken, { pageUrl: home }),
      check: reasonIncludes(1, "issues.0.pageUrl"),
    },
    { name: "audit: plain-text output", expect: 1, ctx: ctxFor(f, "seo", "I audited the site and found some issues.") },
    { name: "crawl: empty pages", expect: 1, ctx: ctxFor(f, "crawl", { pages: [] }) },
    {
      name: "verifier error is caught, secret redacted",
      expect: 1,
      ctx: ctxFor(f, "a11y", throwing, { pageUrl: home }),
      check: (r) => {
        const reason = r.layers[0].reason;
        if (!reason.startsWith("verifier error:")) return "reason is not a verifier error";
        return reason.includes("sk-test") ? "secret leaked into reason" : null;
      },
    },
  ];
}

function withIssue(out: AuditOutput, i: number, patch: Partial<Issue>): AuditOutput {
  out.issues[i] = { ...out.issues[i], ...patch };
  return out;
}

function layer2AuditCases(f: Fixture): Case[] {
  const home = page(f, "");
  const about = page(f, "about.html");
  const blog = page(f, "blog.html");
  const fakePaths = ["careers.html", "checkout/", "admin/login", "pricing-enterprise.html", "legal/terms.html"];
  const seoHallucinated = cleanOf(f, "seo");
  seoHallucinated.issues = seoHallucinated.issues.map((issue, i) => ({ ...issue, pageUrl: page(f, fakePaths[i % fakePaths.length]) }));
  const staging = `${f.origin}/staging/`;
  const dup = cleanOf(f, "a11y", home);
  dup.issues = [...dup.issues, dup.issues[0], dup.issues[0], dup.issues[0]];
  const dupTwo = cleanOf(f, "a11y", home);
  dupTwo.issues = [...dupTwo.issues, dupTwo.issues[0], dupTwo.issues[0]];
  const offPage = cleanOf(f, "a11y", about);
  offPage.issues.push({ ...cleanOf(f, "a11y", home).issues[0] });
  const noPage = cleanOf(f, "a11y", about);
  noPage.pagesChecked = [];

  return [
    { name: "audit: wrong category", expect: 2, ctx: ctxFor(f, "a11y", withIssue(cleanOf(f, "a11y", home), 1, { category: "seo" }), { pageUrl: home }) },
    {
      name: "audit: hallucinated pages",
      expect: 2,
      ctx: ctxFor(f, "seo", seoHallucinated),
      check: reasonIncludes(2, "never crawled"),
    },
    {
      name: "audit: refusal summary, zero issues (demo)",
      expect: 2,
      ctx: ctxFor(f, "a11y", { issues: [], pagesChecked: [blog], summary: "I'm sorry, but I can't access external websites, so I cannot audit this page." }, { pageUrl: blog }),
      check: reasonIncludes(2, "refusal"),
    },
    {
      name: "audit: refusal summary, zero issues (other site)",
      expect: 2,
      ctx: ctxFor(f, "a11y", { issues: [], pagesChecked: [staging], summary: "Unable to access the website." }, {
        siteUrl: staging,
        input: { siteUrl: staging, pageUrl: staging },
        crawledPages: [staging],
      }),
    },
    {
      name: "audit: zero issues on page with planted problems",
      expect: 2,
      ctx: ctxFor(f, "a11y", { issues: [], pagesChecked: [about], summary: "0 accessibility issues across 1 page." }, { pageUrl: about }),
      check: reasonIncludes(2, "GT-09"),
    },
    {
      name: "audit: zero issues on site node with planted problems",
      expect: 2,
      ctx: ctxFor(f, "links", { issues: [], pagesChecked: f.pages, summary: "All links work." }),
    },
    { name: "audit: unknown rule code", expect: 2, ctx: ctxFor(f, "a11y", withIssue(cleanOf(f, "a11y", home), 0, { rule: "alt-text-missing" }), { pageUrl: home }) },
    { name: "audit: rule from another category", expect: 2, ctx: ctxFor(f, "a11y", withIssue(cleanOf(f, "a11y", home), 0, { rule: "meta-description" }), { pageUrl: home }) },
    {
      name: "audit: lorem ipsum description",
      expect: 2,
      ctx: ctxFor(f, "a11y", withIssue(cleanOf(f, "a11y", home), 0, { description: "Lorem ipsum dolor sit amet." }), { pageUrl: home }),
    },
    {
      name: "audit: example.com in evidence",
      expect: 2,
      ctx: ctxFor(f, "a11y", withIssue(cleanOf(f, "a11y", home), 0, { evidence: "<img src=\"https://example.com/hero.png\">" }), { pageUrl: home }),
    },
    { name: "audit: N/A evidence", expect: 2, ctx: ctxFor(f, "a11y", withIssue(cleanOf(f, "a11y", home), 0, { evidence: "N/A" }), { pageUrl: home }) },
    { name: "audit: blank description", expect: 2, ctx: ctxFor(f, "a11y", withIssue(cleanOf(f, "a11y", home), 0, { description: "   " }), { pageUrl: home }) },
    { name: "audit: page-node issue on another page", expect: 2, ctx: ctxFor(f, "a11y", offPage, { pageUrl: about }) },
    { name: "audit: pagesChecked misses node page", expect: 2, ctx: ctxFor(f, "a11y", noPage, { pageUrl: about }) },
    { name: "audit: 3 duplicate issues", expect: 2, ctx: ctxFor(f, "a11y", dup, { pageUrl: home }), check: reasonIncludes(2, "duplicate") },
    {
      name: "audit: 2 duplicates pass rules, judge flags them",
      expect: 4,
      ctx: ctxFor(f, "a11y", dupTwo, { pageUrl: home }),
      check: (r) => (r.layers[1].pass ? null : "layer 2 should tolerate 2 duplicates"),
    },
  ];
}

function layer3AuditCases(f: Fixture): Case[] {
  const home = page(f, "");
  const about = page(f, "about.html");
  const fabricated = cleanOf(f, "a11y", home);
  fabricated.issues.push({
    category: "accessibility",
    severity: "high",
    rule: "image-alt",
    pageUrl: home,
    selector: "header img",
    description: "Logo image img/logo.png has no alt attribute.",
    recommendation: "Add an alt attribute that describes the image.",
    evidence: "<img src=\"img/logo.png\" width=\"80\" height=\"50\">",
  });
  const links = cleanOf(f, "links");
  const realLinks = links.issues.filter((i) => [home, about].includes(normalizeUrl(i.pageUrl)));
  links.issues = [
    ...realLinks,
    {
      category: "links",
      severity: "medium",
      rule: "broken-link",
      pageUrl: about,
      selector: "a[href=\"contact.html\"]",
      description: "Internal link to contact.html returns 404.",
      recommendation: "Update the link to a working URL or remove it.",
      evidence: `${page(f, "contact.html")} returned HTTP 404`,
    },
  ];
  const seoPlusOne = cleanOf(f, "seo");
  seoPlusOne.issues.splice(3, 0, {
    category: "seo",
    severity: "high",
    rule: "document-title",
    pageUrl: page(f, "pricing.html"),
    description: "Page /pricing.html has no <title> element.",
    recommendation: "Add a unique, descriptive <title> to the page's <head>.",
    evidence: "No <title> element in the document.",
  });
  const indexHtml = cleanOf(f, "a11y", home);
  indexHtml.issues = indexHtml.issues.map((i) => ({ ...i, pageUrl: `${f.site}index.html` }));
  indexHtml.pagesChecked = [`${f.site}index.html`];
  const lowRecall = cleanOf(f, "seo");
  const seoCount = lowRecall.issues.length;
  lowRecall.issues = lowRecall.issues.slice(0, 1);
  const homeOnly = [home];
  const linksHome = f.clean.get("links|home-only");

  const cases: Case[] = [
    {
      name: "audit: fabricated image-alt on logo",
      expect: 3,
      ctx: ctxFor(f, "a11y", fabricated, { pageUrl: home }),
      check: reasonIncludes(3, "refuted image-alt"),
    },
    {
      name: "audit: fabricated broken link (link works)",
      expect: 3,
      ctx: ctxFor(f, "links", links),
      check: reasonIncludes(3, "refuted broken-link"),
    },
    {
      name: "audit: 1 fabricated claim among 6 real ones",
      expect: 3,
      ctx: ctxFor(f, "seo", seoPlusOne),
      check: reasonIncludes(3, "refuted document-title on /pricing.html"),
    },
    {
      name: "audit: issues on .../index.html count as home",
      expect: 0,
      ctx: ctxFor(f, "a11y", indexHtml, { pageUrl: home }),
      check: recallCheck((x) => x === 1, "should be 1"),
    },
    {
      name: `audit: low recall (1 of ${seoCount} SEO issues)`,
      expect: 3,
      ctx: ctxFor(f, "seo", lowRecall),
      check: (r) => (seoCount === 6 ? recallCheck((x) => x < 0.5, "should be below 0.5")(r) : `clean SEO output has ${seoCount} issues, not 6`),
    },
    {
      name: "audit: zero issues on other site (passes)",
      expect: 0,
      ctx: ctxFor(f, "a11y", { issues: [], pagesChecked: [`${f.origin}/staging/`], summary: "0 accessibility issues across 1 page." }, {
        siteUrl: `${f.origin}/staging/`,
        input: { siteUrl: `${f.origin}/staging/`, pageUrl: `${f.origin}/staging/` },
        crawledPages: [`${f.origin}/staging/`],
      }),
      check: (r) => (r.recall === undefined ? null : "recall should be absent off the demo site"),
    },
  ];
  if (linksHome) {
    cases.push({
      name: "audit: links on a 1-page crawl (scoped recall)",
      expect: 0,
      ctx: ctxFor(f, "links", clone(linksHome), { input: { siteUrl: f.site, pages: homeOnly }, crawledPages: homeOnly }),
      check: recallCheck((x) => x === 1, "should be 1 within the node's pages"),
    });
  }
  return cases;
}

/** Wording and secret-handling regressions. */
function wordingCases(f: Fixture): Case[] {
  const home = page(f, "");
  const about = page(f, "about.html");
  const press = "https://press.tidepool-demo.invalid/coverage";

  // A links agent that words its DNS and 404 results as "could not connect / failed to load".
  const worded = cleanOf(f, "links");
  worded.issues = worded.issues.map((issue) => {
    const where = normalizeUrl(issue.pageUrl);
    if (where === about) return { ...issue, evidence: `Could not connect to the domain press.tidepool-demo.invalid (DNS lookup failed) for ${press}.` };
    if (where === home) return { ...issue, evidence: `Failed to load the page ${page(f, "pricing-2023.html")} (HTTP 404).` };
    return issue;
  });
  worded.summary = `${worded.issues.length} broken links. Unable to reach the URL ${press}: ENOTFOUND.`;

  const leaky = cleanOf(f, "links");
  const tokenUrl = "https://cdn.tidepool-demo.invalid/app.js?token=sk-live1234567890abcdefXYZ";
  leaky.issues.push({
    category: "links",
    severity: "low",
    rule: "broken-link",
    pageUrl: home,
    selector: `a[href="${tokenUrl}"]`,
    description: "External link to https://cdn.tidepool-demo.invalid/app.js does not resolve.",
    recommendation: "Update the link to a working URL or remove it.",
    evidence: `${tokenUrl} failed: DNS lookup failed (ENOTFOUND)`,
  });

  return [
    {
      name: "links: 'could not connect' wording is a finding",
      expect: 0,
      ctx: ctxFor(f, "links", worded),
      check: recallCheck((x) => x === 1, "should be 1"),
    },
    {
      name: "audit: first-person refusal inside an issue",
      expect: 2,
      ctx: ctxFor(f, "a11y", withIssue(cleanOf(f, "a11y", home), 0, { description: "I'm sorry, but I cannot access this page to check its images." }), { pageUrl: home }),
      check: reasonIncludes(2, "refusal"),
    },
    {
      name: "secrets stripped from reasons and details",
      expect: 3,
      ctx: ctxFor(f, "links", leaky),
      check: (r) => (/sk-live|token=/.test(JSON.stringify(r)) ? "token-shaped text survived in the result" : reasonIncludes(3, "refuted broken-link")(r)),
    },
  ];
}

function crawlCases(f: Fixture): Case[] {
  const pages = clone(f.crawl.pages);
  const hallucinated = { pages: pages.map((p, i) => (i === pages.length - 1 ? { url: page(f, "careers.html"), title: "Careers", status: 200 } : p)) };
  const overCap = { pages: [...clone(pages), { url: page(f, "careers.html"), title: "Careers", status: 200 }, { url: page(f, "checkout/"), title: "Checkout", status: 200 }] };
  const offSite = { pages: [...clone(pages).slice(0, 4), { url: "https://other-site.test/about.html", title: "About", status: 200 }] };
  const notFound = { pages: clone(pages).map((p, i) => (i === 1 ? { ...p, status: 404 } : p)) };
  const duplicate = { pages: [...clone(pages).slice(0, 4), { ...pages[1], url: `${pages[1].url}#team` }] };
  const noHome = { pages: clone(pages).slice(1) };
  const refusalTitle = { pages: clone(pages).map((p, i) => (i === 2 ? { ...p, title: "I'm sorry, I cannot browse this website" } : p)) };
  const sparse = { pages: clone(pages).slice(0, 2) };
  return [
    {
      name: "crawl: hallucinated same-origin page",
      expect: 3,
      ctx: ctxFor(f, "crawl", hallucinated),
      check: reasonIncludes(3, "careers.html returned HTTP 404"),
    },
    { name: "crawl: invented pages beyond the cap", expect: 2, ctx: ctxFor(f, "crawl", overCap) },
    { name: "crawl: off-site page", expect: 2, ctx: ctxFor(f, "crawl", offSite) },
    { name: "crawl: page with status 404", expect: 2, ctx: ctxFor(f, "crawl", notFound) },
    { name: "crawl: duplicate page", expect: 2, ctx: ctxFor(f, "crawl", duplicate) },
    { name: "crawl: home page missing", expect: 3, ctx: ctxFor(f, "crawl", noHome), check: reasonIncludes(3, "home page / is not listed") },
    { name: "crawl: refusal as a page title", expect: 2, ctx: ctxFor(f, "crawl", refusalTitle) },
    { name: "crawl: 2 of 5 ground-truth pages", expect: 3, ctx: ctxFor(f, "crawl", sparse), check: reasonIncludes(3, "ground-truth pages") },
    ...redirectCrawlCases(f),
  ];
}

/** The server root redirects to /demo-site/; a crawl that follows it starts there. */
function redirectCrawlCases(f: Fixture): Case[] {
  const root = `${f.origin}/`;
  const input = { siteUrl: root, maxPages: 5 };
  return [
    {
      name: "crawl: site root redirects, home is the target",
      expect: 0,
      ctx: ctxFor(f, "crawl", clone(f.rootCrawl), { siteUrl: root, input }),
      check: () => (normalizeUrl(f.rootCrawl.pages[0]?.url ?? "") === f.site ? null : `root crawl did not start at ${f.site}`),
    },
    {
      name: "crawl: site root redirects, home missing",
      expect: 3,
      ctx: ctxFor(f, "crawl", { pages: clone(f.rootCrawl.pages).slice(1) }, { siteUrl: root, input }),
      check: reasonIncludes(3, "where it redirects"),
    },
  ];
}

/** Off the demo site there is no ground truth to prioritize by, so every listed page must be re-fetched. */
async function inventedPageChecks(f: Fixture): Promise<Row[]> {
  const root = `${f.origin}/`;
  const output = { pages: [...clone(f.rootCrawl.pages), { url: page(f, "features.html"), title: "Features — Tidepool", status: 200 }] };
  const seeds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const missed: number[] = [];
  for (const seed of seeds) {
    const r = await verifyOutput(ctxFor(f, "crawl", clone(output), { siteUrl: root, input: { siteUrl: root, maxPages: 10 }, seed }));
    if (failingLayer(r) !== 3 || !r.layers[2].reason.includes("features.html returned HTTP 404")) missed.push(seed);
  }
  return [
    {
      name: "crawl: invented page under the cap, any seed",
      expect: 3,
      actual: missed.length === 0 ? 3 : 0,
      ok: missed.length === 0,
      reason: missed.length === 0 ? `caught at layer 3 on all ${seeds.length} seeds` : `not caught on seeds ${missed.join(", ")}`,
    },
  ];
}

// ---------- main ----------

async function main(): Promise<void> {
  const server = await startDemoServer(0);
  installFetchGuard(server.origin);
  const rows: Row[] = [];
  try {
    const f = await buildFixture(server.origin);
    console.log(`Demo site ${f.site}: crawl found ${f.pages.length} pages; ${f.clean.size} clean audit outputs.`);
    const home = page(f, "");
    f.clean.set("links|home-only", (await runCapability("links", { siteUrl: f.site, pages: [home] })) as AuditOutput);

    rows.push(...detectorChecks(), ...ruleUnitChecks());
    const cases = [...cleanCases(f), ...layer1Cases(f), ...layer2AuditCases(f), ...layer3AuditCases(f), ...wordingCases(f), ...crawlCases(f)];
    for (const c of cases) rows.push(await runCase(c));
    rows.push(...(await inventedPageChecks(f)));

    const fabricated = layer3AuditCases(f)[0];
    const [a, b] = [await verifyOutput(fabricated.ctx), await verifyOutput(fabricated.ctx)];
    const same = JSON.stringify(a) === JSON.stringify(b);
    rows.push({ name: "determinism: same ctx, same verdict", expect: 0, actual: 0, ok: same, reason: same ? "identical results" : "results differ" });
  } finally {
    globalThis.fetch = realFetch;
    await server.close();
  }

  const forbidden = blockedHosts.filter((h) => /openai|darwin/i.test(h));
  rows.push({
    name: "network: no LLM or Darwin requests",
    expect: 0,
    actual: 0,
    ok: forbidden.length === 0,
    reason: forbidden.length ? `attempted: ${[...new Set(forbidden)].join(", ")}` : `blocked off-site hosts: ${[...new Set(blockedHosts)].join(", ") || "none"}`,
  });

  printTable(rows);
  const failed = rows.filter((r) => !r.ok);
  console.log(`\n${rows.length - failed.length}/${rows.length} checks passed.`);
  if (failed.length > 0) {
    console.log(`FAILED: ${failed.map((r) => r.name).join(", ")}`);
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(`test-verify crashed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exitCode = 1;
});
