// Offline tests for RealDarwinClient. No network: every request goes through an injected fetch.
// Run: npx tsx --tsconfig tsconfig.json scripts/test-darwin-real.ts
import fs from "node:fs";
import path from "node:path";
import { AGENT_TEMPLATES } from "@/config/workflow";
import { TransportError, type StartTaskParams, type TaskHandle, type TaskPoll } from "@/lib/darwin/types";
import { DarwinApiError, RealDarwinClient } from "@/lib/darwin/real";
import { extractJson } from "@/lib/darwin/normalize";
import type { AgentRef } from "@/lib/types";

// Any accidental real request fails loudly.
globalThis.fetch = (async () => {
  throw new Error("network access is not allowed in this test");
}) as typeof fetch;

const FIXTURES = path.join(process.cwd(), "fixtures/darwin-search");
const API = "https://darwin.test/api";
const TOKEN = "test-access-token-0000";
const API_KEY = "test-api-key-0000";

// ---------- tiny harness ----------

let failures = 0;
let passes = 0;

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passes++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function expectThrow(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected an error, got none");
}

// ---------- fake Darwin ----------

interface Call {
  method: string;
  url: URL;
  headers: Headers;
  body: unknown;
}

type Reply = { status?: number; body?: unknown; headers?: Record<string, string>; text?: string };
type Handler = (call: Call) => Reply | Promise<Reply>;

function fakeFetch(handler: Handler, calls: Call[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const raw = typeof init?.body === "string" ? init.body : undefined;
    const call: Call = { method: init?.method ?? "GET", url, headers: new Headers(init?.headers), body: raw ? JSON.parse(raw) : undefined };
    calls.push(call);
    const reply = await handler(call);
    const text = reply.text ?? (reply.body === undefined ? "" : JSON.stringify(reply.body));
    return new Response(text, { status: reply.status ?? 200, headers: { "content-type": "application/json", ...reply.headers } });
  }) as typeof fetch;
}

function client(handler: Handler, calls: Call[] = [], extra: { accessToken?: string; apiKey?: string; timeoutMs?: number } = {}) {
  return new RealDarwinClient({
    apiBase: API,
    accessToken: extra.accessToken ?? "",
    apiKey: extra.apiKey ?? "",
    fetchImpl: fakeFetch(handler, calls),
    now: () => 1_000,
    timeoutMs: extra.timeoutMs,
  });
}

// ---------- Act fixtures (shapes from ActV3Response / ActV3RequestResponse) ----------

const AGENT: AgentRef = {
  agentId: "mcp-agent:9a9bd1bf02b7d44ee145a877c4ef5cb5eda23caf",
  capabilityId: "mcp-tool:fc964887fdf90dcb8e34c647b5f00662a206d021",
  name: "Audit a site for SEO problems",
  source: "darwin",
};
const AT = "2026-10-10T10:00:00.000Z";
const LATER = "2026-10-10T10:00:05.000Z";

function params(key = "idem-attempt-1", extra: Partial<StartTaskParams> = {}): StartTaskParams {
  return {
    agent: AGENT,
    instruction: "Audit http://localhost:3000/demo-site/ for SEO issues and reply with JSON.",
    idempotencyKey: key,
    context: { runId: "run1", nodeInstanceId: "seo", capability: "seo", input: { siteUrl: "http://localhost:3000/demo-site/", pages: [] }, seed: 1, attemptNo: 1, timeScale: 1 },
    ...extra,
  };
}

interface StateParts {
  messages?: unknown[];
  actions?: unknown[];
  requests?: unknown[];
  errors?: unknown[];
  cursor?: string;
  hasMore?: boolean;
  archived?: boolean;
}

function thread(parts: StateParts = {}, extra: Record<string, unknown> = {}) {
  return {
    agentId: AGENT.agentId,
    capabilityId: AGENT.capabilityId,
    threadId: "thr_1",
    messageId: "msg_you_1",
    ...extra,
    state: {
      thread: "thr_1",
      messages: parts.messages ?? [],
      ...(parts.errors ? { errors: parts.errors } : {}),
      actions: parts.actions ?? [],
      requests: parts.requests ?? [],
      cursor: parts.cursor ?? "c1",
      hasMore: parts.hasMore ?? false,
      archived: parts.archived ?? false,
      needsAttention: false,
    },
  };
}

function receipt(t: unknown, status = "pending") {
  return { type: "request", actRequestId: "actreq_1", searchId: null, status, createdAt: AT, threads: [t] };
}

const youMessage = { message: "msg_you_1", from: "you", content: [{ type: "text", text: "Audit the site." }], status: "accepted", createdAt: AT, type: "message" };

function resultMessage(text: string, data?: unknown) {
  return { message: "msg_res_1", from: "agent", content: [{ type: "text", text }], status: "delivered", createdAt: LATER, type: "result", ...(data !== undefined ? { data } : {}) };
}

/** Darwin double: POST /v3/act returns the start receipt; each GET returns the next thread state. */
function actServer(pollStates: unknown[], start: Reply = { body: receipt(thread({ messages: [youMessage] })) }): Handler {
  let poll = 0;
  return (call) => {
    if (call.method === "POST" && call.url.pathname === "/api/v3/act") return start;
    if (call.method === "GET" && call.url.pathname === "/api/v3/act/requests/actreq_1") {
      const t = pollStates[Math.min(poll, pollStates.length - 1)];
      poll++;
      return { body: receipt(t) };
    }
    return { status: 404, body: { code: "NOT_FOUND", message: "no route" } };
  };
}

async function startAndPoll(handler: Handler, polls: number, calls: Call[] = []): Promise<{ handle: TaskHandle; results: TaskPoll[] }> {
  const c = client(handler, calls, { accessToken: TOKEN });
  const handle = await c.startTask(params());
  const results: TaskPoll[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < polls; i++) {
    const r = await c.pollTask(handle, cursor);
    results.push(r);
    cursor = r.cursor;
  }
  return { handle, results };
}

// ---------- tests ----------

function fixtureQuery(file: string): { query: string; capability?: string } {
  const base = path.basename(file, ".json");
  const t = AGENT_TEMPLATES.find((tpl) => (tpl.query ?? "").replace(/ /g, "_").startsWith(base));
  return { query: t?.query ?? base.replace(/_/g, " ").trim(), capability: t?.capability };
}

async function testSearchFixtures(): Promise<void> {
  console.log("\nSearch fixtures (anonymous, mapped through RealDarwinClient.search)");
  const files = fs.readdirSync(FIXTURES).filter((f) => f.endsWith(".json")).sort();
  const rows: string[][] = [];
  await check("six fixtures present", () => assert(files.length === 6, `found ${files.length}`));
  for (const file of files) {
    const body = JSON.parse(fs.readFileSync(path.join(FIXTURES, file), "utf8"));
    const { query, capability } = fixtureQuery(file);
    const calls: Call[] = [];
    const c = client(() => ({ body }), calls);
    const result = await c.search(query);
    rows.push([query, result.status, String(result.agents.length), result.agents[0] ? `${result.agents[0].name} / ${result.agents[0].readiness}` : "-"]);
    await check(`${file}: maps every agent`, () => {
      assert(result.searchId === body.searchId, "searchId");
      assert(result.status === body.status, "status");
      assert(result.agents.length === Math.min(8, body.response.agents.length), `agents ${result.agents.length}`);
      for (const [i, a] of result.agents.entries()) {
        const src = body.response.agents[i];
        assert(a.agentId === src.agentId && a.capabilityId === src.capabilityId, "ids");
        assert(a.source === "darwin", "source");
        assert(a.readiness === src.readiness, "readiness passed through");
        assert(a.canStartThread === src.canStartThread, "canStartThread");
        assert(a.rank === src.rank, "rank");
        assert(a.argumentSchema === null, "argumentSchema");
        assert(typeof a.provider === "string" && a.provider.length > 0, "provider");
        assert(!capability || a.capability === capability, `capability ${a.capability} != ${capability}`);
        assert(a.searchId === body.searchId, "searchId on agent");
      }
      if (body.status !== "completed") assert(result.note, "note for non-completed status");
    });
    await check(`${file}: request body is only { query, maxResults }, anonymous`, () => {
      assert(calls.length === 1 && calls[0].method === "POST" && calls[0].url.pathname === "/api/v3/search", "endpoint");
      assert(JSON.stringify(Object.keys(calls[0].body as object).sort()) === JSON.stringify(["maxResults", "query"]), "body keys");
      assert(!calls[0].headers.has("authorization") && !calls[0].headers.has("x-api-key"), "no credentials");
    });
  }
  console.log("");
  console.table(rows.map(([query, status, agents, first]) => ({ query, status, agents: Number(agents), first })));
}

async function testSearchDetails(): Promise<void> {
  console.log("\nSearch details");
  const seo = JSON.parse(fs.readFileSync(path.join(FIXTURES, "SEO_audit_of_a_website.json"), "utf8"));
  const noMatch = JSON.parse(fs.readFileSync(path.join(FIXTURES, "WCAG_accessibility_audit_of_a_.json"), "utf8"));
  const clarify = JSON.parse(fs.readFileSync(path.join(FIXTURES, "find_broken_links_on_a_website.json"), "utf8"));

  await check("first SEO agent mapping", async () => {
    const r = await client(() => ({ body: seo })).search("SEO audit of a website");
    const a = r.agents[0];
    assert(a.name === "Audit a site for SEO problems", a.name);
    assert(a.provider === "MCP server", `provider ${a.provider}`);
    assert(a.readiness === "unavailable" && a.canStartThread === false && a.providerCheck === "not_attempted", "readiness");
    assert(a.capability === "seo", a.capability);
    assert(a.reasons.length === 1 && a.uncertainties.length === 1, "reasons/uncertainties");
    assert(typeof a.connectionPrompt === "string" && a.connectionPrompt.includes("targets"), "connectionPrompt");
    assert(r.note?.startsWith("Several tools"), "assessment explanation as note");
  });
  await check("no_match note is noMatchReason", async () => {
    const r = await client(() => ({ body: noMatch })).search("WCAG accessibility audit of a web page");
    assert(r.agents.length === 0 && r.note === noMatch.response.noMatchReason, String(r.note));
  });
  await check("needs_input note carries the question", async () => {
    const r = await client(() => ({ body: clarify })).search("find broken links on a website");
    assert(r.note?.includes(`Darwin asks: ${clarify.response.question}`), String(r.note));
  });
  await check("explicit capability wins; maxResults caps agents and is sent", async () => {
    const calls: Call[] = [];
    const r = await client(() => ({ body: seo }), calls).search("anything", { maxResults: 2, capability: "links" });
    assert(r.agents.length === 2 && r.agents.every((a) => a.capability === "links"), "capability/cap");
    assert((calls[0].body as { maxResults: number }).maxResults === 2, "maxResults sent");
  });
  await check("searchToken kept in memory, returned server-side, never in agents", async () => {
    const c = client(() => ({ body: { ...seo, searchToken: "stok_test_value_123" } }));
    const r = await c.search("SEO audit of a website");
    assert(r.searchToken === "stok_test_value_123", "searchToken on result");
    assert(c.searchTokenFor(r.searchId) === "stok_test_value_123", "in-memory map");
    assert(!JSON.stringify(r.agents).includes("stok_test_value_123"), "token leaked into agents");
  });
  await check("previousResponseId is forwarded; nothing else is added", async () => {
    const calls: Call[] = [];
    await client(() => ({ body: seo }), calls).search("SEO audit", { previousResponseId: "resp_1" });
    assert(JSON.stringify(Object.keys(calls[0].body as object).sort()) === JSON.stringify(["maxResults", "previousResponseId", "query"]), "body keys");
  });
  await check("search credentials: bearer when an access token is set, else x-api-key", async () => {
    const calls: Call[] = [];
    await client(() => ({ body: seo }), calls, { accessToken: TOKEN, apiKey: API_KEY }).search("SEO audit");
    await client(() => ({ body: seo }), calls, { apiKey: API_KEY }).search("SEO audit");
    assert(calls[0].headers.get("authorization") === `Bearer ${TOKEN}` && !calls[0].headers.has("x-api-key"), "bearer");
    assert(calls[1].headers.get("x-api-key") === API_KEY && !calls[1].headers.has("authorization"), "api key");
  });
  await check("401 with a credential falls back to an anonymous search", async () => {
    const calls: Call[] = [];
    const handler: Handler = (call) => (call.headers.has("authorization") ? { status: 401, body: { code: "TOKEN_EXPIRED" } } : { body: seo });
    const r = await client(handler, calls, { accessToken: TOKEN }).search("SEO audit");
    assert(r.agents.length === 4 && calls.length === 2 && !calls[1].headers.has("authorization"), `calls ${calls.length}`);
  });
  await check("403 with a credential falls back to an anonymous search, except on a continuation", async () => {
    const calls: Call[] = [];
    const handler: Handler = (call) => (call.headers.has("authorization") ? { status: 403, body: { code: "SCOPE_DENIED" } } : { body: seo });
    const r = await client(handler, calls, { accessToken: TOKEN }).search("SEO audit");
    assert(r.agents.length === 4 && calls.length === 2 && !calls[1].headers.has("authorization"), `calls ${calls.length}`);
    const cont: Call[] = [];
    const err = await expectThrow(() => client(handler, cont, { accessToken: TOKEN }).search("SEO audit", { previousResponseId: "resp_1" }));
    assert(err instanceof DarwinApiError && err.status === 403 && cont.length === 1, `continuation calls ${cont.length}`);
  });
  await check("anonymous 401 on Search doesn't blame DARWIN_ACCESS_TOKEN", async () => {
    const err = await expectThrow(() => client(() => ({ status: 401, body: { code: "AUTH_REQUIRED" } })).search("x"));
    assert(err instanceof DarwinApiError && err.message.includes("Search") && !err.message.includes("DARWIN_ACCESS_TOKEN"), String(err));
  });
  await check("400 SEARCH_REQUEST_INVALID is a DarwinApiError", async () => {
    const err = await expectThrow(() => client(() => ({ status: 400, body: { code: "SEARCH_REQUEST_INVALID", message: "Unrecognized key: filters" } })).search("x"));
    assert(err instanceof DarwinApiError && err.code === "SEARCH_REQUEST_INVALID" && !(err instanceof TransportError), String(err));
  });
  await check("search 503 is a TransportError", async () => {
    const err = await expectThrow(() => client(() => ({ status: 503, body: { code: "SEARCH_UNAVAILABLE" } })).search("x"));
    assert(err instanceof TransportError, String(err));
  });
}

async function testActConfig(): Promise<void> {
  console.log("\nAct configuration");
  await check("startTask without a token throws ACT_NOT_CONFIGURED (no request sent)", async () => {
    const calls: Call[] = [];
    const err = await expectThrow(() => client(() => ({ body: {} }), calls).startTask(params()));
    assert(err instanceof DarwinApiError && err.code === "ACT_NOT_CONFIGURED", String(err));
    assert(!(err instanceof TransportError), "must not be a TransportError");
    assert(err.message.includes("DARWIN_ACCESS_TOKEN"), "message names the setting");
    assert(calls.length === 0, "no request");
  });
  await check("healthCheck without credentials: unverified, not ready", async () => {
    const h = await client(() => ({})).healthCheck();
    assert(h.status === "unverified" && h.ready === false && h.detail.includes("not configured") && h.checkedAt === 1_000, JSON.stringify(h));
  });
  await check("healthCheck with a token: unverified, ready", async () => {
    const h = await client(() => ({}), [], { accessToken: TOKEN }).healthCheck();
    assert(h.status === "unverified" && h.ready === true, JSON.stringify(h));
  });
}

async function testActFlows(): Promise<void> {
  console.log("\nAct flows (simulated)");

  await check("(a) accepted -> running -> fenced JSON result => completed", async () => {
    const payload = { issues: [{ rule: "meta-description", severity: "medium" }], pagesChecked: ["http://localhost:3000/demo-site/"] };
    const text = `Here is the audit:\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`\nLet me know if you need more.`;
    const running = thread({ messages: [youMessage], actions: [{ action: "act_1", capability: AGENT.capabilityId, request: "req_1", status: "running", cancellationRequested: false }], cursor: "c2" });
    const done = thread({ messages: [resultMessage(text)], actions: [{ action: "act_1", capability: AGENT.capabilityId, request: "req_1", status: "succeeded", cancellationRequested: false }], cursor: "c3" });
    const calls: Call[] = [];
    const { handle, results } = await startAndPoll(actServer([running, done]), 2, calls);
    assert(handle.actRequestId === "actreq_1" && handle.threadId === "thr_1" && handle.taskId === "actreq_1", JSON.stringify(handle));
    assert(results[0].status === "running" && results[0].cursor === "c2", JSON.stringify(results[0]));
    const r = results[1];
    assert(r.status === "completed", JSON.stringify(r));
    assert(JSON.stringify(r.output) === JSON.stringify(payload), `output ${JSON.stringify(r.output)}`);
    assert(r.cursor === "c3", "cursor");
    const raw = JSON.stringify(r.raw);
    assert(raw.includes("msg_you_1") && raw.includes("msg_res_1"), "raw accumulates messages across polls");
    assert(!raw.includes(TOKEN), "raw contains the token");
    const polls = calls.filter((c) => c.method === "GET");
    assert(polls[0].url.searchParams.get("includeThreadState") === "true" && polls[0].url.searchParams.get("threadId") === "thr_1", "poll params");
    assert(polls[0].url.searchParams.get("cursor") === "c1", "first poll continues from the start receipt cursor");
    assert(polls[1].url.searchParams.get("cursor") === "c2", "second poll uses the returned cursor");
    assert(polls.every((c) => c.headers.get("authorization") === `Bearer ${TOKEN}`), "poll auth");
  });

  await check("(a2) result data wins over text; plain text without JSON returns the text", async () => {
    const withData = thread({ messages: [resultMessage("done", { pages: [{ url: "http://x/", title: "X", status: 200 }] })] });
    const { results: r1 } = await startAndPoll(actServer([withData]), 1);
    assert(r1[0].status === "completed" && JSON.stringify(r1[0].output) === JSON.stringify({ pages: [{ url: "http://x/", title: "X", status: 200 }] }), "data");
    const plain = thread({ messages: [resultMessage("No issues found.")] });
    const { results: r2 } = await startAndPoll(actServer([plain]), 1);
    assert(r2[0].status === "completed" && r2[0].output === "No issues found.", "plain text");
  });

  await check("(b) pending authentication_request => blocked authentication", async () => {
    const t = thread({ requests: [{ request: "req_auth", action: "act_1", status: "pending", type: "authentication_request", targetAgent: AGENT.agentId, authenticationType: "oauth", resource: "https://provider.example/api", scopes: ["read"] }] });
    const { results } = await startAndPoll(actServer([t]), 1);
    const r = results[0];
    assert(r.status === "blocked" && r.kind === "authentication" && r.message.includes("oauth") && r.message.includes("read"), JSON.stringify(r));
  });

  await check("(b2) pending authentication_required => blocked authentication; resolved => not blocked", async () => {
    const pending = thread({ requests: [{ request: "req_auth2", action: "act_1", status: "pending", type: "authentication_required", targetAgent: AGENT.agentId, scopes: [] }] });
    const resolved = thread({ requests: [{ request: "req_auth2", action: "act_1", status: "resolved", type: "authentication_required", targetAgent: AGENT.agentId, scopes: [] }], cursor: "c2" });
    const { results } = await startAndPoll(actServer([pending, resolved]), 2);
    assert(results[0].status === "blocked" && results[0].kind === "authentication", JSON.stringify(results[0]));
    assert(results[1].status === "running", `resolved request should not block: ${JSON.stringify(results[1])}`);
  });

  await check("requests are current state: a request dropped from a later read stops blocking", async () => {
    const authReq = { request: "req_auth3", action: "act_1", status: "pending", type: "authentication_required", targetAgent: AGENT.agentId, scopes: [] };
    const pending = thread({ requests: [authReq] });
    const dropped = thread({ requests: [], cursor: "c2" });
    const { results } = await startAndPoll(actServer([pending, dropped]), 2);
    assert(results[0].status === "blocked", JSON.stringify(results[0]));
    assert(results[1].status === "running", `dropped request still blocks: ${JSON.stringify(results[1])}`);
  });

  await check("within one poll, a pending request from an earlier page still blocks", async () => {
    let n = 0;
    const authReq = { request: "req_auth4", action: "act_1", status: "pending", type: "authentication_request", targetAgent: AGENT.agentId, authenticationType: "oauth", resource: "https://provider.example/api", scopes: [] };
    const handler: Handler = (call) => {
      if (call.method === "POST") return { body: receipt(thread({ messages: [youMessage] })) };
      n++;
      return n === 1 ? { body: receipt(thread({ requests: [authReq], cursor: "p2", hasMore: true })) } : { body: receipt(thread({ requests: [], cursor: "p3" })) };
    };
    const { results } = await startAndPoll(handler, 1);
    assert(n === 2 && results[0].status === "blocked" && results[0].kind === "authentication", JSON.stringify(results[0]));
  });

  await check("result data given as a JSON string is parsed", async () => {
    const t = thread({ messages: [resultMessage("", "Report:\n{\"issues\": [], \"pagesChecked\": [\"http://x/\"]}")] });
    const { results } = await startAndPoll(actServer([t]), 1);
    assert(results[0].status === "completed" && JSON.stringify(results[0].output) === "{\"issues\":[],\"pagesChecked\":[\"http://x/\"]}", JSON.stringify(results[0]));
  });

  await check("empty arguments are omitted; an empty instruction is rejected without a request", async () => {
    const calls: Call[] = [];
    const c = client(actServer([thread()]), calls, { accessToken: TOKEN });
    await c.startTask(params("idem-empty-args", { arguments: {} }));
    assert(!("arguments" in (calls[0].body as { targets: object[] }).targets[0]), "empty arguments sent");
    const err = await expectThrow(() => c.startTask(params("idem-empty-msg", { instruction: "  " })));
    assert(err instanceof DarwinApiError && err.code === "INSTRUCTION_EMPTY" && calls.length === 1, String(err));
  });

  await check("(c) pending payment_request => blocked payment", async () => {
    const t = thread({ requests: [{ request: "req_pay", action: "act_1", status: "pending", type: "payment_request", amountMinor: "300", currency: "USD", payee: { agent: AGENT.agentId, name: "Example Provider" }, acceptedMethods: ["x402"], expiresAt: LATER }] });
    const { results } = await startAndPoll(actServer([t]), 1);
    const r = results[0];
    assert(r.status === "blocked" && r.kind === "payment" && r.message.includes("300") && r.message.includes("Example Provider"), JSON.stringify(r));
  });

  await check("pending approval_request => blocked approval", async () => {
    const t = thread({ requests: [{ request: "req_ok", action: "act_1", status: "pending", type: "approval_request", reason: "Agent wants to fetch 25 pages", expiresAt: LATER, capability: AGENT.capabilityId, arguments: {} }] });
    const { results } = await startAndPoll(actServer([t]), 1);
    assert(results[0].status === "blocked" && results[0].kind === "approval" && results[0].message.includes("25 pages"), JSON.stringify(results[0]));
  });

  await check("non-retryable thread error => error; retryable error stays running", async () => {
    const retryable = thread({ errors: [{ event: "evt_1", code: "PROVIDER_TIMEOUT", retryable: true, createdAt: AT }] });
    const fatal = thread({ errors: [{ event: "evt_2", code: "PROVIDER_ROUTE_UNAVAILABLE", retryable: false, action: "act_1", createdAt: LATER }], cursor: "c2" });
    const { results } = await startAndPoll(actServer([retryable, fatal]), 2);
    assert(results[0].status === "running", JSON.stringify(results[0]));
    const r = results[1];
    assert(r.status === "error" && r.code === "PROVIDER_ROUTE_UNAVAILABLE" && r.message.includes("evt_2") && !r.retryable, JSON.stringify(r));
  });

  await check("failed action => error ACTION_FAILED", async () => {
    const t = thread({ actions: [{ action: "act_9", capability: AGENT.capabilityId, request: "req_9", status: "failed", cancellationRequested: false }] });
    const { results } = await startAndPoll(actServer([t]), 1);
    assert(results[0].status === "error" && results[0].code === "ACTION_FAILED", JSON.stringify(results[0]));
  });

  await check("thread errorCode on start => DarwinApiError with that code", async () => {
    const start = { body: receipt({ agentId: AGENT.agentId, capabilityId: AGENT.capabilityId, errorCode: "ROUTE_NOT_READY" }, "failed") };
    const err = await expectThrow(() => client(actServer([], start), [], { accessToken: TOKEN }).startTask(params()));
    assert(err instanceof DarwinApiError && err.code === "ROUTE_NOT_READY" && !(err instanceof TransportError), String(err));
  });

  await check("hasMore pages are drained within one poll", async () => {
    let n = 0;
    const handler: Handler = (call) => {
      if (call.method === "POST") return { body: receipt(thread({ messages: [youMessage] })) };
      n++;
      return n === 1
        ? { body: receipt(thread({ messages: [{ ...youMessage, message: "msg_2", from: "agent", type: "message", content: [{ type: "text", text: "Working on it" }] }], cursor: "p2", hasMore: true })) }
        : { body: receipt(thread({ messages: [resultMessage("[1, 2, 3]")], cursor: "p3" })) };
    };
    const { results } = await startAndPoll(handler, 1);
    assert(results[0].status === "completed" && JSON.stringify(results[0].output) === "[1,2,3]" && results[0].cursor === "p3", JSON.stringify(results[0]));
    assert(n === 2, `expected 2 reads, got ${n}`);
  });

  await check("(d) 403 ACT_PREVIEW_ACCESS_REQUIRED => clear, non-transport error", async () => {
    const start = { status: 403, body: { code: "ACT_PREVIEW_ACCESS_REQUIRED", message: "Act pilot access required" } };
    const err = await expectThrow(() => client(actServer([], start), [], { accessToken: TOKEN }).startTask(params()));
    assert(err instanceof DarwinApiError && err.code === "ACT_PREVIEW_ACCESS_REQUIRED" && err.status === 403, String(err));
    assert(!(err instanceof TransportError), "must not be a TransportError");
    assert(err.message.includes("allowlist") && err.message.includes("Search still works"), err.message);
  });

  await check("(e) 503 => TransportError; same key on retry", async () => {
    const calls: Call[] = [];
    let attempt = 0;
    const handler: Handler = () => (++attempt === 1 ? { status: 503, body: { code: "ACT_UNAVAILABLE" } } : { body: receipt(thread()) });
    const c = client(handler, calls, { accessToken: TOKEN });
    const err = await expectThrow(() => c.startTask(params("idem-retry")));
    assert(err instanceof TransportError, String(err));
    const handle = await c.startTask(params("idem-retry"));
    assert(handle.threadId === "thr_1", "retry succeeded");
    assert(calls.every((x) => x.headers.get("idempotency-key") === "idem-retry"), "same key");
  });

  await check("429 => TransportError mentioning Retry-After", async () => {
    const err = await expectThrow(() => client(() => ({ status: 429, body: { code: "RATE_LIMITED" }, headers: { "retry-after": "7" } }), [], { accessToken: TOKEN }).startTask(params()));
    assert(err instanceof TransportError && err.message.includes("Retry-After 7s"), String(err));
  });

  await check("network failure and timeout => TransportError", async () => {
    const down = new RealDarwinClient({ apiBase: API, accessToken: TOKEN, fetchImpl: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch });
    const e1 = await expectThrow(() => down.startTask(params()));
    assert(e1 instanceof TransportError, String(e1));
    const hang = new RealDarwinClient({
      apiBase: API,
      accessToken: TOKEN,
      timeoutMs: 30,
      fetchImpl: ((_: RequestInfo | URL, init?: RequestInit) =>
        new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as typeof fetch,
    });
    const e2 = await expectThrow(() => hang.search("SEO audit"));
    assert(e2 instanceof TransportError && e2.message.includes("did not respond"), String(e2));
  });

  await check("(f) headers and body: Idempotency-Key, Bearer, only spec'd fields", async () => {
    const calls: Call[] = [];
    const c = client(actServer([thread()]), calls, { accessToken: TOKEN });
    await c.startTask(params("idem-xyz-42", { arguments: { domain: "localhost" } }));
    const post = calls[0];
    assert(post.method === "POST" && post.url.href === `${API}/v3/act`, post.url.href);
    assert(post.headers.get("idempotency-key") === "idem-xyz-42", "Idempotency-Key");
    assert(post.headers.get("authorization") === `Bearer ${TOKEN}`, "Authorization");
    assert(!post.headers.has("x-search-token"), "no search token on a targets start");
    const body = post.body as { targets: Record<string, unknown>[]; message: string };
    assert(JSON.stringify(Object.keys(body).sort()) === JSON.stringify(["message", "targets"]), `body keys ${Object.keys(body)}`);
    assert(body.targets.length === 1, "one target");
    assert(Object.keys(body.targets[0]).every((k) => ["agentId", "capabilityId", "arguments"].includes(k)), `target keys ${Object.keys(body.targets[0])}`);
    assert(body.targets[0].agentId === AGENT.agentId && body.targets[0].capabilityId === AGENT.capabilityId, "target ids");
    assert(typeof body.message === "string" && body.message === params().instruction, "message is the instruction");
    const textOnly: Call[] = [];
    await client(actServer([thread()]), textOnly, { accessToken: TOKEN }).startTask(params());
    assert(!("arguments" in (textOnly[0].body as { targets: object[] }).targets[0]), "arguments omitted when not given");
  });

  await check("errors never echo credentials", async () => {
    const err = await expectThrow(() =>
      client(() => ({ status: 400, body: { code: "BAD", message: `header was Bearer ${TOKEN} and api_key=${API_KEY}` } }), [], { accessToken: TOKEN, apiKey: API_KEY }).startTask(params()),
    );
    const msg = String((err as Error).message);
    assert(!msg.includes(TOKEN) && !msg.includes(API_KEY), msg);
  });

  await check("cancelTask sends cancellation_request for a pending action; errors swallowed", async () => {
    const calls: Call[] = [];
    let posts = 0;
    const running = thread({ actions: [{ action: "act_77", capability: AGENT.capabilityId, request: "req_77", status: "running", cancellationRequested: false }] });
    const handler: Handler = (call) => {
      if (call.method === "GET") return { body: receipt(running) };
      posts++;
      return posts === 1 ? { body: receipt(thread()) } : { status: 500, body: { code: "BOOM" } };
    };
    const c = client(handler, calls, { accessToken: TOKEN });
    const handle = await c.startTask(params());
    await c.pollTask(handle);
    await c.cancelTask(handle);
    const cancel = calls[calls.length - 1];
    assert(cancel.method === "POST", "cancel posted");
    assert(JSON.stringify(cancel.body) === JSON.stringify({ threadId: "thr_1", message: { type: "cancellation_request", operationId: "act_77" } }), JSON.stringify(cancel.body));
    await c.cancelTask(handle);
  });

  await check("poll 403 becomes an error poll, not a throw", async () => {
    const handler: Handler = (call) => (call.method === "POST" ? { body: receipt(thread()) } : { status: 403, body: { code: "THREAD_ACCESS_DENIED" } });
    const { results } = await startAndPoll(handler, 1);
    assert(results[0].status === "error" && results[0].code === "THREAD_ACCESS_DENIED", JSON.stringify(results[0]));
  });
}

async function testExtractJson(): Promise<void> {
  console.log("\nJSON extraction");
  await check("fenced, bare, embedded, and absent", () => {
    assert(JSON.stringify(extractJson("```json\n{\"a\":1}\n```")) === "{\"a\":1}", "fenced");
    assert(JSON.stringify(extractJson("```\n[1,2]\n```")) === "[1,2]", "unlabelled fence");
    assert(JSON.stringify(extractJson("{\"a\":{\"b\":\"}\"}}")) === "{\"a\":{\"b\":\"}\"}}", "bare with brace in string");
    assert(JSON.stringify(extractJson("Result: {\"ok\":true} thanks")) === "{\"ok\":true}", "embedded");
    assert(JSON.stringify(extractJson("see {not json} then {\"x\":2}")) === "{\"x\":2}", "skips invalid candidates");
    assert(extractJson("no json here") === undefined, "absent");
  });
  await check("bracket references and markdown links don't hide the payload", () => {
    const payload = "{\"issues\":[],\"pagesChecked\":[\"http://x/\"]}";
    assert(JSON.stringify(extractJson(`Found 2 issues [1]. Report: ${payload}`)) === payload, "[1] before payload");
    assert(JSON.stringify(extractJson(`Checked [] pages; ${payload} done`)) === payload, "[] before payload");
    const links = Array.from({ length: 30 }, (_, i) => `- [Page ${i}](http://x/${i})`).join("\n");
    assert(JSON.stringify(extractJson(`${links}\n\n${payload}`)) === payload, "30 markdown links before payload");
  });
}

async function main(): Promise<void> {
  await testSearchFixtures();
  await testSearchDetails();
  await testActConfig();
  await testActFlows();
  await testExtractJson();
  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
