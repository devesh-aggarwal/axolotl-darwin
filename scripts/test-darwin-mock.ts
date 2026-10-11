// Tests the mock Darwin catalog and MockDarwinClient against the local demo site. Exits non-zero on any failure.
// Usage: npx tsx --tsconfig tsconfig.json scripts/test-darwin-mock.ts
import http from "node:http";
import type { AddressInfo } from "node:net";
import { getTemplate, WORKFLOW } from "@/config/workflow";
import { AuditOutputSchema, CrawlOutputSchema } from "@/lib/contracts";
import {
  expectedIssues,
  expectedPages,
  measureRecall,
  normalizeUrl,
  runCapability,
  siteRootUrl,
  spotCheckIssues,
  unmatchedIssues,
} from "@/lib/audit";
import {
  corruptionContextFor,
  corruptOutput,
  inferCapability,
  MockDarwinClient,
  planMockAttempt,
  type MockAttemptPlan,
} from "@/lib/darwin/mock";
import { defaultMockPool, getMockAgent, MOCK_AGENTS, mockAgentsFor, type MockAgentProfile } from "@/lib/darwin/mockCatalog";
import { TransportError, type TaskContext, type TaskHandle, type TaskPoll } from "@/lib/darwin/types";
import { rngFor } from "@/lib/rng";
import {
  CAPABILITIES,
  type AgentNodeInput,
  type AgentRef,
  type AuditCategory,
  type AuditOutput,
  type Capability,
  type CorruptionKind,
  type CrawlOutput,
  type FaultMode,
  type VerificationResult,
} from "@/lib/types";
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

/** Mock latencies at 1% so every attempt settles in tens of milliseconds. */
const FAST = 0.01;
const SEED = 4242;
/** Seeded plans per agent for the failure-rate comparison. */
const STAT_ATTEMPTS = 1000;
/** Simulated runs per capability for the leaderboard check. */
const LEADERBOARD_RUNS = 200;
const KINDS: CorruptionKind[] = ["hallucinated_pages", "empty", "refusal", "schema", "fabricated"];
const ERROR_CODES = ["AGENT_RUNTIME_ERROR", "UPSTREAM_5XX", "TOOL_CRASHED"];
const BANNED_NAMES =
  /\b(google|lighthouse|ahrefs|semrush|moz|axe|deque|cloudflare|screaming frog|pa11y|wave|sitebulb|siteimprove|gtmetrix|pingdom|webpagetest|qualys|observatory|mozilla|microsoft|amazon|openai|vercel|inclusa)\b/i;
const EMOJI = /\p{Extended_Pictographic}/u;
const REFUSAL_TEXT = /\b(?:i['’]?m sorry|as an ai|sorry, i cannot|can['’]?t (?:access|check))/i;

// ---------- network guard: only the local demo server (and .invalid hosts, which never resolve) ----------

const blockedRequests: string[] = [];

function installNetworkGuard(): void {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const host = new URL(raw).hostname;
    if (host === "127.0.0.1" || host === "localhost" || host.endsWith(".invalid")) return realFetch(input, init);
    blockedRequests.push(host);
    throw new Error(`network guard: request to ${host} blocked`);
  }) as typeof fetch;
}

// ---------- helpers ----------

function refOf(agent: MockAgentProfile): AgentRef {
  return { agentId: agent.agentId, capabilityId: agent.capabilityId, name: agent.name, source: "mock", provider: agent.provider };
}

function inputFor(capability: Capability, siteUrl: string): AgentNodeInput {
  if (capability === "crawl") return { siteUrl, maxPages: 5 };
  if (capability === "accessibility" || capability === "performance") return { siteUrl, pageUrl: siteUrl };
  return { siteUrl, pages: expectedPages(siteUrl) };
}

function contextFor(capability: Capability, siteUrl: string, attemptNo: number, extra: Partial<TaskContext> = {}): TaskContext {
  return {
    runId: "run_mock_test",
    nodeInstanceId: `${capability}#0`,
    capability,
    input: inputFor(capability, siteUrl),
    seed: SEED,
    attemptNo,
    timeScale: FAST,
    knownPages: capability === "crawl" ? [] : expectedPages(siteUrl),
    ...extra,
  };
}

/** First attempt number whose plan satisfies `want`. */
function findAttempt(agent: MockAgentProfile, base: (attemptNo: number) => TaskContext, want: (plan: MockAttemptPlan) => boolean, max = 2000): number {
  for (let n = 1; n <= max; n++) if (want(planMockAttempt(agent, base(n)))) return n;
  throw new Error(`no attempt in 1..${max} matched for ${agent.agentId}`);
}

let keyCounter = 0;

/** Starts a task the way the engine does: one retry with the same key after a transport glitch. */
async function start(client: MockDarwinClient, agent: MockAgentProfile, context: TaskContext, key = `key-${++keyCounter}`): Promise<TaskHandle> {
  const params = { agent: refOf(agent), instruction: "test", idempotencyKey: key, context };
  try {
    return await client.startTask(params);
  } catch (err) {
    if (!(err instanceof TransportError)) throw err;
    return client.startTask(params);
  }
}

async function pollUntilDone(client: MockDarwinClient, handle: TaskHandle, deadlineMs = 5000): Promise<{ last: TaskPoll; polls: TaskPoll[] }> {
  const polls: TaskPoll[] = [];
  const until = Date.now() + deadlineMs;
  for (;;) {
    const poll = await client.pollTask(handle);
    polls.push(poll);
    if (poll.status !== "running" || Date.now() > until) return { last: poll, polls };
    await sleep(5);
  }
}

async function run(client: MockDarwinClient, agent: MockAgentProfile, context: TaskContext): Promise<TaskPoll> {
  return (await pollUntilDone(client, await start(client, agent, context))).last;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function short(url: string, siteUrl: string): string {
  return url.startsWith(siteUrl) ? `/${url.slice(siteUrl.length)}` : url;
}

function printTable(headers: string[], rows: string[][]): void {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) => cells.map((c, i) => (c ?? "").padEnd(widths[i])).join("  ");
  console.log(line(headers));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const r of rows) console.log(line(r));
  console.log("");
}

// ---------- catalog ----------

function testCatalog(): void {
  expect("catalog has 30 agents", MOCK_AGENTS.length === 30, `got ${MOCK_AGENTS.length}`);
  expect("agent ids are unique", new Set(MOCK_AGENTS.map((a) => a.agentId)).size === 30);
  expect("capability ids are unique", new Set(MOCK_AGENTS.map((a) => a.capabilityId)).size === 30);
  expect("names are unique", new Set(MOCK_AGENTS.map((a) => a.name)).size === 30);
  const badIds = MOCK_AGENTS.filter((a) => {
    const slug = a.agentId.split(":")[2] ?? "";
    return a.agentId !== `mock:${a.capability}:${slug}` || a.capabilityId !== `mock-cap:${a.capability}:${slug}` || !/^[a-z0-9-]+$/.test(slug);
  });
  expect("ids follow mock:<capability>:<slug> / mock-cap:<capability>:<slug>", badIds.length === 0, badIds.map((a) => a.agentId).join(", "));
  const text = MOCK_AGENTS.map((a) => `${a.name} ${a.provider} ${a.description}`).join("\n");
  expect("no real company or product names", !BANNED_NAMES.test(text), BANNED_NAMES.exec(text)?.[0] ?? "");
  expect("no emoji in the catalog", !EMOJI.test(JSON.stringify(MOCK_AGENTS)));
  const outOfRange = MOCK_AGENTS.filter(
    (a) =>
      a.meanLatencyMs < 1500 ||
      a.meanLatencyMs > 5500 ||
      a.recall < 0.6 ||
      a.recall > 1 ||
      a.severityNoise < 0 ||
      a.severityNoise > 0.3 ||
      a.transportGlitchRate < 0 ||
      a.transportGlitchRate > 0.08 ||
      a.baseFailureRate < 0 ||
      a.baseFailureRate > 1,
  );
  expect("behavior parameters within spec ranges", outOfRange.length === 0, outOfRange.map((a) => a.agentId).join(", "));
  expect("getMockAgent finds catalog agents and rejects unknown ids", getMockAgent(MOCK_AGENTS[7].agentId) === MOCK_AGENTS[7] && getMockAgent("mock:seo:nope") === undefined);

  for (const capability of CAPABILITIES) {
    const agents = mockAgentsFor(capability);
    const [primary, b1, b2, mediocre, down] = agents;
    const ranks = agents.map((a) => a.darwinRank).sort((x, y) => x - y).join(",");
    const pool = defaultMockPool(capability);
    const problems = [
      agents.length !== 5 && `${agents.length} agents`,
      ranks !== "1,2,3,4,5" && `ranks ${ranks}`,
      primary.darwinRank !== 1 && "primary is not rank 1",
      // Relative, not absolute: the time-lapse calibration tunes the rates.
      !(primary.baseFailureRate > 0 && primary.baseFailureRate < 0.5) && `primary failure ${primary.baseFailureRate}`,
      [b1, b2].some((b) => primary.baseFailureRate < 2 * b.baseFailureRate) && "primary is not at least twice as flaky as each backup",
      primary.failureWeights.bad_output <= 0 && "primary never returns bad output",
      [b1, b2].some((b) => b.baseFailureRate <= 0 || b.baseFailureRate > 0.12 || b.recall < 0.9) && "backups not steady",
      b1.meanLatencyMs === b2.meanLatencyMs && "backups share a latency",
      !(mediocre.recall <= 0.75 && mediocre.baseFailureRate > Math.max(b1.baseFailureRate, b2.baseFailureRate)) && "mediocre profile off",
      agents.filter((a) => !a.healthy).length !== 1 && "not exactly one unhealthy agent",
      down.healthy && "agent [4] should be down",
      pool.primary !== primary && "pool primary is not agent [0]",
      (pool.backups.length !== 2 || pool.backups[0] !== b1 || pool.backups[1] !== b2) && "pool backups are not agents [1], [2]",
      ![pool.primary, ...pool.backups].every((a) => a.healthy) && "pool contains an unhealthy agent",
    ].filter(Boolean);
    expect(`${capability}: 5 agents, profiles and default pool`, problems.length === 0, problems.join("; "));
  }
}

// ---------- search & health ----------

async function testSearch(client: MockDarwinClient): Promise<void> {
  const templates = WORKFLOW.filter((t) => t.kind === "agent");
  const started = Date.now();
  const results = await Promise.all(templates.map((t) => client.search(t.query ?? "")));
  const elapsed = Date.now() - started;
  templates.forEach((t, i) => {
    const r = results[i];
    const ranks = r.agents.map((a) => a.rank);
    const problems = [
      r.agents.length !== 5 && `${r.agents.length} agents`,
      r.agents.some((a) => a.capability !== t.capability) && "wrong capability",
      ranks.join(",") !== "1,2,3,4,5" && `ranks ${ranks.join(",")}`,
      !r.searchId.startsWith("msrch_") && `searchId ${r.searchId}`,
      r.agents.some((a) => a.searchId !== r.searchId || a.source !== "mock" || a.requiredSetup !== null) && "candidate fields",
      r.agents.some((a) => {
        const p = getMockAgent(a.agentId);
        return !p || a.readiness !== (p.healthy ? "ready" : "unavailable") || a.canStartThread !== p.healthy || a.providerCheck !== (p.healthy ? "passed" : "failed");
      }) && "readiness does not follow health",
      r.agents.some((a) => !a.connectionPrompt || a.reasons.length === 0) && "missing prompt or reasons",
    ].filter(Boolean);
    expect(`search "${t.query}" infers ${t.capability}`, problems.length === 0, problems.join("; "));
  });
  expect("search latency is simulated (100-300 ms, not scaled)", elapsed >= 95 && elapsed < 1000, `${elapsed} ms for ${templates.length} parallel searches`);
  const limited = await client.search("anything", { capability: "links", maxResults: 3 });
  expect("search honors capability override and maxResults", limited.agents.length === 3 && limited.agents.every((a) => a.capability === "links"));
  const fractional = await client.search("seo audit", { maxResults: 0.5 });
  expect("a fractional maxResults still returns the top agent", fractional.agents.length === 1 && fractional.agents[0].rank === 1, `${fractional.agents.length} agents`);
  const none = await client.search("bake a sourdough loaf");
  expect("unmatched query returns no agents with a note", none.agents.length === 0 && Boolean(none.note));
  expect("inferCapability picks links over crawl for '404 links'", inferCapability("check 404 links on my site") === "links");
}

async function testHealth(client: MockDarwinClient): Promise<void> {
  const capability: Capability = "seo";
  const [primary, , , , down] = mockAgentsFor(capability);
  const started = Date.now();
  const [ok, bad, unknown] = await Promise.all([
    client.healthCheck(refOf(primary)),
    client.healthCheck(refOf(down)),
    client.healthCheck({ agentId: "mock:seo:ghost", capabilityId: "x", name: "Ghost", source: "mock" }),
  ]);
  const elapsed = Date.now() - started;
  expect("healthy agent is ready", ok.ready && ok.status === "ready" && /^Probe thread answered in \d+ ms$/.test(ok.detail), ok.detail);
  expect(
    "unhealthy agent is not ready",
    !bad.ready && bad.status === "not_ready" && bad.detail === "Provider route unavailable (probe returned 503)",
    bad.detail,
  );
  expect("unknown agent is not ready", !unknown.ready && unknown.status === "not_ready", unknown.detail);
  expect("health probe takes about 120 ms", elapsed >= 110 && elapsed < 600, `${elapsed} ms`);
  const everyUnhealthy = await Promise.all(MOCK_AGENTS.filter((a) => !a.healthy).map((a) => client.healthCheck(refOf(a))));
  expect("all six unhealthy agents fail the health check", everyUnhealthy.length === 6 && everyUnhealthy.every((h) => !h.ready));
}

// ---------- planning, determinism, idempotency ----------

function testPlanning(siteUrl: string): void {
  const agent = mockAgentsFor("accessibility")[0];
  const base = (n: number, extra: Partial<TaskContext> = {}) => contextFor("accessibility", siteUrl, n, extra);
  const same = Array.from({ length: 50 }, (_, i) => JSON.stringify(planMockAttempt(agent, base(i + 1))) === JSON.stringify(planMockAttempt(agent, base(i + 1))));
  expect("same seed and ids give the same plan", same.every(Boolean));
  const outcomes = new Set(Array.from({ length: 200 }, (_, i) => planMockAttempt(agent, base(i + 1)).outcome));
  expect("different attempts give different outcomes", outcomes.size >= 4, [...outcomes].join(", "));
  const otherSeed = Array.from({ length: 30 }, (_, i) => planMockAttempt(agent, base(i + 1, { seed: SEED + 1 })).latencyMs !== planMockAttempt(agent, base(i + 1)).latencyMs);
  expect("a different seed changes the plan", otherSeed.filter(Boolean).length >= 25);

  const faults: [FaultMode, MockAttemptPlan["outcome"]][] = [
    ["error", "error"],
    ["timeout", "timeout"],
    ["stall", "stall"],
    ["auth_block", "auth_block"],
    ["corrupt", "bad_output"],
  ];
  const forcedOk = faults.every(([fault, outcome]) =>
    Array.from({ length: 20 }, (_, i) => {
      const forced = planMockAttempt(agent, base(i + 1, { forcedFault: fault }));
      const free = planMockAttempt(agent, base(i + 1));
      return forced.outcome === outcome && forced.forced && forced.latencyMs === free.latencyMs;
    }).every(Boolean),
  );
  expect("forcedFault overrides sampling without shifting other draws", forcedOk);
  const forcedBlocks = Array.from({ length: 40 }, (_, i) => planMockAttempt(agent, base(i + 1, { forcedFault: "auth_block" })));
  expect("forced auth_block is always an authentication block", forcedBlocks.every((p) => p.outcome === "auth_block" && p.block.kind === "authentication"));

  const slow = planMockAttempt(agent, base(3, { timeScale: 1 }));
  const fast = planMockAttempt(agent, base(3));
  expect("latency scales with timeScale", Math.abs(slow.latencyMs * FAST - fast.latencyMs) < 1e-6, `${slow.latencyMs.toFixed(0)} ms vs ${fast.latencyMs.toFixed(2)} ms`);
  const maxLatency = Math.max(...MOCK_AGENTS.flatMap((a) => Array.from({ length: 100 }, (_, i) => planMockAttempt(a, { ...base(i + 1, { timeScale: 1 }), capability: a.capability }).latencyMs)));
  expect("unscaled latency stays under the engine's attempt timeout", maxLatency <= 14_000 * 0.8, `max ${maxLatency.toFixed(0)} ms`);
  const down = mockAgentsFor("accessibility")[4];
  const downPlans = Array.from({ length: 30 }, (_, i) => planMockAttempt(down, base(i + 1, { forcedFault: i % 2 ? "corrupt" : undefined })));
  expect("an unhealthy agent always fails with a provider error", downPlans.every((p) => p.outcome === "error" && p.error.code === "UPSTREAM_5XX"));
}

async function testIdempotency(siteUrl: string): Promise<void> {
  const client = new MockDarwinClient();
  const agent = mockAgentsFor("seo")[1];
  const ctx = contextFor("seo", siteUrl, 1, { forcedFault: "timeout" });
  const h1 = await start(client, agent, ctx, "same-key");
  const h2 = await start(client, agent, { ...ctx, attemptNo: 99, forcedFault: undefined }, "same-key");
  expect("same idempotency key returns the same handle", h1 === h2 && h1.taskId === h2.taskId);
  const p = await client.pollTask(h2);
  expect("a repeated key does not re-roll the task", p.status === "running", p.status);
  const h3 = await start(client, agent, ctx, "other-key");
  expect("a different key starts a different task", h3.taskId !== h1.taskId && h3.threadId !== h1.threadId);
  await client.cancelTask(h1);
  await client.cancelTask(h3);

  const primary = mockAgentsFor("crawl")[0];
  let glitchKey: string | null = null;
  let glitchMessage = "";
  for (let n = 1; n <= 400 && !glitchKey; n++) {
    const key = `glitch-${n}`;
    try {
      const context = contextFor("crawl", siteUrl, n, { forcedFault: "error" });
      const h = await client.startTask({ agent: refOf(primary), instruction: "test", idempotencyKey: key, context });
      await client.cancelTask(h);
    } catch (err) {
      if (!(err instanceof TransportError)) throw err;
      glitchKey = key;
      glitchMessage = err.message;
    }
  }
  expect("transport glitches happen at the agent's rate", glitchKey !== null, glitchKey ?? "no glitch in 400 attempts");
  if (glitchKey) {
    const n = Number(glitchKey.split("-")[1]);
    const retry = await start(client, primary, contextFor("crawl", siteUrl, n, { forcedFault: "error" }), glitchKey);
    const again = await start(client, primary, contextFor("crawl", siteUrl, n, { forcedFault: "error" }), glitchKey);
    expect("glitch message", glitchMessage === "mock transport glitch: connection reset", glitchMessage);
    expect("retry with the same key succeeds and returns the same handle", retry === again && retry.taskId.startsWith("mtask_"));
    const done = await pollUntilDone(client, retry);
    expect("the task survives the glitch and runs to its planned end", done.last.status === "error");
  }
  let unknownError: unknown = null;
  try {
    await client.startTask({
      agent: { agentId: "mock:seo:ghost", capabilityId: "x", name: "Ghost", source: "mock" },
      instruction: "x",
      idempotencyKey: "ghost",
      context: contextFor("seo", siteUrl, 1),
    });
  } catch (err) {
    unknownError = err;
  }
  expect("unknown agent fails startTask with a plain error", unknownError instanceof Error && !(unknownError instanceof TransportError));
  const missing = await client.pollTask({ taskId: "mtask_missing", threadId: "x", startedAt: Date.now() });
  expect("polling an unknown task returns an error poll", missing.status === "error" && missing.code === "TASK_NOT_FOUND");
}

// ---------- fault behavior ----------

async function testFaults(siteUrl: string): Promise<void> {
  const client = new MockDarwinClient();
  const agent = mockAgentsFor("accessibility")[2];
  const ctx = (fault: FaultMode | undefined, n = 1) => contextFor("accessibility", siteUrl, n, fault ? { forcedFault: fault } : {});

  const err = await run(client, agent, ctx("error"));
  expect(
    "forced error ⇒ error poll with a known code",
    err.status === "error" && ERROR_CODES.includes(err.code) && !err.retryable && err.message.length > 10,
    err.status === "error" ? `${err.code}: ${err.message}` : err.status,
  );

  const blockHandle = await start(client, agent, ctx("auth_block"));
  const block = await pollUntilDone(client, blockHandle);
  const plan = planMockAttempt(agent, ctx("auth_block"));
  const blockedAt = block.last.status === "blocked" ? Date.now() - blockHandle.startedAt : -1;
  expect(
    "forced auth_block ⇒ blocked authentication",
    block.last.status === "blocked" && block.last.kind === "authentication" && /requested/.test(block.last.message),
    block.last.status === "blocked" ? block.last.message : block.last.status,
  );
  expect("the block arrives before the planned latency", blockedAt >= 0 && blockedAt < plan.latencyMs + 50, `${blockedAt} ms vs latency ${plan.latencyMs.toFixed(1)} ms`);

  const primary = mockAgentsFor("seo")[0];
  const payN = findAttempt(primary, (n) => contextFor("seo", siteUrl, n), (p) => p.outcome === "auth_block" && p.block.kind === "payment");
  const pay = await run(client, primary, contextFor("seo", siteUrl, payN));
  expect("sampled auth blocks are sometimes payment requests", pay.status === "blocked" && pay.kind === "payment" && pay.message.includes("$4.00"));

  const timeoutPlan = planMockAttempt(agent, ctx("timeout"));
  const timeoutHandle = await start(client, agent, ctx("timeout"));
  const timeoutPolls: TaskPoll[] = [];
  const watchUntil = Date.now() + timeoutPlan.latencyMs * 3 + 150;
  while (Date.now() < watchUntil) {
    timeoutPolls.push(await client.pollTask(timeoutHandle));
    await sleep(8);
  }
  const timeoutCursors = new Set(timeoutPolls.map((p) => p.cursor));
  expect(
    "forced timeout ⇒ running forever with an advancing cursor",
    timeoutPolls.every((p) => p.status === "running") && timeoutCursors.size >= 5,
    `${timeoutPolls.length} polls, ${timeoutCursors.size} cursors`,
  );
  await client.cancelTask(timeoutHandle);
  const cancelled = await client.pollTask(timeoutHandle);
  expect("cancelled task ⇒ error CANCELLED", cancelled.status === "error" && cancelled.code === "CANCELLED");

  const stallPlan = planMockAttempt(agent, ctx("stall", 2));
  const stallHandle = await start(client, agent, ctx("stall", 2));
  const early = await client.pollTask(stallHandle);
  await sleep(stallPlan.eventMs + 60);
  const frozen: TaskPoll[] = [];
  for (let i = 0; i < 6; i++) {
    frozen.push(await client.pollTask(stallHandle));
    await sleep(25);
  }
  const frozenCursors = new Set(frozen.map((p) => p.cursor));
  const freezeTick = Math.floor(stallPlan.eventMs / (350 * FAST));
  expect(
    "forced stall ⇒ cursor advances, then freezes while still running",
    frozen.every((p) => p.status === "running") && frozenCursors.size === 1 && frozen[0].cursor === `c${freezeTick}` && early.status === "running",
    `early ${early.cursor}, frozen ${[...frozenCursors].join(",")}, expected c${freezeTick}`,
  );
  await client.cancelTask(stallHandle);

  const corrupt = await run(client, agent, ctx("corrupt"));
  expect(
    "forced corrupt ⇒ completed with oracle.corrupted",
    corrupt.status === "completed" && corrupt.oracle?.corrupted === true && KINDS.includes(corrupt.oracle.corruption as CorruptionKind),
    corrupt.status === "completed" ? String(corrupt.oracle?.corruption) : corrupt.status,
  );

  const cleanHandle = await start(client, agent, ctx(undefined, findAttempt(agent, (n) => ctx(undefined, n), (p) => p.outcome === "success")));
  const finished = await pollUntilDone(client, cleanHandle);
  await client.cancelTask(cleanHandle);
  const after = await client.pollTask(cleanHandle);
  expect("cancelling a finished task is a no-op", finished.last.status === "completed" && after.status === "completed");

  const down = mockAgentsFor("accessibility")[4];
  const downPoll = await run(client, down, ctx(undefined));
  expect("an unhealthy agent's task fails with a provider error", downPoll.status === "error" && downPoll.code === "UPSTREAM_5XX");
}

// ---------- outputs ----------

async function testSuccessOutputs(siteUrl: string, verify: VerifyFn | null): Promise<string[][]> {
  const client = new MockDarwinClient();
  const rows: string[][] = [];
  await Promise.all(
    CAPABILITIES.map(async (capability) => {
      const agent = mockAgentsFor(capability)[1];
      const n = findAttempt(agent, (k) => contextFor(capability, siteUrl, k), (p) => p.outcome === "success");
      const ctx = contextFor(capability, siteUrl, n);
      const first = await run(client, agent, ctx);
      const twin = await run(new MockDarwinClient(), agent, ctx);
      const sameOutput = first.status === "completed" && twin.status === "completed" && JSON.stringify(first.output) === JSON.stringify(twin.output);
      expect(`${capability}: same seed and ids give the same output on a fresh client`, sameOutput);
      if (first.status !== "completed") {
        expect(`${capability}: clean attempt completes`, false, first.status);
        return;
      }
      expect(`${capability}: clean attempt reports oracle.corrupted = false`, first.oracle?.corrupted === false);
      let detail: string;
      if (capability === "crawl") {
        const parsed = CrawlOutputSchema.safeParse(first.output);
        const urls = parsed.success ? parsed.data.pages.map((p) => normalizeUrl(p.url)).sort() : [];
        const want = expectedPages(siteUrl).sort();
        expect("crawl: clean output lists exactly the demo-site pages", parsed.success && JSON.stringify(urls) === JSON.stringify(want), urls.map((u) => short(u, siteUrl)).join(" "));
        detail = `${urls.length} pages`;
      } else {
        const parsed = AuditOutputSchema.safeParse(first.output);
        const out = first.output as AuditOutput;
        const scope = capability === "accessibility" || capability === "performance" ? { pageUrl: siteUrl } : {};
        const recall = measureRecall(siteUrl, parsed.success ? out.issues : [], { category: capability as AuditCategory, ...scope });
        const extra = parsed.success ? unmatchedIssues(siteUrl, out.issues) : [];
        expect(
          `${capability}: clean output has real demo-site issues and nothing invented`,
          parsed.success && out.issues.length > 0 && extra.length === 0 && recall.ratio >= 0.5,
          `${out.issues?.length ?? 0} issues, recall ${recall.found}/${recall.expected}, ${extra.length} unmatched`,
        );
        detail = `${out.issues.length} issues, recall ${recall.found}/${recall.expected}`;
      }
      const verdict = verify ? await verify(capability, ctx.input, first.output, siteUrl, SEED + n) : null;
      if (verdict) expect(`${capability}: clean output passes verification`, verdict.pass, failedLayer(verdict));
      rows.push([capability, agent.name, String(n), detail, verdict ? (verdict.pass ? "pass" : `FAIL ${failedLayer(verdict)}`) : "n/a"]);
    }),
  );
  return rows.sort((a, b) => CAPABILITIES.indexOf(a[0] as Capability) - CAPABILITIES.indexOf(b[0] as Capability));
}

/** Recall < 1 and voice: a mediocre agent drops some findings but never invents any. */
async function testDegradation(siteUrl: string): Promise<void> {
  const client = new MockDarwinClient();
  const agent = mockAgentsFor("seo")[3];
  const clean = (await runCapability("seo", inputFor("seo", siteUrl))) as AuditOutput;
  const counts: number[] = [];
  let invented = 0;
  let severityShifts = 0;
  for (let n = 1, found = 0; n < 400 && found < 12; n++) {
    const ctx = contextFor("seo", siteUrl, n);
    if (planMockAttempt(agent, ctx).outcome !== "success") continue;
    found += 1;
    const poll = await run(client, agent, ctx);
    if (poll.status !== "completed") continue;
    const out = poll.output as AuditOutput;
    counts.push(out.issues.length);
    invented += unmatchedIssues(siteUrl, out.issues).length;
    severityShifts += out.issues.filter((issue) => cleanTwin(clean, issue)?.severity !== issue.severity).length;
  }
  expect(
    "mediocre agent: recall below 1 drops some findings, never invents any",
    counts.length >= 10 && counts.some((c) => c < clean.issues.length) && counts.every((c) => c >= 1 && c <= clean.issues.length) && invented === 0,
    `counts ${counts.join(",")} of ${clean.issues.length}, invented ${invented}`,
  );
  expect("severity noise shifts some severities by one level", severityShifts > 0, `${severityShifts} shifted`);

  // Voice: each healthy agent's clean findings, compared with the perfect output.
  const voices = await Promise.all(
    mockAgentsFor("seo")
      .filter((a) => a.healthy)
      .map(async (a) => {
        const n = findAttempt(a, (k) => contextFor("seo", siteUrl, k), (p) => p.outcome === "success");
        const poll = await run(client, a, contextFor("seo", siteUrl, n));
        const issues = poll.status === "completed" ? (poll.output as AuditOutput).issues : [];
        return { reworded: issues.some((i) => cleanTwin(clean, i)?.description !== i.description), summary: poll.status === "completed" ? (poll.output as AuditOutput).summary : "" };
      }),
  );
  expect(
    "agents word findings in their own voice",
    voices.filter((v) => v.reworded).length >= 2 && new Set(voices.map((v) => v.summary)).size >= 3,
    `${voices.filter((v) => v.reworded).length} of ${voices.length} agents reworded; summaries: ${voices.map((v) => v.summary).join(" | ")}`,
  );
}

function cleanTwin(clean: AuditOutput, issue: AuditOutput["issues"][number]): AuditOutput["issues"][number] | undefined {
  return clean.issues.find((c) => c.rule === issue.rule && c.pageUrl === issue.pageUrl && c.selector === issue.selector);
}

interface CorruptionRow {
  capability: Capability;
  kind: CorruptionKind;
  caughtBy: string;
}

async function testCorruptions(siteUrl: string, verify: VerifyFn | null): Promise<CorruptionRow[]> {
  const client = new MockDarwinClient();
  const rows: CorruptionRow[] = [];
  const pages = new Set(expectedPages(siteUrl));
  await Promise.all(
    CAPABILITIES.map(async (capability) => {
      const agent = mockAgentsFor(capability)[0];
      const clean = await runCapability(capability, inputFor(capability, siteUrl));
      for (const kind of KINDS) {
        const base = (n: number) => contextFor(capability, siteUrl, n, { forcedFault: "corrupt" });
        const n = findAttempt(agent, base, (p) => p.outcome === "bad_output" && p.corruption === kind);
        const poll = await run(client, agent, base(n));
        const label = `${capability}/${kind}`;
        if (poll.status !== "completed") {
          expect(`${label}: completes`, false, poll.status);
          continue;
        }
        const output = poll.output;
        expect(`${label}: oracle names the corruption`, poll.oracle?.corrupted === true && poll.oracle.corruption === kind);
        expect(`${label}: differs from the clean output`, JSON.stringify(output) !== JSON.stringify(clean));
        const caught = await catchability(capability, kind, output, siteUrl, pages);
        expect(`${label}: ${caught.how}`, caught.ok, caught.detail);
        let caughtBy = caught.ok ? caught.how : "NOT CAUGHT";
        if (verify) {
          const verdict = await verify(capability, base(n).input, output, siteUrl, SEED + n);
          expect(`${label}: rejected by verification`, !verdict.pass, verdict.pass ? "passed every layer" : failedLayer(verdict));
          caughtBy = verdict.pass ? "PASSED VERIFICATION" : failedLayer(verdict);
        }
        rows.push({ capability, kind, caughtBy });
      }
    }),
  );
  return rows.sort((a, b) => CAPABILITIES.indexOf(a.capability) - CAPABILITIES.indexOf(b.capability) || KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind));
}

/** Independent of lib/verify: shows each corruption trips a schema, rule or spot-check style test. */
async function catchability(
  capability: Capability,
  kind: CorruptionKind,
  output: unknown,
  siteUrl: string,
  pages: Set<string>,
): Promise<{ ok: boolean; how: string; detail: string }> {
  if (capability === "crawl") {
    const parsed = CrawlOutputSchema.safeParse(output);
    if (kind === "schema" || kind === "empty" || kind === "refusal") {
      const refusalOk = kind !== "refusal" || REFUSAL_TEXT.test(String((output as { summary?: string }).summary ?? ""));
      return { ok: !parsed.success && refusalOk, how: "fails the crawl contract", detail: parsed.success ? "schema passed" : "" };
    }
    const data = parsed.success ? (parsed.data as CrawlOutput) : null;
    const invented = data ? data.pages.filter((p) => !pages.has(normalizeUrl(p.url))) : [];
    return {
      ok: Boolean(data) && invented.length > 0 && invented.every((p) => p.status === 200) && (data?.pages.length ?? 0) > 5,
      how: "lists pages that do not exist (over the page cap)",
      detail: invented.map((p) => short(p.url, siteUrl)).join(" "),
    };
  }
  const parsed = AuditOutputSchema.safeParse(output);
  const data = parsed.success ? (parsed.data as AuditOutput) : null;
  switch (kind) {
    case "schema":
      return { ok: !parsed.success, how: "fails the audit contract", detail: parsed.success ? "schema passed" : parsed.error.issues[0]?.message ?? "" };
    case "empty":
      return {
        ok: Boolean(data) && data!.issues.length === 0 && data!.pagesChecked.length === 0 && /looks great/.test(data!.summary ?? ""),
        how: "empty report with no pages checked",
        detail: data?.summary ?? "",
      };
    case "refusal":
      return { ok: Boolean(data) && data!.issues.length === 0 && REFUSAL_TEXT.test(data!.summary ?? ""), how: "refusal text, no findings", detail: data?.summary ?? "" };
    case "hallucinated_pages": {
      const off = data ? data.issues.filter((i) => !pages.has(normalizeUrl(i.pageUrl))) : [];
      return {
        ok: Boolean(data) && off.length > 0 && off.length === data!.issues.length,
        how: "findings on pages that were never crawled",
        detail: [...new Set(off.map((i) => short(i.pageUrl, siteUrl)))].join(" "),
      };
    }
    case "fabricated": {
      if (!data) return { ok: false, how: "spot-check refutes sampled claims", detail: "schema failed" };
      const refutedBySeed = await Promise.all([1, 2, 3, 4, 5].map(async (seed) => (await spotCheckIssues(data.issues, { sample: 3, seed })).refuted));
      const unmatched = unmatchedIssues(siteUrl, data.issues).length;
      const gt = expectedIssues(siteUrl, { category: capability as AuditCategory }).length;
      return {
        ok: refutedBySeed.every((r) => r > 0) && unmatched >= Math.ceil(data.issues.length / 2),
        how: "spot-check refutes sampled claims",
        detail: `refuted per seed ${refutedBySeed.join(",")}; ${unmatched}/${data.issues.length} false (ground truth ${gt})`,
      };
    }
  }
}

/** Every healthy agent (each writes in its own voice) on every demo input, through lib/verify. */
async function testEveryAgentAndInput(siteUrl: string, verify: VerifyFn): Promise<void> {
  const client = new MockDarwinClient();
  await Promise.all(
    CAPABILITIES.map(async (capability) => {
      const inputs: AgentNodeInput[] =
        capability === "accessibility" || capability === "performance" ? expectedPages(siteUrl).map((pageUrl) => ({ siteUrl, pageUrl })) : [inputFor(capability, siteUrl)];
      const problems: string[] = [];
      let cleanRuns = 0;
      let recallMisses = 0;
      let corruptRuns = 0;
      for (const agent of mockAgentsFor(capability).filter((a) => a.healthy)) {
        for (const [i, input] of inputs.entries()) {
          const base = (n: number, extra: Partial<TaskContext> = {}) => contextFor(capability, siteUrl, n, { input, nodeInstanceId: `${capability}#sweep${i}`, ...extra });
          const where = `${agent.agentId}${"pageUrl" in input ? ` ${short(input.pageUrl, siteUrl)}` : ""}`;
          const n = findAttempt(agent, base, (p) => p.outcome === "success");
          const clean = await run(client, agent, base(n));
          cleanRuns += 1;
          if (clean.status !== "completed") problems.push(`${where} clean attempt ${clean.status}`);
          else {
            const verdict = await verify(capability, input, clean.output, siteUrl, SEED + n);
            const failed = verdict.layers.find((l) => !l.pass && !l.skipped);
            // Missing planted issues is the agent's recall model at work; anything else is a defect.
            if (failed?.layer === 3 && /^recall /.test(failed.reason)) recallMisses += 1;
            else if (failed) problems.push(`${where} clean output failed ${failedLayer(verdict)}`);
          }
          for (const kind of KINDS) {
            const corruptBase = (k: number) => base(k, { forcedFault: "corrupt" });
            const m = findAttempt(agent, corruptBase, (p) => p.outcome === "bad_output" && p.corruption === kind);
            const poll = await run(client, agent, corruptBase(m));
            corruptRuns += 1;
            if (poll.status !== "completed") problems.push(`${where} ${kind} ${poll.status}`);
            else if ((await verify(capability, input, poll.output, siteUrl, SEED + m)).pass) problems.push(`${where} ${kind} passed verification`);
          }
        }
      }
      expect(
        `${capability}: every healthy agent on every demo input passes clean (recall misses aside) and fails every corruption`,
        problems.length === 0,
        `${cleanRuns} clean (${recallMisses} recall misses), ${corruptRuns} corrupted${problems.length ? `; ${problems.slice(0, 2).join(" | ")}` : ""}`,
      );
    }),
  );
}

/** Two pages where every SEO rule already fails, so no true statement about them can be misstated. */
async function startBareSite(): Promise<{ siteUrl: string; close: () => Promise<void> }> {
  const page = "<!doctype html><html lang=\"en\"><head></head><body><h1>One</h1><h1>Two</h1><a href=\"checkout\">Checkout</a></body></html>";
  const server = http.createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    const found = path === "/shop/" || path === "/shop/checkout";
    res.writeHead(found ? 200 : 404, { "content-type": "text/html" });
    res.end(found ? page : "<!doctype html><html><body>Not found</body></html>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return { siteUrl: `http://127.0.0.1:${port}/shop/`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/** Off the demo site: a fabricated report is never just true findings, and invented pages never alias crawled ones. */
async function testCorruptionEdgeCases(verify: VerifyFn | null): Promise<void> {
  const site = await startBareSite();
  try {
    const { siteUrl } = site;
    const pages = [siteUrl, `${siteUrl}checkout`];
    const input = { siteUrl, pages };
    const clean = (await runCapability("seo", input)) as AuditOutput;
    const context: TaskContext = { runId: "run_edge", nodeInstanceId: "seo#edge", capability: "seo", input, seed: SEED, attemptNo: 1, timeScale: FAST, knownPages: pages };
    const trueKeys = new Set(clean.issues.map((i) => `${i.rule}|${siteRootUrl(i.pageUrl)}`));
    const problems: string[] = [];
    for (let s = 0; s < 8; s++) {
      const out = (await corruptOutput("fabricated", structuredClone(clean), corruptionContextFor(context, clean), rngFor(s, "edge"))) as AuditOutput;
      const real = out.issues.filter((i) => trueKeys.has(`${i.rule}|${siteRootUrl(i.pageUrl)}`)).length;
      const invented = out.issues.length - real;
      if (invented === 0 || real > Math.floor(invented / 3)) problems.push(`seed ${s}: ${real} true and ${invented} false findings`);
      if (verify && (await verify("seo", input, out, siteUrl, s, pages)).pass) problems.push(`seed ${s}: passed verification`);
    }
    expect(
      "fabricated: with nothing true to misstate, the claims name pages the site lacks",
      clean.issues.length >= 6 && problems.length === 0,
      `${clean.issues.length} clean issues; ${problems.slice(0, 2).join(" | ")}`,
    );

    // Crawled ".../checkout" and ".../admin/login/" are the pages "checkout/" and "admin/login" for verification.
    const known = [siteUrl, `${siteUrl}checkout`, `${siteUrl}admin/login/`];
    const knownIds = new Set(known.map(siteRootUrl));
    const crawl = (await runCapability("crawl", { siteUrl, maxPages: 5 })) as CrawlOutput;
    const aliased: string[] = [];
    for (let s = 0; s < 20; s++) {
      const audit = (await corruptOutput("hallucinated_pages", structuredClone(clean), corruptionContextFor({ ...context, knownPages: known }, clean), rngFor(s, "alias"))) as AuditOutput;
      const crawlCtx = corruptionContextFor({ ...context, capability: "crawl", input: { siteUrl, maxPages: 5 }, knownPages: known }, crawl);
      const fakeCrawl = (await corruptOutput("hallucinated_pages", structuredClone(crawl), crawlCtx, rngFor(s, "alias"))) as CrawlOutput;
      const invented = [...audit.issues.map((i) => i.pageUrl), ...fakeCrawl.pages.slice(crawl.pages.length).map((p) => p.url)];
      aliased.push(...invented.filter((url) => knownIds.has(siteRootUrl(url))));
    }
    expect("hallucinated pages never alias a crawled page (trailing slash ignored)", aliased.length === 0, [...new Set(aliased)].map((u) => short(u, siteUrl)).join(" "));
  } finally {
    await site.close();
  }
}

// ---------- statistics ----------

function testStatistics(siteUrl: string): string[][] {
  const rows: string[][] = [];
  for (const capability of CAPABILITIES) {
    const [primary, b1, b2] = mockAgentsFor(capability);
    const failRate = (agent: MockAgentProfile) => {
      let failed = 0;
      for (let n = 1; n <= STAT_ATTEMPTS; n++) {
        const ctx = contextFor(capability, siteUrl, n, { nodeInstanceId: `${capability}#stats` });
        if (planMockAttempt(agent, ctx).outcome !== "success") failed += 1;
      }
      return failed / STAT_ATTEMPTS;
    };
    const [p, r1, r2] = [failRate(primary), failRate(b1), failRate(b2)];
    const worstBackup = Math.max(r1, r2);
    expect(
      `${capability}: over ${STAT_ATTEMPTS} attempts the primary fails at least twice as often as either backup`,
      p >= 2 * worstBackup && p - worstBackup >= 0.04,
      `primary ${p.toFixed(3)}, backups ${r1.toFixed(3)} / ${r2.toFixed(3)}`,
    );
    const board = simulateLeaderboard(capability, siteUrl);
    const best = Math.max(board.scores[1], board.scores[2]);
    expect(
      `${capability}: after ${LEADERBOARD_RUNS} runs without chaos a backup out-scores the primary`,
      best > board.scores[0] && board.attempts[1] >= 3,
      board.scores.map((s, i) => `${s.toFixed(3)} (${board.attempts[i]})`).join(" / "),
    );
    rows.push([capability, p.toFixed(3), r1.toFixed(3), r2.toFixed(3), board.scores.map((s, i) => `${s.toFixed(3)} (${board.attempts[i]})`).join("  ")]);
  }
  return rows;
}

/** Runs of failover (primary, then backups in order), scored with the engine's Beta-Bernoulli formula. */
function simulateLeaderboard(capability: Capability, siteUrl: string): { scores: number[]; attempts: number[] } {
  const pool = [defaultMockPool(capability).primary, ...defaultMockPool(capability).backups];
  const attempts = [0, 0, 0];
  const successes = [0, 0, 0];
  const fanOut = capability === "accessibility" || capability === "performance" ? 5 : 1;
  for (let runNo = 0; runNo < LEADERBOARD_RUNS; runNo++) {
    for (let item = 0; item < fanOut; item++) {
      for (let i = 0; i < pool.length; i++) {
        const ctx = contextFor(capability, siteUrl, i + 1, { seed: 1000 + runNo, nodeInstanceId: `${capability}#${item}` });
        attempts[i] += 1;
        if (planMockAttempt(pool[i], ctx).outcome === "success") {
          successes[i] += 1;
          break;
        }
      }
    }
  }
  return { scores: successes.map((s, i) => (s + 1) / (attempts[i] + 2)), attempts };
}

// ---------- optional cross-check with lib/verify ----------

/** `crawledPages` defaults to the demo site's pages. */
type VerifyFn = (
  capability: Capability,
  input: AgentNodeInput,
  output: unknown,
  siteUrl: string,
  seed: number,
  crawledPages?: string[],
) => Promise<VerificationResult>;

async function loadVerifier(): Promise<VerifyFn | null> {
  try {
    const mod = (await import("@/lib/verify")) as { verifyOutput?: (ctx: unknown) => Promise<VerificationResult> };
    const verifyOutput = mod.verifyOutput;
    if (typeof verifyOutput !== "function") return null;
    const templateFor = (capability: Capability) => WORKFLOW.find((t) => t.capability === capability)?.id ?? "crawl";
    return (capability, input, output, siteUrl, seed, crawledPages) =>
      verifyOutput({
        template: getTemplate(templateFor(capability)),
        input,
        output,
        siteUrl,
        crawledPages: crawledPages ?? (capability === "crawl" ? [] : expectedPages(siteUrl)),
        seed,
        llmMode: "mock",
      });
  } catch (err) {
    console.log(`lib/verify not loadable, skipping the verification cross-check: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`);
    return null;
  }
}

function failedLayer(v: VerificationResult): string {
  const layer = v.layers.find((l) => !l.pass && !l.skipped);
  return layer ? `L${layer.layer} ${layer.name}: ${layer.reason.slice(0, 90)}` : "";
}

// ---------- main ----------

async function main(): Promise<number> {
  const started = Date.now();
  installNetworkGuard();
  const server = await startDemoServer(0);
  const siteUrl = `${server.origin}/demo-site/`;
  let successRows: string[][] = [];
  let corruptionRows: CorruptionRow[] = [];
  let statRows: string[][] = [];
  try {
    testCatalog();
    const client = new MockDarwinClient();
    await Promise.all([testSearch(client), testHealth(client)]);
    testPlanning(siteUrl);
    await testIdempotency(siteUrl);
    await testFaults(siteUrl);
    const verify = await loadVerifier();
    successRows = await testSuccessOutputs(siteUrl, verify);
    await testDegradation(siteUrl);
    corruptionRows = await testCorruptions(siteUrl, verify);
    if (verify) await testEveryAgentAndInput(siteUrl, verify);
    await testCorruptionEdgeCases(verify);
    statRows = testStatistics(siteUrl);
  } finally {
    await server.close();
  }
  expect("no request left the machine", blockedRequests.length === 0, blockedRequests.join(", "));

  console.log("\nClean attempts (first steady backup)");
  printTable(["capability", "agent", "attempt", "output", "verification"], successRows);
  console.log("Corruptions (primary agent, forced corrupt)");
  printTable(["capability", "kind", "caught by"], corruptionRows.map((r) => [r.capability, r.kind, r.caughtBy]));
  console.log(`Failure rates over ${STAT_ATTEMPTS} attempts and ${LEADERBOARD_RUNS}-run leaderboard (score, attempts)`);
  printTable(["capability", "primary", "backup 1", "backup 2", "primary / backup 1 / backup 2"], statRows);
  console.log("Checks");
  printTable(["", "check", "detail"], checks.map((c) => [c.pass ? "PASS" : "FAIL", c.name, c.detail.slice(0, 140)]));

  const failed = checks.filter((c) => !c.pass).length;
  console.log(`${checks.length - failed}/${checks.length} checks passed in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return failed === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
  },
);
