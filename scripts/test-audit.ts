// End-to-end test of src/lib/audit against the local demo site. Exits non-zero on any failure.
// Usage: npx tsx --tsconfig tsconfig.json scripts/test-audit.ts
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { AuditOutputSchema, CrawlOutputSchema } from "@/lib/contracts";
import type { AuditOutput, Capability, CrawlOutput, Issue } from "@/lib/types";
import {
  RULES,
  auditPage,
  auditSite,
  buildIssue,
  checkUrl,
  clearFetchCache,
  crawlSite,
  expectedIssues,
  expectedPages,
  fetchPage,
  getRule,
  hrefFromLinkSelector,
  isDemoSite,
  mapLimit,
  matchesGroundTruth,
  measureRecall,
  normalizeUrl,
  parseCssColor,
  readDemoSiteFile,
  runCapability,
  siteRootUrl,
  spotCheckIssues,
  unmatchedIssues,
  verifyClaim,
  type SpotCheckVerdict,
} from "@/lib/audit";
import { startDemoServer } from "./serve-demo-site";

interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

const checks: Check[] = [];

function expect(name: string, pass: boolean, detail = ""): void {
  checks.push({ name, pass, detail });
}

function short(url: string, siteUrl: string): string {
  return url.startsWith(siteUrl) ? `/${url.slice(siteUrl.length)}` : url;
}

// ---------- pure helpers ----------

function testUrlHelpers(): void {
  const cases: [string, string | undefined, string][] = [
    ["http://Example.com/demo-site/index.html?x=1#top", undefined, "http://example.com/demo-site/"],
    ["about.html#team", "http://h.test/demo-site/", "http://h.test/demo-site/about.html"],
    ["./", "http://h.test/demo-site/about.html", "http://h.test/demo-site/"],
    ["index.html", "http://h.test/demo-site/", "http://h.test/demo-site/"],
    ["http://h.test/a/index.htmlx", undefined, "http://h.test/a/index.htmlx"],
    ["https://h.test/a/b.html?utm=1", undefined, "https://h.test/a/b.html"],
  ];
  const bad = cases.filter(([input, base, want]) => normalizeUrl(input, base) !== want);
  expect("normalizeUrl cases", bad.length === 0, bad.map(([i, b]) => `${i} @ ${b} -> ${normalizeUrl(i, b)}`).join("; "));
  expect(
    "siteRootUrl adds a trailing slash to directories",
    siteRootUrl("http://h.test/demo-site") === "http://h.test/demo-site/" && siteRootUrl("https://h.test") === "https://h.test/",
  );
  expect(
    "isDemoSite",
    isDemoSite("http://localhost:3000/demo-site") && isDemoSite("http://127.0.0.1:9/demo-site/index.html") && !isDemoSite("https://example.com/"),
  );
  const selectors: [string, string | null][] = [
    ["a[href=\"pricing-2023.html\"]", "pricing-2023.html"],
    ["a[href='say \\\"hi\\\"']", "say \"hi\""],
    ["a[href=\"x\\\\a.html\"]", "x\\a.html"],
    ["a[href=\"line\\a break\"]", "line\nbreak"],
    ["#hero-img", null],
  ];
  const badSelectors = selectors.filter(([s, want]) => hrefFromLinkSelector(s) !== want);
  expect("hrefFromLinkSelector undoes CSS escapes in one pass", badSelectors.length === 0, badSelectors.map(([s]) => `${s} -> ${hrefFromLinkSelector(s)}`).join("; "));
}

/** Rule codes and color names that collide with Object.prototype members must not resolve. */
async function testPrototypeKeys(): Promise<void> {
  const keys = ["constructor", "toString", "hasOwnProperty", "__proto__", "valueOf"];
  expect("RULES / getRule ignore Object.prototype keys", keys.every((k) => RULES[k] === undefined && getRule(k) === undefined));
  let threw = "";
  try {
    buildIssue("constructor", { pageUrl: "http://h.test/", description: "x", evidence: "" });
  } catch (err) {
    threw = (err as Error).message;
  }
  expect("buildIssue rejects prototype rule codes", threw.startsWith("Unknown audit rule"));
  expect("parseCssColor ignores prototype keys", keys.every((k) => parseCssColor(k) === null));
  const verdicts = await Promise.all(
    keys.map((rule) => verifyClaim({ category: "seo", severity: "low", rule, pageUrl: "http://127.0.0.1:1/", description: "x", recommendation: "x", evidence: "" })),
  );
  expect("verifyClaim: prototype rule codes are unverifiable", verdicts.every((v) => v.verdict === "unverifiable"), verdicts.map((v) => JSON.stringify(v).slice(0, 60)).join("; "));
}

/** ground-truth.json stays private under case variants, symlinks and hard links; symlinks cannot leave the site. */
function testDemoSitePrivacy(): void {
  const variants = ["GROUND-TRUTH.json", "Ground-Truth.JSON", "ground-truth.JSON", "css/../GROUND-TRUTH.JSON"];
  const leaked = variants.filter((p) => readDemoSiteFile(p).status !== 404);
  expect("readDemoSiteFile: case variants of ground-truth.json are 404", leaked.length === 0, leaked.join(", "));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "axolotl-demo-"));
  const previous = process.env.DEMO_SITE_DIR;
  try {
    const site = path.join(tmp, "site");
    fs.mkdirSync(site);
    fs.writeFileSync(path.join(site, "index.html"), "<html><title>t</title></html>");
    fs.writeFileSync(path.join(site, "ground-truth.json"), "{\"secret\":true}");
    fs.writeFileSync(path.join(tmp, "outside.txt"), "outside");
    fs.symlinkSync(path.join(site, "ground-truth.json"), path.join(site, "answers.json"));
    fs.symlinkSync(path.join(tmp, "outside.txt"), path.join(site, "outside.txt"));
    fs.symlinkSync(tmp, path.join(site, "up"));
    fs.linkSync(path.join(site, "ground-truth.json"), path.join(site, "copy.json"));
    process.env.DEMO_SITE_DIR = site;
    const blocked = ["answers.json", "outside.txt", "up/outside.txt", "up/site/ground-truth.json", "copy.json", "ground-truth.json"];
    const served = blocked.filter((p) => readDemoSiteFile(p).status !== 404);
    expect("readDemoSiteFile: symlinks and hard links cannot reach private or outside files", served.length === 0, served.join(", "));
    expect("readDemoSiteFile: a custom DEMO_SITE_DIR still serves its index", readDemoSiteFile("").status === 200);
  } finally {
    if (previous === undefined) delete process.env.DEMO_SITE_DIR;
    else process.env.DEMO_SITE_DIR = previous;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function testDemoSiteFiles(): void {
  const home = readDemoSiteFile("");
  expect("readDemoSiteFile('') serves index.html", home.status === 200 && home.contentType.startsWith("text/html") && home.body.toString().includes("<title>Tidepool"));
  const types: [string, string][] = [
    ["about.html", "text/html"],
    ["css/site.css", "text/css"],
    ["js/analytics.js", "text/javascript"],
    ["img/hero.png", "image/png"],
  ];
  const wrongTypes = types.filter(([p, t]) => {
    const f = readDemoSiteFile(p);
    return f.status !== 200 || !f.contentType.startsWith(t);
  });
  expect("readDemoSiteFile content types", wrongTypes.length === 0, wrongTypes.map(([p]) => p).join(", "));
  const blocked = ["../.env", "../../.env", "css/../../.env", "..\\.env", "/../.env", ".env", "ground-truth.json", "./ground-truth.json", "missing.html", "a\0b"];
  const leaked = blocked.filter((p) => readDemoSiteFile(p).status !== 404);
  expect("readDemoSiteFile blocks traversal, dotfiles and ground truth (404)", leaked.length === 0, leaked.join(", "));
  const missing = readDemoSiteFile("../.env");
  expect("404 is a small HTML page", missing.contentType.startsWith("text/html") && missing.body.length < 1024 && missing.body.toString().includes("404"));
}

async function testServer(origin: string): Promise<void> {
  const redirect = await fetch(`${origin}/demo-site`, { redirect: "manual" });
  await redirect.body?.cancel();
  expect("server redirects /demo-site to /demo-site/", redirect.status === 301 && redirect.headers.get("location") === "/demo-site/");
  const traversal = await fetch(`${origin}/demo-site/..%2F.env`);
  const traversalBody = await traversal.text();
  expect("server: encoded traversal is a 404", traversal.status === 404 && traversalBody.includes("404 Not Found"));
  const answers = await fetch(`${origin}/demo-site/ground-truth.json`);
  await answers.body?.cancel();
  expect("server: ground-truth.json is a 404", answers.status === 404);
  const sneaky = ["GROUND-TRUTH.JSON", "%67round-truth.json", "css/%2e%2e/ground-truth.json", "%2e%2e/package.json", "..%5c.env"];
  const sneakyStatuses = await Promise.all(
    sneaky.map(async (p) => {
      const res = await fetch(`${origin}/demo-site/${p}`);
      await res.body?.cancel();
      return res.status;
    }),
  );
  expect("server: encoded, case-variant and backslash paths to private files are 404", sneakyStatuses.every((s) => s === 404), sneaky.map((p, i) => `${p}=${sneakyStatuses[i]}`).join(", "));
  const head = await fetch(`${origin}/demo-site/img/hero.png`, { method: "HEAD" });
  expect("server: HEAD reports content-length", head.status === 200 && head.headers.get("content-length") === "3015651");
  const home = await fetch(`${origin}/demo-site/`);
  await home.body?.cancel();
  const securityHeaders = ["content-security-policy", "x-frame-options", "x-content-type-options", "referrer-policy", "strict-transport-security"];
  const present = securityHeaders.filter((h) => home.headers.has(h));
  expect("server sends no security headers", home.status === 200 && present.length === 0, present.join(", "));
}

/** Fetcher behavior against a throwaway server: GET fallback, byte counting, dedupe, no throws. */
async function testFetcher(): Promise<void> {
  const hits: Record<string, number> = {};
  const server = http.createServer((req, res) => {
    const key = `${req.method} ${req.url}`;
    hits[key] = (hits[key] ?? 0) + 1;
    if (req.url === "/no-head" && req.method === "HEAD") {
      res.writeHead(405).end();
      return;
    }
    if (req.url === "/no-head") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("x".repeat(600));
      res.end("y".repeat(400));
      return;
    }
    if (req.url === "/page") {
      res.writeHead(200, { "Content-Type": "text/html", "X-Custom-Header": "yes" }).end("<html><title>t</title></html>");
      return;
    }
    if (req.url === "/head-404") {
      // A server that mishandles HEAD: the page itself works.
      if (req.method === "HEAD") res.writeHead(404).end();
      else res.writeHead(200, { "content-type": "text/plain" }).end("fine");
      return;
    }
    res.writeHead(404, { "content-type": "text/html" }).end("nope");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const fallback = await checkUrl(`${origin}/no-head`);
    expect("checkUrl falls back to GET on 405 and counts bytes", fallback.status === 200 && fallback.ok && fallback.bytes === 1000 && hits["GET /no-head"] === 1);
    const [p1, p2] = await Promise.all([fetchPage(`${origin}/page`), fetchPage(`${origin}/page#x`)]);
    await fetchPage(`${origin}/page`);
    expect("fetchPage dedupes in-flight requests and caches", p1 === p2 && hits["GET /page"] === 1);
    expect("fetchPage lower-cases header names", p1.headers["x-custom-header"] === "yes" && p1.html.includes("<title>t</title>"));
    const missing = await fetchPage(`${origin}/missing`);
    const missingCheck = await checkUrl(`${origin}/missing`);
    expect("HTTP errors are results, not exceptions", missing.status === 404 && missingCheck.status === 404 && !missingCheck.ok);
    expect("checkUrl confirms a HEAD 404 with GET before calling it broken", missingCheck.status === 404 && hits["GET /missing"] >= 1);
    const headBroken = await checkUrl(`${origin}/head-404`);
    expect("checkUrl: HEAD 404 but GET 200 is ok", headBroken.status === 200 && headBroken.ok, JSON.stringify(headBroken));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
  }
  const refused = await checkUrl(`${origin}/gone`);
  expect("connection failure gives status null", refused.status === null && !refused.ok && /connection refused/.test(refused.error ?? ""), refused.error ?? "");
  const withCreds = await checkUrl("http://user:s3cretPass@127.0.0.1:1/x?token=abc123");
  const credsPage = await fetchPage("http://user:s3cretPass@127.0.0.1:1/y");
  const errors = `${withCreds.error ?? ""} ${credsPage.error ?? ""}`;
  expect("fetch errors never echo URL credentials or query tokens", withCreds.status === null && !/s3cretPass|abc123/.test(errors), errors);
  const filled = await mapLimit([1, 2, 3], Number.NaN, async (n) => n * 2);
  expect("mapLimit with a NaN limit still runs every item", filled.join(",") === "2,4,6");
}

/**
 * Real-site edge cases against two throwaway servers: a root that redirects to another origin,
 * a CDN-hosted heavy image, robots.txt listing a dead sitemap, and inline colors the demo site
 * does not use (rgba, pt/% font sizes, a prototype key).
 */
async function testRealSiteEdgeCases(): Promise<void> {
  const cdn = http.createServer((req, res) => {
    if (req.url === "/big.png") {
      res.writeHead(200, { "content-type": "image/png", "content-length": "600000" });
      res.end(req.method === "HEAD" ? undefined : Buffer.alloc(600_000));
      return;
    }
    res.writeHead(301, { location: `${siteOrigin}${req.url ?? "/"}` }).end();
  });
  const site = http.createServer((req, res) => {
    const html = (body: string) => res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><html lang="en"><head><title>t</title></head><body>${body}</body></html>`);
    switch (req.url) {
      case "/":
        return html("<a href=\"/p2.html\">p2</a>");
      case "/p2.html":
        return html("<p>two</p>");
      case "/style.html":
        return html(
          "<p id=\"bad\" style=\"color: constructor\">x</p>" +
            "<p id=\"faint\" style=\"color: rgba(0,0,0,0.2)\">faint</p>" +
            "<p id=\"big\" style=\"color:#949494;font-size:24pt\">big</p>" +
            "<p id=\"pct\" style=\"color:#949494;font-size:150%\">pct</p>",
        );
      case "/images.html":
        return html(`<img id="cdn" src="${cdnOrigin}/big.png" alt="hero" width="10" height="10">`);
      case "/noalt.html":
        return html("<img id=\"a\" src=\"x.png\" width=\"1\" height=\"1\">");
      case "/robots.txt":
        res.writeHead(200, { "content-type": "text/plain" }).end("User-agent: *\nSitemap: /dead-sitemap.xml\n");
        return;
      case "/sitemap.xml":
        res.writeHead(200, { "content-type": "application/xml" }).end("<urlset></urlset>");
        return;
      default:
        res.writeHead(404, { "content-type": "text/html" }).end("<html><title>404</title></html>");
    }
  });
  await Promise.all([cdn, site].map((s) => new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve))));
  const cdnOrigin = `http://127.0.0.1:${(cdn.address() as AddressInfo).port}`;
  const siteOrigin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  try {
    const crawl = await crawlSite({ siteUrl: `${cdnOrigin}/`, maxPages: 5 });
    expect(
      "crawl follows a root redirect to another origin",
      crawl.pages.length === 2 && crawl.pages[0].url === `${siteOrigin}/` && crawl.pages[1].url === `${siteOrigin}/p2.html`,
      crawl.pages.map((p) => p.url).join(", "),
    );

    const seo = await auditSite("seo", { siteUrl: `${siteOrigin}/`, pages: [`${siteOrigin}/`] });
    const siteRules = seo.issues.filter((i) => i.rule === "sitemap" || i.rule === "robots-txt").map((i) => i.rule);
    expect("no sitemap issue when /sitemap.xml works but robots.txt lists a dead one", siteRules.length === 0, siteRules.join(", "));

    const perf = await auditPage("performance", { siteUrl: `${siteOrigin}/`, pageUrl: `${siteOrigin}/images.html` });
    const heavy = perf.issues.find((i) => i.rule === "oversized-image");
    expect("oversized-image covers CDN-hosted images", heavy?.evidence.includes(`${cdnOrigin}/big.png is 600000 bytes`) === true, heavy?.evidence ?? "none");

    const a11y = await auditPage("accessibility", { siteUrl: `${siteOrigin}/`, pageUrl: `${siteOrigin}/style.html` });
    const contrast = a11y.issues.filter((i) => i.rule === "color-contrast").map((i) => i.selector ?? "");
    expect(
      "color-contrast: rgba blended, 24pt is large text, % sizes are normal text, prototype color names ignored",
      contrast.join(",") === "#faint,#pct",
      contrast.join(","),
    );
    const spot = await spotCheckIssues(
      a11y.issues.filter((i) => i.rule === "color-contrast"),
      { sample: 10, seed: 3 },
    );
    expect("spot-check confirms rgba and %-size contrast issues", spot.confirmed === 2 && spot.refuted === 0, spot.samples.map((s) => `${s.issue.selector}: ${s.verdict} (${s.note})`).join("; "));

    const altClaim = (pageUrl: string) => buildIssue("image-alt", { pageUrl, selector: "img::after", description: "No alt.", evidence: "<img>" });
    const [real, fake] = await Promise.all([verifyClaim(altClaim(`${siteOrigin}/noalt.html`)), verifyClaim(altClaim(`${siteOrigin}/images.html`))]);
    expect("spot-check: an unparseable selector falls back to the page's candidates", real.verdict === "confirmed" && fake.verdict === "refuted", `${real.verdict} / ${fake.verdict}`);

    const schemeless = await Promise.all((["seo", "security", "links"] as const).map((c) => auditSite(c, { siteUrl: "localhost:3000/demo-site", pages: [] })));
    expect("auditSite returns an empty report for a non-http site URL", schemeless.every((o) => o.issues.length === 0 && o.pagesChecked.length === 0));
  } finally {
    for (const s of [cdn, site]) {
      s.close();
      s.closeAllConnections();
    }
  }
}

// ---------- audit run ----------

interface NodeRun {
  capability: Capability;
  label: string;
  output: AuditOutput;
}

async function runAudits(siteUrl: string, pages: string[]): Promise<NodeRun[]> {
  const runs: NodeRun[] = [];
  for (const pageUrl of pages) {
    for (const capability of ["accessibility", "performance"] as const) {
      const output = (await runCapability(capability, { siteUrl, pageUrl })) as AuditOutput;
      runs.push({ capability, label: `${capability} ${short(pageUrl, siteUrl)}`, output });
    }
  }
  for (const capability of ["seo", "security", "links"] as const) {
    const output = (await runCapability(capability, { siteUrl, pages })) as AuditOutput;
    runs.push({ capability, label: capability, output });
  }
  return runs;
}

function checkOutputs(runs: NodeRun[], siteUrl: string, pages: string[]): void {
  const invalid = runs.filter((r) => !AuditOutputSchema.safeParse(r.output).success).map((r) => r.label);
  expect("every audit output passes the zod contract", invalid.length === 0, invalid.join(", "));
  const wrongCategory = runs.filter((r) => r.output.issues.some((i) => i.category !== r.capability)).map((r) => r.label);
  expect("issue categories match their node", wrongCategory.length === 0, wrongCategory.join(", "));
  const allowed = new Set([...pages, siteRootUrl(siteUrl)]);
  const strayPages = runs.flatMap((r) => r.output.issues.filter((i) => !allowed.has(i.pageUrl)).map((i) => i.pageUrl));
  expect("issue pageUrls are crawled pages or the site root", strayPages.length === 0, strayPages.join(", "));
  const missingChecked = runs.filter((r) => r.output.pagesChecked.length === 0).map((r) => r.label);
  expect("pagesChecked is filled", missingChecked.length === 0, missingChecked.join(", "));
}

function checkIssueConventions(issues: Issue[]): void {
  const badRecommendation = issues.filter((i) => i.recommendation !== RULES[i.rule]?.recommendation);
  expect("recommendations come from RULES", badRecommendation.length === 0, badRecommendation.map((i) => i.rule).join(", "));
  const badSeverity = issues.filter((i) => {
    if (i.rule !== "broken-link") return i.severity !== RULES[i.rule]?.severity;
    const internal = new URL(i.evidence.split(" ")[0]).origin === new URL(i.pageUrl).origin;
    return i.severity !== (internal ? "medium" : "low");
  });
  expect("severities follow RULES (broken-link: internal medium, external low)", badSeverity.length === 0, badSeverity.map((i) => `${i.rule}@${i.pageUrl}`).join(", "));
  const links = issues.filter((i) => i.rule === "broken-link");
  const badLinks = links.filter((i) => !/^a\[href=".*"\]$/.test(i.selector ?? "") || !/^https?:\/\/\S+ (returned HTTP \d{3}|failed: DNS lookup failed)/.test(i.evidence));
  expect("broken-link selector and evidence format", badLinks.length === 0, badLinks.map((i) => i.evidence).join(" | "));
  const oversized = issues.filter((i) => i.rule === "oversized-image");
  expect(
    "oversized-image evidence has the image URL and byte size",
    oversized.length > 0 && oversized.every((i) => /https?:\/\/\S+\/img\/hero\.png is 3015651 bytes/.test(i.evidence)),
  );
}

// ---------- spot checks ----------

interface Fabricated {
  label: string;
  issue: Issue;
  want: SpotCheckVerdict;
}

function fabricatedIssues(siteUrl: string): Fabricated[] {
  const page = (p: string) => normalizeUrl(p, siteUrl);
  return [
    {
      label: "image-alt on the logo (has alt)",
      want: "refuted",
      issue: buildIssue("image-alt", { pageUrl: siteUrl, selector: "img[src=\"img/logo.png\"]", description: "Logo has no alt text.", evidence: "<img src=\"img/logo.png\">" }),
    },
    {
      label: "broken-link on a working link",
      want: "refuted",
      issue: buildIssue("broken-link", { pageUrl: siteUrl, selector: "a[href=\"about.html\"]", description: "About link is broken.", evidence: `${page("about.html")} returned HTTP 404` }),
    },
    {
      label: "broken-link to a URL the page never links",
      want: "refuted",
      issue: buildIssue("broken-link", { pageUrl: siteUrl, description: "Careers link is broken.", evidence: `${page("careers.html")} returned HTTP 404` }),
    },
    {
      label: "document-title on a page that has one",
      want: "refuted",
      issue: buildIssue("document-title", { pageUrl: siteUrl, description: "Home page has no title.", evidence: "No <title>." }),
    },
    {
      label: "image-alt on a non-existent page",
      want: "refuted",
      issue: buildIssue("image-alt", { pageUrl: page("careers.html"), selector: "#hero-img", description: "Hero has no alt.", evidence: "<img id=\"hero-img\">" }),
    },
    {
      label: "missing-csp on a non-existent page",
      want: "refuted",
      issue: buildIssue("missing-csp", { pageUrl: page("admin/"), description: "No CSP.", evidence: "No CSP header." }),
    },
    {
      label: "label on a labelled input",
      want: "refuted",
      issue: buildIssue("label", { pageUrl: page("contact.html"), selector: "#name", description: "Name has no label.", evidence: "<input id=\"name\">" }),
    },
    {
      label: "button-name with a selector that matches nothing",
      want: "refuted",
      issue: buildIssue("button-name", { pageUrl: page("contact.html"), selector: "#no-such-button", description: "Unnamed button.", evidence: "<button>" }),
    },
    {
      label: "multiple-h1 on a page with one <h1>",
      want: "refuted",
      issue: buildIssue("multiple-h1", { pageUrl: page("about.html"), selector: "h1", description: "Two h1.", evidence: "2 <h1>" }),
    },
    {
      label: "oversized-image on the tiny logo",
      want: "refuted",
      issue: buildIssue("oversized-image", { pageUrl: siteUrl, selector: "img[src=\"img/logo.png\"]", description: "Logo is huge.", evidence: "logo.png is 2 MB" }),
    },
    {
      label: "html-has-lang on a page with lang",
      want: "refuted",
      issue: buildIssue("html-has-lang", { pageUrl: page("about.html"), selector: "html", description: "No lang.", evidence: "<html>" }),
    },
    {
      label: "unknown rule",
      want: "unverifiable",
      issue: { category: "seo", severity: "low", rule: "made-up-rule", pageUrl: siteUrl, description: "Made up.", recommendation: "None.", evidence: "" },
    },
  ];
}

async function testSpotChecks(issues: Issue[], siteUrl: string): Promise<{ label: string; want: string; got: string; note: string }[]> {
  const all = await spotCheckIssues(issues, { sample: issues.length, seed: 1 });
  const notConfirmed = all.samples.filter((s) => s.verdict !== "confirmed");
  expect(
    "spot-check confirms every real issue",
    all.checked === issues.length && all.confirmed === issues.length,
    notConfirmed.map((s) => `${s.issue.rule}@${short(s.issue.pageUrl, siteUrl)}: ${s.verdict} (${s.note})`).join("; "),
  );

  const a = await spotCheckIssues(issues, { sample: 6, seed: 42 });
  const b = await spotCheckIssues(issues, { sample: 6, seed: 42 });
  const key = (r: typeof a) => r.samples.map((s) => `${s.issue.rule}@${s.issue.pageUrl}@${s.issue.selector ?? ""}`).join("|");
  expect("seeded sample is deterministic and sized", a.checked === 6 && key(a) === key(b) && a.confirmed === 6);

  const fabricated = fabricatedIssues(siteUrl);
  const result = await spotCheckIssues(
    fabricated.map((f) => f.issue),
    { sample: fabricated.length, seed: 7 },
  );
  const rows = fabricated.map((f, i) => ({ label: f.label, want: f.want, got: result.samples[i]?.verdict ?? "missing", note: result.samples[i]?.note ?? "" }));
  const wrong = rows.filter((r) => r.want !== r.got);
  expect("spot-check refutes fabricated claims", wrong.length === 0, wrong.map((r) => `${r.label}: ${r.got}`).join("; "));
  return rows;
}

// ---------- report ----------

function printTable(headers: string[], rows: string[][]): void {
  const widths = headers.map((h, c) => Math.min(70, Math.max(h.length, ...rows.map((r) => r[c].length))));
  const line = (cells: string[]) => cells.map((cell, c) => (cell.length > widths[c] ? `${cell.slice(0, widths[c] - 1)}…` : cell.padEnd(widths[c]))).join("  ");
  console.log(line(headers));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of rows) console.log(line(row));
  console.log("");
}

async function main(): Promise<number> {
  const started = Date.now();
  clearFetchCache();
  testUrlHelpers();
  testDemoSiteFiles();
  testDemoSitePrivacy();
  await testPrototypeKeys();
  await testFetcher();
  await testRealSiteEdgeCases();

  const server = await startDemoServer(0);
  let spotRows: { label: string; want: string; got: string; note: string }[] = [];
  let gtRows: string[][] = [];
  let unexpected: Issue[] = [];
  try {
    const siteUrl = `${server.origin}/demo-site/`;
    await testServer(server.origin);

    const crawl = (await runCapability("crawl", { siteUrl, maxPages: 5 })) as CrawlOutput;
    const crawled = crawl.pages.map((p) => p.url);
    const wantPages = expectedPages(siteUrl);
    expect("crawl output passes the zod contract", CrawlOutputSchema.safeParse(crawl).success);
    expect(
      "crawl finds exactly the 5 ground-truth pages, home first",
      crawled.length === wantPages.length && crawled[0] === siteUrl && wantPages.every((p) => crawled.includes(p)),
      crawled.map((u) => short(u, siteUrl)).join(", "),
    );
    expect("crawl: every page is status 200; about.html has an empty title", crawl.pages.every((p) => p.status === 200) && crawl.pages.find((p) => p.url.endsWith("about.html"))?.title === "");
    const capped = (await runCapability("crawl", { siteUrl, maxPages: 2 })) as CrawlOutput;
    expect("crawl respects maxPages", capped.pages.length === 2 && capped.pages[0].url === siteUrl);

    const runs = await runAudits(siteUrl, crawled);
    checkOutputs(runs, siteUrl, crawled);
    const issues = runs.flatMap((r) => r.output.issues);
    checkIssueConventions(issues);

    const recall = measureRecall(siteUrl, issues);
    expect(`recall ${recall.found}/${recall.expected}`, recall.ratio === 1, recall.missing.map((m) => m.id).join(", "));
    unexpected = unmatchedIssues(siteUrl, issues);
    expect("precision: no issue outside ground truth", unexpected.length === 0, unexpected.map((i) => `${i.rule}@${short(i.pageUrl, siteUrl)} ${i.selector ?? ""}`).join("; "));
    const gt = expectedIssues(siteUrl);
    const duplicates = gt.filter((g) => issues.filter((i) => matchesGroundTruth(g, i)).length > 1).map((g) => g.id);
    expect("no duplicate findings", duplicates.length === 0, duplicates.join(", "));
    // The test server sends no HSTS header, so the optional GT-25 must be reported too.
    const hsts = issues.filter((i) => i.rule === "missing-hsts" && i.pageUrl === siteUrl);
    expect("missing-hsts reported when the header is absent", hsts.length === 1);
    const wantCount = gt.filter((g) => !g.optional).length + 1;
    expect(`exactly ${wantCount} issues (ground truth + missing-hsts)`, issues.length === wantCount, `got ${issues.length}`);
    expect("recall filter by category and page", measureRecall(siteUrl, issues, { category: "accessibility", pageUrl: `${siteUrl}index.html` }).expected === 2);

    gtRows = gt.map((g) => {
      const hit = issues.find((i) => matchesGroundTruth(g, i));
      return [g.id, g.rule, short(g.pageUrl, siteUrl), hit ? `yes ${hit.selector ?? ""}` : g.optional ? "optional, missing" : "MISSING"];
    });
    spotRows = await testSpotChecks(issues, siteUrl);
  } finally {
    await server.close();
  }

  console.log("\nGround truth coverage");
  printTable(["id", "rule", "page", "found"], gtRows);
  if (unexpected.length > 0) {
    console.log("Unexpected issues");
    printTable(["rule", "page", "selector"], unexpected.map((i) => [i.rule, i.pageUrl, i.selector ?? ""]));
  }
  console.log("Fabricated claims");
  printTable(["claim", "want", "got", "note"], spotRows.map((r) => [r.label, r.want, r.got, r.note]));
  console.log("Checks");
  printTable(["", "check", "detail"], checks.map((c) => [c.pass ? "PASS" : "FAIL", c.name, c.detail]));

  const failed = checks.filter((c) => !c.pass).length;
  console.log(`${checks.length - failed}/${checks.length} checks passed in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return failed === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exit(1);
  },
);
