// Offline tests for src/lib/llm. Never touches the network: OpenAI requests go to a stub,
// and globalThis.fetch is replaced so anything else that tries a non-local request fails.
// Run: npx tsx --tsconfig tsconfig.json scripts/test-llm.ts
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { AuditOutput, Issue, LayerResult, PrioritizedIssue, PrioritizedOutput } from "@/lib/types";

const FAKE_KEY = "sk-test-FAKEKEY-0123456789abcdefXYZ";
// Child mode: a second process hammering the shared per-day counter (see testCrossProcessDayCap).
const CHILD_MODE = process.argv.includes("--usage-child");
const DATA_DIR = CHILD_MODE && process.env.LLM_TEST_CHILD_DIR ? process.env.LLM_TEST_CHILD_DIR : fs.mkdtempSync(path.join(os.tmpdir(), "axolotl-llm-test-"));

// env.ts reads process.env at import time, so configure before any dynamic import.
process.env.AXOLOTL_DATA_DIR = DATA_DIR;
process.env.OPENAI_API_KEY = FAKE_KEY;
process.env.OPENAI_MODEL = "gpt-5.6-luna";
process.env.LLM_MAX_CALLS_PER_PROCESS = "100";
process.env.LLM_MAX_CALLS_PER_DAY = "500";
process.env.LLM_MAX_OUTPUT_TOKENS = "900";
process.env.LLM_TIMEOUT_MS = "45000";
delete process.env.AXOLOTL_LLM_DISABLED;

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const host = new URL(url).hostname;
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]") return realFetch(input, init);
  throw new TypeError(`fetch failed (network disabled in tests: ${host})`);
}) as typeof fetch;

type Gateway = typeof import("@/lib/llm/gateway");
type JudgeMod = typeof import("@/lib/llm/judge");
type AdapterMod = typeof import("@/lib/llm/adapter");
type FixplanMod = typeof import("@/lib/llm/fixplan");

let passed = 0;
let failed = 0;
const seenMessages: string[] = [];

function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed += 1;
    console.log(`  ok    ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` (${detail})` : ""}`);
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- fetch stub ----------

interface StubCall {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

function makeStub(handler: (call: StubCall, n: number) => Promise<Response> | Response) {
  const calls: StubCall[] = [];
  let active = 0;
  let maxActive = 0;
  const fn = async (url: string, init: RequestInit): Promise<Response> => {
    const call: StubCall = { url, init, body: JSON.parse(String(init.body)) as Record<string, unknown> };
    calls.push(call);
    active += 1;
    maxActive = Math.max(maxActive, active);
    try {
      return await handler(call, calls.length);
    } finally {
      active -= 1;
    }
  };
  return {
    fn,
    calls,
    get maxActive() {
      return maxActive;
    },
  };
}

function responsesBody(data: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: "resp_test",
    object: "response",
    status: "completed",
    output: [
      { type: "reasoning", summary: [] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(data), annotations: [] }] },
    ],
    usage: { input_tokens: 120, output_tokens: 30, total_tokens: 150 },
    ...extra,
  });
}

function ok(data: unknown, extra?: Record<string, unknown>): Response {
  return new Response(responsesBody(data, extra), { status: 200, headers: { "content-type": "application/json" } });
}

function hangUntilAbort(call: StubCall): Promise<Response> {
  return new Promise((_, reject) => {
    call.init.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
  });
}

async function rejection(p: Promise<unknown>): Promise<(Error & { reason?: string; status?: number }) | null> {
  try {
    await p;
    return null;
  } catch (err) {
    const e = err as Error & { reason?: string };
    seenMessages.push(String(e?.message));
    return e;
  }
}

// ---------- fixtures ----------

const SITE = "http://localhost:3000/demo-site/";
const PAGES = ["", "about.html", "pricing.html", "contact.html", "blog.html"].map((p) => SITE + p);
const page = (p: string) => SITE + p;

function issue(p: Partial<Issue> & Pick<Issue, "category" | "rule" | "description" | "recommendation" | "evidence">): Issue {
  return { severity: "medium", pageUrl: SITE, ...p };
}

const GOOD_A11Y_CONTACT: AuditOutput = {
  issues: [
    issue({
      category: "accessibility",
      severity: "high",
      rule: "label",
      pageUrl: page("contact.html"),
      selector: "#email",
      description: "Email input #email has no associated <label>; it relies on placeholder text only.",
      recommendation: 'Add <label for="email">Email</label> or an aria-label to the input.',
      evidence: '<input id="email" name="email" type="email" placeholder="you@example.com">',
    }),
    issue({
      category: "accessibility",
      severity: "high",
      rule: "button-name",
      pageUrl: page("contact.html"),
      selector: "#send-btn",
      description: "Icon-only submit button #send-btn has no accessible name.",
      recommendation: "Give the button visible text or an aria-label such as \"Send message\".",
      evidence: '<button id="send-btn" type="submit"><svg …></svg></button>',
    }),
  ],
  pagesChecked: [page("contact.html")],
  summary: "2 accessibility issues on the contact page.",
};

const GOOD_SECURITY: AuditOutput = {
  issues: [
    ["missing-csp", "Content-Security-Policy", "high"],
    ["missing-x-frame-options", "X-Frame-Options", "medium"],
    ["missing-x-content-type-options", "X-Content-Type-Options", "medium"],
    ["missing-referrer-policy", "Referrer-Policy", "low"],
  ].map(([rule, header, severity]) =>
    issue({
      category: "security",
      severity: severity as Issue["severity"],
      rule,
      pageUrl: SITE,
      description: `The site root response has no ${header} header.`,
      recommendation: `Send a ${header} header on every response.`,
      evidence: `GET ${SITE} → 200; response headers do not include ${header.toLowerCase()}`,
    }),
  ),
  pagesChecked: PAGES,
};
GOOD_SECURITY.issues.push(
  issue({
    category: "security",
    severity: "critical",
    rule: "insecure-form-action",
    pageUrl: page("contact.html"),
    selector: "form",
    description: "Contact form posts over plain http://, exposing submitted data.",
    recommendation: "Change the form action to an https:// endpoint.",
    evidence: '<form action="http://forms.tidepool-demo.invalid/contact" method="post">',
  }),
);

const GOOD_LINKS: AuditOutput = {
  issues: [
    issue({
      category: "links",
      rule: "broken-link",
      pageUrl: SITE,
      selector: 'a[href="pricing-2023.html"]',
      description: "Internal link to pricing-2023.html returns 404.",
      recommendation: "Point the link at pricing.html or remove it.",
      evidence: `${page("pricing-2023.html")} → HTTP 404`,
    }),
    issue({
      category: "links",
      severity: "low",
      rule: "broken-link",
      pageUrl: page("about.html"),
      selector: 'a[href="https://press.tidepool-demo.invalid/coverage"]',
      description: "External press link does not resolve.",
      recommendation: "Replace the link with a working press URL or remove it.",
      evidence: "https://press.tidepool-demo.invalid/coverage → DNS error (ENOTFOUND)",
    }),
    issue({
      category: "links",
      rule: "broken-link",
      pageUrl: page("blog.html"),
      selector: 'a[href="blog/launch-recap.html"]',
      description: "Internal link to blog/launch-recap.html returns 404.",
      recommendation: "Publish the recap page or remove the link.",
      evidence: `${page("blog/launch-recap.html")} → HTTP 404`,
    }),
  ],
  pagesChecked: PAGES,
};

const GOOD_SEO: AuditOutput = {
  issues: [
    issue({
      category: "seo",
      rule: "meta-description",
      pageUrl: SITE,
      description: "Home page has no meta description.",
      recommendation: 'Add <meta name="description" content="…"> with a 120-160 character summary.',
      evidence: 'No <meta name="description"> in <head>',
    }),
    issue({
      category: "seo",
      severity: "high",
      rule: "document-title",
      pageUrl: page("about.html"),
      description: "About page has no <title>.",
      recommendation: "Add a descriptive <title> element to the <head>.",
      evidence: "<head> contains no <title> element",
    }),
    issue({
      category: "seo",
      severity: "low",
      rule: "robots-txt",
      pageUrl: SITE,
      description: "No robots.txt at the site root.",
      recommendation: "Serve a robots.txt that allows crawling and links the sitemap.",
      evidence: `GET ${page("robots.txt")} → 404`,
    }),
  ],
  pagesChecked: PAGES,
};

const GOOD_CRAWL = { pages: PAGES.map((url, i) => ({ url, title: i === 1 ? "" : `Tidepool page ${i}`, status: 200 })) };

const a11yNode = { templateId: "a11y", label: "Accessibility (WCAG)", capability: "accessibility" as const, category: "accessibility" as const };
const contactInput = { siteUrl: SITE, pageUrl: page("contact.html") };

function prioritizedFixture(): PrioritizedOutput {
  const rows: [Issue["category"], string, Issue["severity"], string, string, string, string][] = [
    ["security", "insecure-form-action", "critical", "contact.html", "form", "Contact form posts over plain http://", '<form action="http://forms.tidepool-demo.invalid/contact" method="post">'],
    ["security", "missing-csp", "high", "", "", "No Content-Security-Policy header", "response headers lack content-security-policy"],
    ["security", "missing-hsts", "high", "", "", "No Strict-Transport-Security header", "response headers lack strict-transport-security"],
    ["accessibility", "image-alt", "high", "", "#hero-img", "Hero image has no alt attribute", '<img id="hero-img" src="img/hero.png">'],
    ["seo", "document-title", "high", "about.html", "", "About page has no <title>", "no <title> in <head>"],
    ["performance", "oversized-image", "high", "", "#hero-img", "img/hero.png is about 3 MB", "http://localhost:3000/demo-site/img/hero.png is 3145728 bytes"],
    ["accessibility", "color-contrast", "medium", "", ".tagline", "Tagline text #c4c4c4 on #ffffff fails WCAG AA contrast", "color #c4c4c4 on background #ffffff = 1.75:1"],
    ["security", "missing-x-frame-options", "medium", "", "", "No X-Frame-Options header", "response headers lack x-frame-options"],
    ["links", "broken-link", "medium", "", 'a[href="pricing-2023.html"]', "Internal link to pricing-2023.html returns 404", "http://localhost:3000/demo-site/pricing-2023.html → 404"],
    ["performance", "render-blocking-script", "medium", "", 'script[src="js/analytics.js"]', "Synchronous script in <head> blocks rendering", '<script src="js/analytics.js">'],
    ["seo", "robots-txt", "low", "", "", "No robots.txt at the site root", "GET robots.txt → 404"],
    ["seo", "sitemap", "low", "", "", "No sitemap.xml at the site root", "GET sitemap.xml → 404"],
  ];
  const issues: PrioritizedIssue[] = rows.map(([category, rule, severity, p, selector, description, evidence], idx) => ({
    id: `iss-${idx + 1}`,
    category,
    rule,
    severity,
    pageUrl: page(p),
    ...(selector ? { selector } : {}),
    description,
    recommendation: `Fix: ${description.toLowerCase()}`,
    evidence,
    priority: idx + 1,
    effort: "small",
    duplicates: 1,
    reportedBy: ["agent-a"],
  }));
  return { issues, dedupedFrom: 17 };
}

// ---------- gateway ----------

async function testGateway(g: Gateway, envMod: typeof import("@/lib/env")): Promise<void> {
  section("gateway: request shape and parsing");
  g.__resetLlmCountersForTests();
  let stub = makeStub(() => ok({ answer: 42 }));
  g.__setLlmFetchForTests(stub.fn);
  const schema = { type: "object", properties: { answer: { type: "number" } }, required: ["answer"], additionalProperties: false };
  const base = { purpose: "test" as const, system: "sys", user: "user-1", schemaName: "answer", schema };
  const r1 = await g.callLlmJson<{ answer: number }>({ ...base, maxOutputTokens: 5000 });
  check("parses output[].message.content[].output_text JSON", r1.data.answer === 42 && r1.cached === false);
  check("reports usage tokens", r1.usage?.input === 120 && r1.usage?.output === 30);
  check("exactly one fetch", stub.calls.length === 1);
  const c = stub.calls[0];
  const headers = c.init.headers as Record<string, string>;
  check("POSTs to the Responses endpoint", c.url === "https://api.openai.com/v1/responses" && c.init.method === "POST");
  check("sends bearer key and JSON content type", headers.Authorization === `Bearer ${FAKE_KEY}` && headers["Content-Type"] === "application/json");
  const fmt = (c.body.text as { format: Record<string, unknown> }).format;
  check(
    "body has model, instructions, input, low reasoning, strict json_schema",
    c.body.model === "gpt-5.6-luna" &&
      c.body.instructions === "sys" &&
      c.body.input === "user-1" &&
      (c.body.reasoning as { effort: string }).effort === "low" &&
      fmt.type === "json_schema" &&
      fmt.name === "answer" &&
      fmt.strict === true &&
      JSON.stringify(fmt.schema) === JSON.stringify(schema),
  );
  check("max_output_tokens capped at env limit", c.body.max_output_tokens === 900, String(c.body.max_output_tokens));
  await g.callLlmJson({ ...base, user: "user-2", maxOutputTokens: 200 });
  check("smaller max_output_tokens honored", stub.calls[1].body.max_output_tokens === 200);
  const nanStub = makeStub(() => ok({ answer: 42 }));
  g.__setLlmFetchForTests(nanStub.fn);
  await g.callLlmJson({ ...base, user: "user-nan", maxOutputTokens: Number.NaN, cache: false });
  check("NaN max_output_tokens still sends the cap (never null)", nanStub.calls[0]?.body.max_output_tokens === 900, String(nanStub.calls[0]?.body.max_output_tokens));
  g.__setLlmLimitsForTests({ maxOutputTokens: Number.NaN, concurrency: Number.NaN });
  const finished = await Promise.race([g.callLlmJson({ ...base, user: "user-nan-limit", cache: false }).then(() => true), sleep(2000).then(() => false)]);
  check(
    "NaN limit overrides are ignored (cap kept, queue not stalled)",
    finished && nanStub.calls[1]?.body.max_output_tokens === 900 && g.getLlmUsage().limits.concurrency === 3,
  );
  g.__setLlmLimitsForTests({});
  g.__setLlmFetchForTests(stub.fn);

  section("gateway: cache");
  const before = g.getLlmUsage();
  const r2 = await g.callLlmJson<{ answer: number }>({ ...base, maxOutputTokens: 5000 });
  const after = g.getLlmUsage();
  check("identical prompt is a cache hit", r2.cached === true && r2.data.answer === 42);
  check("cache hit skips fetch", stub.calls.length === 2);
  check("cache hit does not count against caps", after.processCalls === before.processCalls && after.dayCalls === before.dayCalls);
  check("cache hit counted in usage", after.cacheHits === before.cacheHits + 1);
  const runB = { limit: 5, used: 5 };
  const r3 = await g.callLlmJson({ ...base, maxOutputTokens: 5000, runBudget: runB });
  check("cache hit served even when the run budget is spent", r3.cached === true && runB.used === 5);
  await g.callLlmJson({ ...base, cache: false });
  check("cache:false sends a new request", stub.calls.length === 3);

  section("gateway: response variants");
  stub = makeStub(() => new Response(JSON.stringify({ status: "completed", output_text: '{"answer":7}', output: [] }), { status: 200 }));
  g.__setLlmFetchForTests(stub.fn);
  const r4 = await g.callLlmJson<{ answer: number }>({ ...base, user: "convenience", cache: false });
  check("top-level output_text is used", r4.data.answer === 7);
  stub = makeStub(() =>
    new Response(JSON.stringify({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] }), { status: 200 }),
  );
  g.__setLlmFetchForTests(stub.fn);
  let e = await rejection(g.callLlmJson({ ...base, user: "incomplete", cache: false }));
  check("status incomplete ⇒ parse error", e?.reason === "parse" && /incomplete/i.test(e.message) && /max_output_tokens/.test(e.message), e?.message);
  stub = makeStub(() => new Response(JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "not json" }] }] }), { status: 200 }));
  g.__setLlmFetchForTests(stub.fn);
  e = await rejection(g.callLlmJson({ ...base, user: "bad-json", cache: false }));
  check("non-JSON model text ⇒ parse error", e?.reason === "parse");
  stub = makeStub(() => new Response(JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }] }), { status: 200 }));
  g.__setLlmFetchForTests(stub.fn);
  e = await rejection(g.callLlmJson({ ...base, user: "refusal", cache: false }));
  check("refusal content ⇒ parse error", e?.reason === "parse" && /refused/i.test(e.message));
  const nullStub = makeStub(() => new Response("null", { status: 200 }));
  g.__setLlmFetchForTests(nullStub.fn);
  e = await rejection(g.callLlmJson({ ...base, user: "null-body", cache: false }));
  check("JSON null body ⇒ parse error (not a TypeError)", e?.reason === "parse" && nullStub.calls.length === 1, e?.message);
  g.__setLlmFetchForTests(makeStub(() => new Response(JSON.stringify({ status: "completed", output: { type: "message" } }), { status: 200 })).fn);
  e = await rejection(g.callLlmJson({ ...base, user: "object-output", cache: false }));
  check("non-array output ⇒ parse error", e?.reason === "parse", e?.message);
  g.__setLlmFetchForTests(makeStub(() => new Response("null", { status: 503 })).fn);
  e = await rejection(g.callLlmJson({ ...base, user: "null-error-body", cache: false }));
  check("HTTP error with a JSON null body keeps its status", e?.reason === "http" && e.status === 503, e?.message);
  g.__setLlmFetchForTests(stub.fn);
  const failedCacheCheck = await rejection(g.callLlmJson({ ...base, user: "refusal" }));
  check("failed responses are never cached", failedCacheCheck !== null && stub.calls.length === 2);

  section("gateway: failures count and never retry");
  g.__resetLlmCountersForTests();
  stub = makeStub(
    () =>
      new Response(JSON.stringify({ error: { message: `Server exploded for key ${FAKE_KEY}; header was Bearer ${FAKE_KEY}` } }), { status: 500 }),
  );
  g.__setLlmFetchForTests(stub.fn);
  const day0 = g.getLlmUsage().dayCalls;
  const run = { limit: 10, used: 0 };
  e = await rejection(g.callLlmJson({ ...base, user: "http-500", runBudget: run }));
  const u = g.getLlmUsage();
  check("HTTP 500 ⇒ reason http with status", e?.reason === "http" && e.status === 500 && /500/.test(e.message), e?.message);
  check("HTTP 500 ⇒ exactly one fetch (no retry)", stub.calls.length === 1);
  check("failed call counted: process, day and run", u.processCalls === 1 && u.dayCalls === day0 + 1 && run.used === 1);
  check("HTTP error message has no key", !!e && !e.message.includes(FAKE_KEY) && !/FAKEKEY/.test(e.message), e?.message);
  check("lastError recorded and sanitized", !!u.lastError && !u.lastError.includes("FAKEKEY"));
  stub = makeStub(() => new Response(`Incorrect API key provided: ${FAKE_KEY}`, { status: 401 }));
  g.__setLlmFetchForTests(stub.fn);
  e = await rejection(g.callLlmJson({ ...base, user: "http-401" }));
  check("non-JSON 401 body sanitized", e?.reason === "http" && e.status === 401 && !/FAKEKEY/.test(e.message), e?.message);

  g.__setLlmLimitsForTests({ timeoutMs: 60 });
  stub = makeStub(hangUntilAbort);
  g.__setLlmFetchForTests(stub.fn);
  const t0 = Date.now();
  e = await rejection(g.callLlmJson({ ...base, user: "timeout" }));
  check("timeout ⇒ reason timeout", e?.reason === "timeout", e?.message);
  check("timeout ⇒ exactly one fetch, aborted promptly", stub.calls.length === 1 && Date.now() - t0 < 2000);
  g.__setLlmLimitsForTests({});
  stub = makeStub(() => {
    throw new TypeError("fetch failed");
  });
  g.__setLlmFetchForTests(stub.fn);
  e = await rejection(g.callLlmJson({ ...base, user: "network" }));
  check("network error ⇒ reason http, one fetch", e?.reason === "http" && stub.calls.length === 1);

  section("gateway: caps block before fetch");
  stub = makeStub(() => ok({ answer: 1 }));
  g.__setLlmFetchForTests(stub.fn);
  envMod.env.openaiApiKey = "";
  e = await rejection(g.callLlmJson({ ...base, user: "no-key", runBudget: { limit: 0, used: 0 } }));
  check("no key ⇒ no_key (checked first)", e?.reason === "no_key" && stub.calls.length === 0, e?.reason);
  check("usage shows keyPresent false", g.getLlmUsage().keyPresent === false);
  envMod.env.openaiApiKey = FAKE_KEY;
  process.env.AXOLOTL_LLM_DISABLED = "1";
  e = await rejection(g.callLlmJson({ ...base, user: "disabled" }));
  check("kill switch ⇒ disabled", e?.reason === "disabled" && stub.calls.length === 0);
  delete process.env.AXOLOTL_LLM_DISABLED;

  g.__resetLlmCountersForTests();
  g.__setLlmLimitsForTests({ perProcess: 3 });
  for (let i = 0; i < 3; i++) await g.callLlmJson({ ...base, user: `proc-${i}`, cache: false });
  e = await rejection(g.callLlmJson({ ...base, user: "proc-4", cache: false, runBudget: { limit: 1, used: 1 } }));
  check("per-process cap ⇒ budget_process before run cap", e?.reason === "budget_process" && stub.calls.length === 3, e?.reason);
  g.__setLlmLimitsForTests({ perProcess: 1000 });
  check("limit overrides cannot loosen caps", g.getLlmUsage().limits.perProcess === 100);
  g.__setLlmLimitsForTests({});

  g.__resetLlmCountersForTests();
  stub = makeStub(() => ok({ answer: 2 }));
  g.__setLlmFetchForTests(stub.fn);
  for (let i = 0; i < 20; i++) await g.callLlmJson({ ...base, user: `rate-${i}`, cache: false });
  e = await rejection(g.callLlmJson({ ...base, user: "rate-21", cache: false }));
  check("rolling-minute guard ⇒ budget_process on call 21", e?.reason === "budget_process" && /per minute/.test(e.message) && stub.calls.length === 20, e?.message);

  g.__resetLlmCountersForTests();
  const usagePath = path.join(DATA_DIR, "llm-usage.json");
  const today = g.getLlmUsage().day;
  fs.writeFileSync(usagePath, JSON.stringify({ [today]: { calls: 500, inputTokens: 0, outputTokens: 0 } }));
  stub = makeStub(() => ok({ answer: 3 }));
  g.__setLlmFetchForTests(stub.fn);
  e = await rejection(g.callLlmJson({ ...base, user: "day-1", cache: false }));
  check("per-day cap ⇒ budget_day", e?.reason === "budget_day" && stub.calls.length === 0, e?.reason);
  check("blocked call not counted", g.getLlmUsage().processCalls === 0 && g.getLlmUsage().dayCalls === 500);
  fs.writeFileSync(usagePath, JSON.stringify({ "2020-01-01": { calls: 99, inputTokens: 0, outputTokens: 0 }, [today]: { calls: 10, inputTokens: 0, outputTokens: 0 } }));
  g.__setLlmLimitsForTests({ perDay: 11 });
  await g.callLlmJson({ ...base, user: "day-2", cache: false });
  const persisted = JSON.parse(fs.readFileSync(usagePath, "utf8")) as Record<string, { calls: number; inputTokens: number }>;
  check("day counter persisted by local date", persisted[today]?.calls === 11 && persisted["2020-01-01"]?.calls === 99);
  check("day token totals persisted", persisted[today]?.inputTokens === 120);
  e = await rejection(g.callLlmJson({ ...base, user: "day-3", cache: false }));
  check("persisted day count enforces the cap", e?.reason === "budget_day" && stub.calls.length === 1);
  check("no temp files left behind", fs.readdirSync(DATA_DIR).every((f) => !f.endsWith(".tmp")));
  g.__setLlmLimitsForTests({});
  fs.writeFileSync(usagePath, "{ not json");
  e = await rejection(g.callLlmJson({ ...base, user: "day-corrupt", cache: false }));
  check("corrupt usage file fails closed (budget_day)", e?.reason === "budget_day" && stub.calls.length === 1, e?.message);
  for (const bad of [{ calls: "lots" }, { calls: -400 }, null, 7]) {
    fs.writeFileSync(usagePath, JSON.stringify({ [today]: bad }));
    e = await rejection(g.callLlmJson({ ...base, user: `day-bad-${JSON.stringify(bad)}`, cache: false }));
    check(`damaged entry for today (${JSON.stringify(bad)}) fails closed`, e?.reason === "budget_day" && stub.calls.length === 1, e?.reason);
  }
  fs.writeFileSync(usagePath, JSON.stringify({ junk: { calls: 1 }, [today]: { calls: 0 } }));
  const lockPath = `${usagePath}.lock`;
  fs.writeFileSync(lockPath, "held");
  const tLock = Date.now();
  e = await rejection(g.callLlmJson({ ...base, user: "day-locked", cache: false }));
  check("usage file held by another process ⇒ budget_day after a short wait, no fetch", e?.reason === "budget_day" && stub.calls.length === 1 && Date.now() - tLock < 5000, e?.message);
  const stale = new Date(Date.now() - 60_000);
  fs.utimesSync(lockPath, stale, stale);
  await g.callLlmJson({ ...base, user: "day-stale-lock", cache: false });
  const afterStale = JSON.parse(fs.readFileSync(usagePath, "utf8")) as Record<string, { calls: number }>;
  check("stale lock left by a crashed process is broken", stub.calls.length === 2 && afterStale[today]?.calls === 1 && !fs.existsSync(lockPath));
  check("non-date keys pruned from the usage file", !("junk" in afterStale));
  fs.unlinkSync(usagePath);

  g.__resetLlmCountersForTests();
  stub = makeStub(() => ok({ answer: 3 }));
  g.__setLlmFetchForTests(stub.fn);
  const rb = { limit: 2, used: 0 };
  await g.callLlmJson({ ...base, user: "run-1", cache: false, runBudget: rb });
  await g.callLlmJson({ ...base, user: "run-2", cache: false, runBudget: rb });
  e = await rejection(g.callLlmJson({ ...base, user: "run-3", cache: false, runBudget: rb }));
  check("run budget ⇒ budget_run after limit", e?.reason === "budget_run" && rb.used === 2 && stub.calls.length === 2, e?.reason);
  e = await rejection(g.callLlmJson({ ...base, user: "run-nan", cache: false, runBudget: { limit: Number.NaN, used: 0 } }));
  check("non-numeric run budget fails closed", e?.reason === "budget_run" && stub.calls.length === 2, e?.reason);

  section("gateway: concurrency");
  g.__resetLlmCountersForTests();
  g.__setLlmLimitsForTests({ perProcess: 5 });
  stub = makeStub(async () => {
    await sleep(25);
    return ok({ answer: 4 });
  });
  g.__setLlmFetchForTests(stub.fn);
  let settled = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => g.callLlmJson({ ...base, user: `par-${i}`, cache: false })));
  let okCount = settled.filter((s) => s.status === "fulfilled").length;
  let blocked = settled.filter((s) => s.status === "rejected" && (s.reason as { reason?: string }).reason === "budget_process").length;
  check("12 parallel calls with process cap 5 ⇒ 5 sent, 7 blocked", okCount === 5 && blocked === 7 && stub.calls.length === 5, `${okCount}/${blocked}/${stub.calls.length}`);
  check("at most 3 requests in flight", stub.maxActive <= 3, String(stub.maxActive));
  g.__setLlmLimitsForTests({});

  g.__resetLlmCountersForTests();
  stub = makeStub(async () => {
    await sleep(20);
    return ok({ answer: 5 });
  });
  g.__setLlmFetchForTests(stub.fn);
  const prb = { limit: 4, used: 0 };
  settled = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => g.callLlmJson({ ...base, user: `prun-${i}`, cache: false, runBudget: prb })));
  okCount = settled.filter((s) => s.status === "fulfilled").length;
  blocked = settled.filter((s) => s.status === "rejected" && (s.reason as { reason?: string }).reason === "budget_run").length;
  check("10 parallel calls with run budget 4 ⇒ 4 sent", okCount === 4 && blocked === 6 && prb.used === 4 && stub.calls.length === 4);

  g.__resetLlmCountersForTests();
  stub = makeStub(async () => {
    await sleep(20);
    return ok({ answer: 6 });
  });
  g.__setLlmFetchForTests(stub.fn);
  const queued = await Promise.all(Array.from({ length: 8 }, (_, i) => g.callLlmJson({ ...base, user: `queue-${i}`, cache: false })));
  check("8 parallel calls all complete through the 3-slot queue", queued.length === 8 && stub.calls.length === 8 && stub.maxActive <= 3, String(stub.maxActive));
  check("slots released after completion", g.getLlmUsage().inFlight === 0 && g.getLlmUsage().queued === 0);

  g.__resetLlmCountersForTests();
  const dedupe = await Promise.all(Array.from({ length: 3 }, () => g.callLlmJson<{ answer: number }>({ ...base, user: "same-prompt" })));
  check("identical in-flight prompts share one request", dedupe.every((d) => d.data.answer === 6) && stub.calls.length === 9 && g.getLlmUsage().processCalls === 1);

  section("gateway: usage report");
  const usage = g.getLlmUsage();
  const usageJson = JSON.stringify(usage);
  check("usage has model, key flag, limits", usage.model === "gpt-5.6-luna" && usage.keyPresent === true && usage.limits.perProcess === 100 && usage.limits.perDay === 500 && usage.limits.maxOutputTokens === 900);
  check("usage never includes the key", !usageJson.includes(FAKE_KEY) && !/FAKEKEY/.test(usageJson));
}

// ---------- judge ----------

async function testJudge(g: Gateway, j: JudgeMod): Promise<void> {
  section("judge: mock heuristics");
  const ctx = { ...a11yNode, input: contactInput, priorLayers: [] as LayerResult[], crawledPages: PAGES };
  const good = j.mockJudge({ ...ctx, output: GOOD_A11Y_CONTACT });
  check("clean accessibility report passes", good.pass && good.layer === 4 && good.name === "LLM judge" && good.source === "mock", good.reason);
  check("confidence within 0.7-0.95", (good.confidence ?? 0) >= 0.7 && (good.confidence ?? 0) <= 0.95, String(good.confidence));
  const site = { siteUrl: SITE, pages: PAGES };
  for (const [name, cat, out] of [
    ["security", "security", GOOD_SECURITY],
    ["links", "links", GOOD_LINKS],
    ["seo", "seo", GOOD_SEO],
  ] as const) {
    const v = j.mockJudge({ templateId: name, label: name, capability: cat, category: cat, input: site, output: out, priorLayers: [], crawledPages: PAGES });
    check(`clean ${name} report passes`, v.pass, v.reason);
  }
  const crawl = j.mockJudge({ templateId: "crawl", label: "Crawl / map", capability: "crawl", input: { siteUrl: SITE, maxPages: 5 }, output: GOOD_CRAWL, priorLayers: [], crawledPages: [] });
  check("clean crawl passes", crawl.pass, crawl.reason);

  const refusal = j.mockJudge({ ...ctx, output: { issues: [], pagesChecked: [page("contact.html")], summary: "I'm sorry, but I can't access external websites." } });
  check("refusal summary fails", !refusal.pass, refusal.reason);
  const refusalIssue = j.mockJudge({
    ...ctx,
    output: { ...GOOD_A11Y_CONTACT, issues: [{ ...GOOD_A11Y_CONTACT.issues[0], description: "As an AI language model, I cannot browse this page." }] },
  });
  check("refusal inside an issue fails", !refusalIssue.pass);
  const boiler = j.mockJudge({
    ...ctx,
    output: {
      issues: Array.from({ length: 5 }, () => ({
        category: "accessibility",
        severity: "medium",
        rule: "image-alt",
        pageUrl: page("contact.html"),
        description: "Accessibility issue found",
        recommendation: "Fix the issue.",
        evidence: "",
      })),
      pagesChecked: [page("contact.html")],
    },
  });
  check("generic boilerplate fails", !boiler.pass, boiler.reason);
  const genericDistinct = j.mockJudge({
    ...ctx,
    output: {
      issues: ["Some issues were found", "Multiple issues detected", "Needs improvement"].map((d) => ({
        category: "accessibility",
        severity: "low",
        rule: "label",
        pageUrl: page("contact.html"),
        description: d,
        recommendation: "Add labels to the form fields.",
        evidence: "form markup",
      })),
      pagesChecked: [page("contact.html")],
    },
  });
  check("generic descriptions fail", !genericDistinct.pass, genericDistinct.reason);
  const noEvidence = j.mockJudge({ ...ctx, output: { ...GOOD_A11Y_CONTACT, issues: GOOD_A11Y_CONTACT.issues.map((i) => ({ ...i, evidence: "" })) } });
  check("missing evidence fails", !noEvidence.pass, noEvidence.reason);
  const restated = j.mockJudge({ ...ctx, output: { ...GOOD_A11Y_CONTACT, issues: GOOD_A11Y_CONTACT.issues.map((i) => ({ ...i, recommendation: i.description })) } });
  check("recommendation restating the problem fails", !restated.pass, restated.reason);
  const wrongCat = j.mockJudge({ ...ctx, output: { ...GOOD_A11Y_CONTACT, issues: [{ ...GOOD_A11Y_CONTACT.issues[0], category: "seo" }] } });
  check("wrong category fails", !wrongCat.pass, wrongCat.reason);
  const hallucinated = j.mockJudge({ ...ctx, output: { ...GOOD_A11Y_CONTACT, issues: [{ ...GOOD_A11Y_CONTACT.issues[0], pageUrl: page("careers.html") }] } });
  check("hallucinated page fails", !hallucinated.pass, hallucinated.reason);
  const dupes = j.mockJudge({ ...ctx, output: { ...GOOD_A11Y_CONTACT, issues: [...GOOD_A11Y_CONTACT.issues, GOOD_A11Y_CONTACT.issues[0]] } });
  check("verbatim duplicate findings fail", !dupes.pass, dupes.reason);
  const placeholderIssue = j.mockJudge({
    ...ctx,
    output: {
      issues: [{ category: "accessibility", severity: "high", rule: "image-alt", pageUrl: page("contact.html"), description: "Page is missing critical markup", recommendation: "Add the missing markup", evidence: "Observed during audit" }],
      pagesChecked: [page("contact.html")],
    },
  });
  check("engine placeholder issue (vague markup claim) fails", !placeholderIssue.pass, placeholderIssue.reason);
  const prior: LayerResult[] = [{ layer: 3, name: "Spot-check", pass: true, reason: "Recall 0/2 on contact page", details: { recall: { found: 0, expected: 2, ratio: 0 } } }];
  const emptyExpected = j.mockJudge({ ...ctx, output: { issues: [], pagesChecked: [page("contact.html")] }, priorLayers: prior });
  check("empty report fails when earlier layers expect issues", !emptyExpected.pass, emptyExpected.reason);
  const emptyFine = j.mockJudge({ ...ctx, output: { issues: [], pagesChecked: [page("contact.html")] } });
  check("empty report passes when nothing is expected", emptyFine.pass && (emptyFine.confidence ?? 0) >= 0.7);
  const crawlDup = j.mockJudge({
    templateId: "crawl",
    label: "Crawl",
    capability: "crawl",
    input: { siteUrl: SITE, maxPages: 5 },
    output: { pages: [...GOOD_CRAWL.pages.slice(0, 2), { url: page("index.html"), title: "dup", status: 200 }] },
    priorLayers: [],
    crawledPages: [],
  });
  check("crawl with duplicate (index.html ≡ /) fails", !crawlDup.pass, crawlDup.reason);
  const crawlOff = j.mockJudge({
    templateId: "crawl",
    label: "Crawl",
    capability: "crawl",
    input: { siteUrl: SITE, maxPages: 5 },
    output: { pages: [...GOOD_CRAWL.pages.slice(0, 2), { url: "https://elsewhere.example/", title: "x", status: 200 }] },
    priorLayers: [],
    crawledPages: [],
  });
  check("crawl with off-site page fails", !crawlOff.pass);
  const crawlNoSlash = j.mockJudge({
    templateId: "crawl",
    label: "Crawl",
    capability: "crawl",
    input: { siteUrl: SITE.replace(/\/$/, ""), maxPages: 5 },
    output: GOOD_CRAWL,
    priorLayers: [],
    crawledPages: [],
  });
  check("site URL without trailing slash still finds the home page", crawlNoSlash.pass && /home page included/.test(crawlNoSlash.reason), crawlNoSlash.reason);

  section("judge: live judge");
  g.__resetLlmCountersForTests();
  let stub = makeStub(() => ok({ pass: true, reason: "Findings name #email and #send-btn with markup evidence.", confidence: 1.4 }));
  g.__setLlmFetchForTests(stub.fn);
  const exhausted = await j.liveJudge({ ...ctx, output: GOOD_A11Y_CONTACT }, { limit: 1, used: 1 });
  check("exhausted run budget ⇒ budget_fallback without fetch", exhausted.source === "budget_fallback" && stub.calls.length === 0 && exhausted.pass === good.pass, exhausted.reason);
  check("fallback reason says why", /^Live judge unavailable \(this run's LLM budget is used up\)/.test(exhausted.reason), exhausted.reason);
  const budget = { limit: 5, used: 0 };
  const live = await j.liveJudge({ ...ctx, output: GOOD_A11Y_CONTACT }, budget);
  check("live verdict from the model", live.source === "llm" && live.pass && live.layer === 4 && budget.used === 1, live.reason);
  check("confidence clamped to [0,1]", live.confidence === 1, String(live.confidence));
  check("judge prompt uses the fixed rubric and strict schema", stub.calls[0].body.instructions === (await import("@/lib/llm/rubric")).JUDGE_RUBRIC && (stub.calls[0].body.text as { format: { name: string } }).format.name === "judge_verdict");
  const again = await j.liveJudge({ ...ctx, output: GOOD_A11Y_CONTACT }, budget);
  check("repeat verdict ⇒ source cache, no fetch, no budget", again.source === "cache" && stub.calls.length === 1 && budget.used === 1);

  stub = makeStub(() => ok({ pass: "yes", reason: "", confidence: 0.5 }));
  g.__setLlmFetchForTests(stub.fn);
  const invalid = await j.liveJudge({ ...ctx, output: GOOD_SECURITY, category: "security", templateId: "security" });
  check("invalid model verdict ⇒ heuristic fallback", invalid.source === "budget_fallback" && /unreadable model response/.test(invalid.reason), invalid.reason);
  stub = makeStub(() => new Response("{}", { status: 500 }));
  g.__setLlmFetchForTests(stub.fn);
  const http500 = await j.liveJudge({ ...ctx, output: GOOD_LINKS, category: "links", templateId: "links" });
  check("HTTP failure ⇒ fallback naming the status", http500.source === "budget_fallback" && /HTTP 500/.test(http500.reason) && stub.calls.length === 1);

  stub = makeStub(() => ok({ pass: false, reason: "Too long to judge.", confidence: -3 }));
  g.__setLlmFetchForTests(stub.fn);
  const big: AuditOutput = {
    issues: Array.from({ length: 60 }, (_, i) => ({
      ...GOOD_A11Y_CONTACT.issues[0],
      selector: `#field-${i}`,
      description: `Field #field-${i} has no label. ${"x".repeat(900)}`,
      evidence: "y".repeat(900),
    })),
    pagesChecked: [page("contact.html")],
  };
  const bigVerdict = await j.liveJudge({ ...ctx, output: big });
  const sent = String(stub.calls[0]?.body.input ?? "");
  const compact = j.compactOutput(big);
  check("large output truncated to 25 issues", /showing 25 of 60 issues/.test(sent) || /showing \d+ of 60 issues/.test(sent), sent.slice(0, 200));
  check("output part under ~6000 chars", compact.json.length <= 6000, String(compact.json.length));
  check("whole judge prompt stays small", sent.length < 9000, String(sent.length));
  check("negative confidence clamped to 0", bigVerdict.confidence === 0 && bigVerdict.pass === false);
}

// ---------- adapter ----------

async function testAdapter(g: Gateway, a: AdapterMod): Promise<void> {
  const { getTemplate } = await import("@/config/workflow");
  section("adapter: template instruction");
  const agent = { agentId: "mock-a11y-1", capabilityId: "cap-1", name: "Mock A11y", source: "mock" as const };
  const t1 = await a.adaptInput({ agent, template: getTemplate("a11y"), input: contactInput, llmMode: "mock" });
  check("no schema ⇒ method template, no arguments", t1.method === "template" && t1.arguments === undefined);
  check("instruction names the page URL and pagesChecked", t1.instruction.includes(page("contact.html")) && t1.instruction.includes('"pagesChecked"'));
  check(
    "instruction lists only this category's rule codes",
    ["image-alt", "color-contrast", "label", "button-name", "html-has-lang"].every((r) => t1.instruction.includes(r)) && !t1.instruction.includes("missing-csp"),
  );
  check("instruction requires absolute URLs and JSON only", /absolute/.test(t1.instruction) && /Return JSON only/.test(t1.instruction) && t1.instruction.includes('"category":"accessibility"'));
  const crawl = await a.adaptInput({ agent, template: getTemplate("crawl"), input: { siteUrl: SITE, maxPages: 5 }, llmMode: "live" });
  check("crawl instruction has the cap and pages shape", /at most 5 pages/.test(crawl.instruction) && crawl.instruction.includes('"pages"') && crawl.method === "template");
  const links = await a.adaptInput({ agent, template: getTemplate("links"), input: { siteUrl: SITE, pages: PAGES }, llmMode: "mock" });
  check("site audit instruction lists pages and link conventions", links.instruction.includes(page("blog.html")) && links.instruction.includes('a[href=') && links.instruction.includes("broken-link"));

  section("adapter: heuristic argument mapping");
  const crawlSchema = {
    type: "object",
    properties: {
      url: { type: "string" },
      max_pages: { type: "integer", minimum: 1, maximum: 20 },
      max_chars: { type: "integer" },
      path_prefix: { type: "string" },
    },
    required: ["url"],
  };
  const h1 = await a.adaptInput({ agent: { ...agent, argumentSchema: crawlSchema }, template: getTemplate("crawl"), input: { siteUrl: SITE, maxPages: 5 }, llmMode: "mock" });
  check("url ⇒ siteUrl, max_pages ⇒ maxPages", h1.method === "template" && h1.arguments?.url === SITE && h1.arguments?.max_pages === 5, JSON.stringify(h1.arguments));
  check("unrelated optional args left out", h1.arguments !== undefined && !("max_chars" in h1.arguments) && !("path_prefix" in h1.arguments));
  const seoSchema = { type: "object", properties: { domain: { type: "string" }, query: { type: "string" }, limit: { type: "number" } }, required: ["domain"] };
  const h2 = await a.adaptInput({ agent: { ...agent, argumentSchema: seoSchema }, template: getTemplate("seo"), input: { siteUrl: SITE, pages: PAGES }, llmMode: "mock" });
  check("domain ⇒ host, query ⇒ instruction, limit ⇒ page count", h2.arguments?.domain === "localhost:3000" && h2.arguments?.query === h2.instruction && h2.arguments?.limit === 5, JSON.stringify(h2.arguments).slice(0, 200));
  const pageSchema = { type: "object", properties: { page_url: { type: "string" }, urls: { type: "array", items: { type: "string" } }, task: { type: "string" } } };
  const h3 = await a.adaptInput({ agent: { ...agent, argumentSchema: pageSchema }, template: getTemplate("a11y"), input: contactInput, llmMode: "mock" });
  check("page_url ⇒ pageUrl, urls ⇒ pages, task ⇒ instruction", h3.arguments?.page_url === page("contact.html") && JSON.stringify(h3.arguments?.urls) === JSON.stringify([page("contact.html")]) && h3.arguments?.task === h3.instruction);

  section("adapter: LLM mapping (live)");
  g.__resetLlmCountersForTests();
  let stub = makeStub(() => ok({ mappings: [{ arg: "url", from: "siteUrl", value: null }, { arg: "max_pages", from: "maxPages", value: null }, { arg: "path_prefix", from: "const", value: "/" }] }));
  g.__setLlmFetchForTests(stub.fn);
  const liveAgent = { ...agent, agentId: "darwin-crawler-1", argumentSchema: crawlSchema };
  const budget = { limit: 5, used: 0 };
  const l1 = await a.adaptInput({ agent: liveAgent, template: getTemplate("crawl"), input: { siteUrl: SITE, maxPages: 3 }, llmMode: "live", budget });
  check("live mapping via one LLM call", l1.method === "llm" && stub.calls.length === 1 && budget.used === 1);
  check("mapping applied to arguments", l1.arguments?.url === SITE && l1.arguments?.max_pages === 3 && l1.arguments?.path_prefix === "/", JSON.stringify(l1.arguments));
  const l2 = await a.adaptInput({ agent: liveAgent, template: getTemplate("crawl"), input: { siteUrl: page("x/"), maxPages: 4 }, llmMode: "live", budget });
  check("second use reuses the cached mapping", l2.method === "cache" && stub.calls.length === 1 && l2.arguments?.url === page("x/") && l2.arguments?.max_pages === 4);
  stub = makeStub(() => ok({ mappings: [{ arg: "bogus", from: "siteUrl", value: null }] }));
  g.__setLlmFetchForTests(stub.fn);
  const l3 = await a.adaptInput({ agent: { ...liveAgent, agentId: "darwin-crawler-2" }, template: getTemplate("crawl"), input: { siteUrl: SITE, maxPages: 5 }, llmMode: "live", budget });
  check("invalid LLM mapping ⇒ heuristic fallback", l3.method === "template" && l3.arguments?.url === SITE && stub.calls.length === 1);
  const l4 = await a.adaptInput({ agent: { ...liveAgent, agentId: "darwin-crawler-3" }, template: getTemplate("crawl"), input: { siteUrl: SITE, maxPages: 5 }, llmMode: "live", budget: { limit: 2, used: 2 } });
  check("exhausted budget ⇒ heuristic, no fetch", l4.method === "template" && stub.calls.length === 1 && l4.arguments?.url === SITE);

  section("adapter: one LLM call per agent+template under fan-out");
  const pageArgSchema = { type: "object", properties: { page_url: { type: "string" }, instructions: { type: "string" } }, required: ["page_url"] };
  stub = makeStub(async () => {
    await sleep(30);
    return ok({ mappings: [{ arg: "page_url", from: "pageUrl", value: null }, { arg: "instructions", from: "instruction", value: null }] });
  });
  g.__setLlmFetchForTests(stub.fn);
  const fanAgent = { ...agent, agentId: "darwin-a11y-fanout", argumentSchema: pageArgSchema };
  const fanBudget = { limit: 20, used: 0 };
  const fan = await Promise.all(
    PAGES.map((p) => a.adaptInput({ agent: fanAgent, template: getTemplate("a11y"), input: { siteUrl: SITE, pageUrl: p }, llmMode: "live", budget: fanBudget })),
  );
  check(
    "5 parallel page instances share one mapping call",
    stub.calls.length === 1 && fanBudget.used === 1 && fan.filter((x) => x.method === "llm").length === 1 && fan.every((x, i) => x.arguments?.page_url === PAGES[i]),
    `${stub.calls.length} calls, methods ${fan.map((x) => x.method).join(",")}`,
  );
  stub = makeStub(() => new Response("{}", { status: 500 }));
  g.__setLlmFetchForTests(stub.fn);
  const failAgent = { ...agent, agentId: "darwin-a11y-failing", argumentSchema: pageArgSchema };
  const failBudget = { limit: 20, used: 0 };
  const failed1 = await a.adaptInput({ agent: failAgent, template: getTemplate("a11y"), input: contactInput, llmMode: "live", budget: failBudget });
  const failedRest = await Promise.all(
    PAGES.map((p) => a.adaptInput({ agent: failAgent, template: getTemplate("a11y"), input: { siteUrl: SITE, pageUrl: p }, llmMode: "live", budget: failBudget })),
  );
  check(
    "a failed mapping call is not repeated by later attempts (heuristic used)",
    stub.calls.length === 1 && failBudget.used === 1 && [failed1, ...failedRest].every((x) => x.method === "template" && typeof x.arguments?.page_url === "string"),
    `${stub.calls.length} calls`,
  );
  const blockedAgent = { ...agent, agentId: "darwin-a11y-blocked", argumentSchema: pageArgSchema };
  await a.adaptInput({ agent: blockedAgent, template: getTemplate("a11y"), input: contactInput, llmMode: "live", budget: { limit: 0, used: 0 } });
  stub = makeStub(() => ok({ mappings: [{ arg: "page_url", from: "pageUrl", value: null }] }));
  g.__setLlmFetchForTests(stub.fn);
  const unblocked = await a.adaptInput({ agent: blockedAgent, template: getTemplate("a11y"), input: contactInput, llmMode: "live", budget: { limit: 5, used: 0 } });
  check("a budget-blocked attempt does not suppress the next run's call", unblocked.method === "llm" && stub.calls.length === 1);
  const mockFan = await a.adaptInput({ agent: { ...fanAgent, agentId: "darwin-a11y-mock" }, template: getTemplate("a11y"), input: contactInput, llmMode: "mock" });
  check("mock mode with a schema never calls the LLM", mockFan.method === "template" && stub.calls.length === 1);
}

// ---------- fix plan ----------

async function testFixplan(g: Gateway, f: FixplanMod): Promise<void> {
  section("fixplan: template");
  const prioritized = prioritizedFixture();
  const partial = [{ nodeId: "links", label: "Broken links" }];
  const plan = f.templateFixPlan({ prioritized, siteUrl: SITE, partialBranches: partial });
  check("5 drafted fixes", plan.topFixes.length === 5, String(plan.topFixes.length));
  check("summary grammar", !/fixs\b/.test(plan.summary), plan.summary);
  const repeated: PrioritizedOutput = {
    dedupedFrom: 6,
    issues: ["", "about.html", "blog.html"].flatMap((p, k) => [
      { ...prioritized.issues[3], id: `alt-${k}`, pageUrl: page(p), priority: k + 1 },
      { ...prioritized.issues[6], id: `contrast-${k}`, pageUrl: page(p), priority: k + 10 },
    ]),
  };
  const grouped = f.templateFixPlan({ prioritized: repeated, siteUrl: SITE, partialBranches: [] });
  check("same-rule issues share one draft", grouped.topFixes.length === 2 && /same fix for 2 more issues/.test(grouped.topFixes[0].title), grouped.topFixes.map((x) => x.title).join(" | "));
  check("drafted <title> uses a readable site name", f.draftFix(prioritized.issues[4], { siteUrl: SITE, knownPages: PAGES, allIssues: prioritized.issues }).patch.includes("<title>About | Demo Site</title>"));
  check("fixes reference distinct prioritized issues", new Set(plan.topFixes.map((x) => x.issueId)).size === 5 && plan.topFixes.every((x) => prioritized.issues.some((i) => i.id === x.issueId)));
  check("every fix has title, patch and language", plan.topFixes.every((x) => x.title && x.patch.trim() && x.language));
  const headerFixes = plan.topFixes.filter((x) => x.patch.includes("Content-Security-Policy") || x.patch.includes("Strict-Transport-Security"));
  check("security headers combined into one draft", headerFixes.length === 1 && ["Content-Security-Policy", "Strict-Transport-Security", "X-Frame-Options"].every((h) => headerFixes[0].patch.includes(h)));
  check("form fix switches to https", plan.topFixes[0].patch.includes('action="https://forms.tidepool-demo.invalid/contact"'), plan.topFixes[0].patch);
  check("headline counts issues; summary counts severities and calls out partial branch", /12 problems/.test(plan.headline) && /1 critical/.test(plan.summary) && plan.summary.includes("Broken links") && plan.source === "template", `${plan.headline} | ${plan.summary}`);
  const ctx = { siteUrl: SITE, knownPages: PAGES, allIssues: prioritized.issues };
  const byRule = (rule: string) => f.draftFix(prioritized.issues.find((i) => i.rule === rule)!, ctx);
  const contrast = byRule("color-contrast");
  const newColor = /color:\s*(#[0-9a-f]{6})/i.exec(contrast.patch)?.[1] ?? "";
  check("contrast fix picks a passing color", f.contrastRatio(newColor, "#ffffff") >= 4.5 && contrast.patch.includes(".tagline"), contrast.patch);
  check("broken link points at the closest live page", byRule("broken-link").patch.includes('+ <a href="pricing.html">'), byRule("broken-link").patch);
  check("render-blocking script gets defer", byRule("render-blocking-script").patch.includes('<script src="js/analytics.js" defer>'));
  check("robots.txt links the sitemap", byRule("robots-txt").patch.includes("Sitemap: http://localhost:3000/demo-site/sitemap.xml"));
  check("sitemap lists known pages", byRule("sitemap").patch.includes(`<loc>${page("about.html")}</loc>`));
  const ampSitemap = f.draftFix(prioritized.issues.find((i) => i.rule === "sitemap")!, { ...ctx, knownPages: [page("terms&privacy.html")] }).patch;
  check("sitemap URLs are XML-escaped", ampSitemap.includes("terms&amp;privacy.html") && !ampSitemap.includes("terms&privacy"), ampSitemap);
  check("image-alt fix adds alt to the image", /<img id="hero-img" src="img\/hero.png" alt="/.test(byRule("image-alt").patch), byRule("image-alt").patch);
  check("oversized image fix sizes and re-encodes", /width="\d+" height="\d+"/.test(byRule("oversized-image").patch) && byRule("oversized-image").patch.includes("img/hero.webp") && /3\.0 MB/.test(byRule("oversized-image").patch), byRule("oversized-image").patch);
  const empty = f.templateFixPlan({ prioritized: { issues: [], dedupedFrom: 0 }, siteUrl: SITE, partialBranches: [] });
  check("empty plan ⇒ no fixes, clean headline", empty.topFixes.length === 0 && /No problems/.test(empty.headline));

  section("fixplan: live");
  g.__resetLlmCountersForTests();
  let stub = makeStub(() =>
    ok({
      headline: "12 issues; fix the insecure contact form first",
      summary: "One critical and five high-severity issues lead the list.",
      topFixes: prioritized.issues.slice(0, 3).map((i) => ({ issueId: i.id, title: `Fix ${i.rule}`, patch: `<!-- ${i.rule} -->`, language: "html" })),
    }),
  );
  g.__setLlmFetchForTests(stub.fn);
  const mock = await f.buildFixPlan({ prioritized, siteUrl: SITE, partialBranches: partial, llmMode: "mock" });
  check("mock mode never calls the LLM", mock.source === "template" && stub.calls.length === 0);
  const budget = { limit: 3, used: 0 };
  const live = await f.buildFixPlan({ prioritized, siteUrl: SITE, partialBranches: partial, llmMode: "live", budget });
  check("live plan from one call", live.source === "llm" && live.topFixes.length === 3 && stub.calls.length === 1 && budget.used === 1);
  check("partial branch appended when the model omits it", live.summary.includes("Broken links"), live.summary);
  const sentIssues = String(stub.calls[0].body.input);
  check("prompt carries at most 5 issues", (sentIssues.match(/"issueId"/g) ?? []).length === 5);
  stub = makeStub(() => ok({ headline: "h", summary: "s", topFixes: [{ issueId: "not-a-real-id", title: "t", patch: "p", language: "html" }] }));
  g.__setLlmFetchForTests(stub.fn);
  const invalid = await f.buildFixPlan({ prioritized, siteUrl: SITE, partialBranches: [], llmMode: "live", budget });
  check("unknown issueId ⇒ template fallback", invalid.source === "template" && invalid.topFixes.length === 5 && stub.calls.length === 1);
  const invalidAgain = await f.buildFixPlan({ prioritized, siteUrl: SITE, partialBranches: [], llmMode: "live", budget });
  check("invalid plan was not cached (asked again, still budgeted)", invalidAgain.source === "template" && stub.calls.length === 2 && budget.used === 3);
  const exhausted = await f.buildFixPlan({ prioritized, siteUrl: SITE, partialBranches: [], llmMode: "live", budget });
  check("exhausted budget ⇒ template, no fetch", exhausted.source === "template" && stub.calls.length === 2);
  const emptyLive = await f.buildFixPlan({ prioritized: { issues: [], dedupedFrom: 0 }, siteUrl: SITE, partialBranches: [], llmMode: "live" });
  check("no issues ⇒ no LLM call", emptyLive.source === "template" && stub.calls.length === 2);
}

// ---------- optional: real audit toolkit outputs must pass the mock judge ----------

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "text/javascript",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

function serveDemoSite(): Promise<{ base: string; close: () => Promise<void> }> {
  const root = path.resolve(process.cwd(), "demo-site");
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (!url.pathname.startsWith("/demo-site/")) {
      res.writeHead(404, { "content-type": "text/html" }).end("<h1>Not found</h1>");
      return;
    }
    const rel = decodeURIComponent(url.pathname.slice("/demo-site/".length)) || "index.html";
    const file = path.resolve(root, rel);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile() || rel === "ground-truth.json") {
      res.writeHead(404, { "content-type": "text/html" }).end("<h1>Not found</h1>");
      return;
    }
    const body = fs.readFileSync(file);
    res.writeHead(200, { "content-type": CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream", "content-length": body.length });
    res.end(req.method === "HEAD" ? undefined : body);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ base: `http://127.0.0.1:${port}/demo-site/`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

async function testAgainstAuditToolkit(j: JudgeMod): Promise<void> {
  section("judge vs local audit toolkit (demo site)");
  if (!fs.existsSync(path.resolve(process.cwd(), "src/lib/audit/index.ts"))) {
    console.log("  skip  src/lib/audit/index.ts not present");
    return;
  }
  const auditMod = (await import("@/lib/audit/index" as string)) as {
    runCapability: (c: string, input: unknown) => Promise<unknown>;
  };
  const srv = await serveDemoSite();
  try {
    const crawl = (await auditMod.runCapability("crawl", { siteUrl: srv.base, maxPages: 5 })) as { pages: { url: string }[] };
    const crawled = crawl.pages.map((p) => p.url);
    const v = j.mockJudge({ templateId: "crawl", label: "Crawl / map", capability: "crawl", input: { siteUrl: srv.base, maxPages: 5 }, output: crawl, priorLayers: [], crawledPages: [] });
    check(`toolkit crawl passes (${crawled.length} pages)`, v.pass, v.reason);
    for (const cat of ["accessibility", "performance"] as const) {
      for (const p of crawled) {
        const input = { siteUrl: srv.base, pageUrl: p };
        const out = await auditMod.runCapability(cat, input);
        const r = j.mockJudge({ templateId: cat, label: cat, capability: cat, category: cat, input, output: out, priorLayers: [], crawledPages: crawled });
        check(`toolkit ${cat} ${p.replace(srv.base, "/") || "/"} passes`, r.pass, r.reason);
      }
    }
    for (const cat of ["seo", "security", "links"] as const) {
      const input = { siteUrl: srv.base, pages: crawled };
      const out = await auditMod.runCapability(cat, input);
      const r = j.mockJudge({ templateId: cat, label: cat, capability: cat, category: cat, input, output: out, priorLayers: [], crawledPages: crawled });
      check(`toolkit ${cat} passes`, r.pass, r.reason);
    }
  } catch (err) {
    console.log(`  skip  audit toolkit not usable yet: ${(err as Error).message.slice(0, 160)}`);
  } finally {
    await srv.close();
  }
}

// ---------- cross-process day cap ----------

const CHILD_CALLS = 10;

/** Child process body: waits for a shared start time, then fires all its calls at once. */
async function usageChild(): Promise<void> {
  const g: Gateway = await import("@/lib/llm/gateway");
  g.__setLlmFetchForTests(async () => ok({ answer: 1 }));
  g.__setLlmLimitsForTests({ perDay: Number(process.env.LLM_TEST_CHILD_PER_DAY) || 1 });
  const startAt = Number(process.env.LLM_TEST_START_AT) || 0;
  while (Date.now() < startAt) await sleep(1);
  const schema = { type: "object", properties: { answer: { type: "number" } }, required: ["answer"], additionalProperties: false };
  const settled = await Promise.allSettled(
    Array.from({ length: CHILD_CALLS }, (_, i) =>
      g.callLlmJson({ purpose: "test", system: "s", user: `child-${process.pid}-${i}`, schemaName: "answer", schema, cache: false }),
    ),
  );
  const reasons = settled.flatMap((s) => (s.status === "rejected" ? [String((s.reason as { reason?: string }).reason)] : []));
  process.stdout.write(`${JSON.stringify({ sent: settled.length - reasons.length, reasons })}\n`);
}

function runChild(startAt: number, perDay: number): Promise<{ sent: number; reasons: string[] }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...process.execArgv, process.argv[1], "--usage-child"], {
      env: { ...process.env, LLM_TEST_CHILD_DIR: DATA_DIR, LLM_TEST_START_AT: String(startAt), LLM_TEST_CHILD_PER_DAY: String(perDay) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (err += String(d)));
    child.on("error", reject);
    child.on("close", (code) => {
      const line = out.trim().split("\n").pop() ?? "";
      try {
        resolve(JSON.parse(line) as { sent: number; reasons: string[] });
      } catch {
        reject(new Error(`child exited ${code}: ${(err || out).slice(0, 300)}`));
      }
    });
  });
}

async function testCrossProcessDayCap(g: Gateway): Promise<void> {
  section("gateway: day cap shared across processes");
  const usagePath = path.join(DATA_DIR, "llm-usage.json");
  fs.rmSync(usagePath, { force: true });
  const day = g.getLlmUsage().day;
  const perDay = 25;
  const processes = 4;
  const startAt = Date.now() + 6000;
  const results = await Promise.all(Array.from({ length: processes }, () => runChild(startAt, perDay)));
  const sent = results.reduce((n, r) => n + r.sent, 0);
  const persisted = (JSON.parse(fs.readFileSync(usagePath, "utf8")) as Record<string, { calls: number }>)[day]?.calls;
  const otherReasons = results.flatMap((r) => r.reasons).filter((r) => r !== "budget_day");
  check(
    `${processes} processes x ${CHILD_CALLS} parallel calls under a day cap of ${perDay} ⇒ exactly ${perDay} sent and persisted`,
    sent === perDay && persisted === perDay && otherReasons.length === 0,
    `${sent} sent, ${persisted} persisted, other failures: ${otherReasons.join(",") || "none"}`,
  );
  check("no lock or temp files left behind", fs.readdirSync(DATA_DIR).every((f) => !f.endsWith(".tmp") && !f.endsWith(".lock")));
  fs.rmSync(usagePath, { force: true });
}

// ---------- main ----------

async function main(): Promise<void> {
  const g: Gateway = await import("@/lib/llm/gateway");
  const envMod = await import("@/lib/env");
  const j: JudgeMod = await import("@/lib/llm/judge");
  const a: AdapterMod = await import("@/lib/llm/adapter");
  const f: FixplanMod = await import("@/lib/llm/fixplan");

  await testGateway(g, envMod);
  await testCrossProcessDayCap(g);
  await testJudge(g, j);
  await testAdapter(g, a);
  await testFixplan(g, f);
  g.__setLlmFetchForTests(null);
  await testAgainstAuditToolkit(j);

  section("secrets");
  const leaked = seenMessages.filter((m) => m.includes(FAKE_KEY) || /FAKEKEY/.test(m));
  check(`no error message contains the key (${seenMessages.length} checked)`, leaked.length === 0, leaked[0]);
}

function runMain(): void {
  main()
    .catch((err) => {
      failed += 1;
      console.error("test run crashed:", err instanceof Error ? err.stack : err);
    })
    .finally(() => {
      try {
        fs.rmSync(DATA_DIR, { recursive: true, force: true });
      } catch {
        // temp dir cleanup is best effort
      }
      console.log(`\n${passed} passed, ${failed} failed`);
      process.exit(failed ? 1 : 0);
    });
}

if (CHILD_MODE) {
  usageChild()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
} else {
  runMain();
}
