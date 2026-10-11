// Tests runtime discovery: which agents a step may use with nobody around to approve them, the
// order they're tried in, and the run's spending limit for paid agents. Simulated catalog only:
// no Darwin, no OpenAI.
// Usage: npx tsx --tsconfig tsconfig.json scripts/test-discovery.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Before any project import: env.ts reads these at load time.
process.env.AXOLOTL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "axolotl-discovery-test-"));
process.env.OPENAI_API_KEY = "";
process.env.DARWIN_ACCESS_TOKEN = "";
process.env.AXOLOTL_CLIENT = "mock";

import type { AgentCandidate, AttemptView, EngineEvent, RunConfig, RunSummary } from "@/lib/types";

interface Check {
  name: string;
  pass: boolean;
  detail: string;
}
const checks: Check[] = [];
let section = "";
function expect(name: string, pass: boolean, detail = ""): void {
  checks.push({ name: `${section}: ${name}`, pass, detail });
}

const blocked: string[] = [];
function installNetworkGuard(): void {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const host = new URL(raw).hostname;
    if (host === "127.0.0.1" || host === "localhost" || host.endsWith(".invalid")) return realFetch(input, init);
    blocked.push(host);
    throw new Error(`network guard: request to ${host} blocked`);
  }) as typeof fetch;
}

async function main(): Promise<void> {
  installNetworkGuard();
  const { startDemoServer } = await import("./serve-demo-site");
  const server = await startDemoServer(0);
  const siteUrl = `${server.origin}/demo-site/`;
  process.env.DEMO_SITE_URL = siteUrl;

  const { AGENT_TEMPLATES } = await import("@/config/workflow");
  const { discover, orderRoute, parsePriceCents } = await import("@/lib/engine/discovery");
  const { RunEngine } = await import("@/lib/engine/engine");
  const { NullStore } = await import("@/lib/engine/store");
  const { MockDarwinClient } = await import("@/lib/darwin/mock");
  const runtime = await import("@/lib/engine/runtime");
  const mock = new MockDarwinClient();
  const template = (capability: string) => AGENT_TEMPLATES.find((t) => t.capability === capability)!;
  const find = (capability: string, over: Partial<Parameters<typeof discover>[0]> = {}) =>
    discover({ template: template(capability), client: "mock", simulatedBackups: false, budgetCents: 0, stats: new Map(), useHistory: false, ...over });
  const skipReason = (d: Awaited<ReturnType<typeof find>>, slug: string) => d.skipped.find((x) => x.agent.agentId.endsWith(`:${slug}`))?.reason ?? "";
  const tierOf = (d: Awaited<ReturnType<typeof find>>, slug: string) => d.vetted.find((v) => v.agent.agentId.endsWith(`:${slug}`))?.tier;

  // ---------- vetting: what runs with nobody around ----------
  section = "vetting";
  const seo = await find("seo");
  expect("unsafe listing left out", /safety check/.test(skipReason(seo, "quillstone")), skipReason(seo, "quillstone"));
  expect("agent that's down left out", /Not answering/.test(skipReason(seo, "hollowmere")), skipReason(seo, "hollowmere"));
  expect("the rest are free and usable", ["rankfinch", "tagwarden", "ledgerline"].every((s) => tierOf(seo, s) === "free"));

  const links = await find("links");
  const signIn = links.skipped.find((x) => /sign-in/.test(x.reason));
  expect("agent that needs an API key left out", Boolean(signIn), JSON.stringify(links.skipped));

  const perfNoBudget = await find("performance");
  expect("paid agent left out with no spending limit", /no spending limit/.test(skipReason(perfNoBudget, "pageweight")), skipReason(perfNoBudget, "pageweight"));
  const perfLow = await find("performance", { budgetCents: 3 });
  expect("paid agent over the limit left out", /more than the run's \$0\.03 limit/.test(skipReason(perfLow, "pageweight")), skipReason(perfLow, "pageweight"));
  const perf = await find("performance", { budgetCents: 100 });
  const pageweight = perf.vetted.find((v) => v.agent.agentId.endsWith(":pageweight"));
  expect("paid agent usable within the limit", pageweight?.tier === "paid" && pageweight.agent.paid === true && pageweight.agent.priceCents === 4, JSON.stringify(pageweight));

  expect("price parsing", parsePriceCents("$0.04 per page audited") === 4 && parsePriceCents("$1.5 per call") === 150 && parsePriceCents("billed monthly") === undefined);

  // A real Darwin result with no Act access and no direct address can't be called.
  const unreachable: AgentCandidate = {
    agentId: "darwin:nowhere",
    capabilityId: "cap:nowhere",
    name: "Nowhere Agent",
    source: "darwin",
    capability: "seo",
    description: "SEO audit",
    readiness: "unavailable",
    canStartThread: false,
    reasons: [],
    uncertainties: [],
    requiredSetup: null,
    rank: 1,
    terms: { auth: "not_required", payment: "not_required" },
  };
  const real = await find("seo", {
    client: "darwin",
    simulatedBackups: true,
    search: async (source, query, capability) =>
      source === "darwin" ? { searchId: "s", status: "completed", query, agents: [unreachable] } : mock.search(query, { capability }),
  });
  expect("Darwin agent with no way to call it left out", /Can't be called/.test(skipReason(real, "nowhere")), JSON.stringify(real.skipped));
  expect("simulated agents are the last resort on a Darwin run", real.vetted.length > 0 && real.vetted.every((v) => v.tier === "simulated"));

  const failing = await find("seo", {
    client: "darwin",
    simulatedBackups: true,
    search: async (source, query, capability) => {
      if (source === "darwin") throw new Error("Darwin is down");
      return mock.search(query, { capability });
    },
  });
  expect("a failed Darwin search is noted, simulated agents still found", failing.notes.some((n) => /Darwin is down/.test(n)) && failing.vetted.length > 0, JSON.stringify(failing.notes));

  // ---------- order ----------
  section = "order";
  const route = orderRoute(perf, "performance", new Map());
  const tiers = route.plan.agents.map((c) => c.tier);
  expect("every free agent before any paid one", tiers.lastIndexOf("free") < tiers.indexOf("paid") && tiers.includes("paid"), tiers.join(","));
  expect("paid agent's reason gives its price", /\$0\.04 per call/.test(route.plan.agents.find((c) => c.tier === "paid")?.reason ?? ""));
  const noHistory = orderRoute(seo, "seo", new Map());
  expect("with no history and equal trust, Darwin's rank decides", noHistory.agents.map((a) => a.agentId).join(",") === "mock:seo:rankfinch,mock:seo:tagwarden,mock:seo:ledgerline", noHistory.agents.map((a) => a.agentId).join(","));
  const stat = (agentId: string, attempts: number, score: number) => [`${agentId}|seo`, { agentId, capability: "seo" as const, name: agentId, source: "mock" as const, attempts, successes: Math.round(score * attempts), failures: {}, totalLatencyMs: 0, score, avgLatencyMs: 100, updatedAt: 0 }] as const;
  const learned = orderRoute(seo, "seo", new Map([stat("mock:seo:rankfinch", 20, 0.4), stat("mock:seo:ledgerline", 20, 0.9)]));
  expect("history overrides Darwin's rank", learned.agents[0]?.agentId === "mock:seo:ledgerline" && learned.agents.at(-1)?.agentId === "mock:seo:rankfinch", learned.agents.map((a) => a.agentId).join(","));
  const baseline = orderRoute(seo, "seo", new Map(), undefined, true);
  expect("without Axolotl: only Darwin's top free result runs", baseline.agents.length === 1 && baseline.agents[0].agentId === "mock:seo:rankfinch", baseline.agents.map((a) => a.agentId).join(","));

  // ---------- spending limit in a run ----------
  section = "budget";
  let counter = 0;
  const runWith = async (over: Partial<RunConfig>, onlyPaidPerf: boolean, faults: (engine: InstanceType<typeof RunEngine>, runId: string) => void = () => undefined) => {
    const config: RunConfig = {
      siteUrl,
      maxPages: 2,
      client: "mock",
      simulatedBackups: false,
      budgetCents: 0,
      chaos: { enabled: false, rate: 0, weights: { ...runtime.DEFAULT_CHAOS.weights } },
      llmMode: "mock",
      seed: 21,
      timeScale: 0.03,
      concurrency: 6,
      baseline: false,
      persist: false,
      recordStats: false,
      ...over,
    };
    const run: RunSummary = { id: `run_budget_${++counter}`, status: "running", config, createdAt: Date.now() };
    const events: EngineEvent[] = [];
    const engine = new RunEngine(run, {
      client: mock,
      store: new NullStore(),
      publish: (e) => events.push(e),
      // Performance finds only its paid agent, so the limit decides whether the step runs at all.
      search: async (_source, query, capability) => {
        const r = await mock.search(query, { capability });
        return onlyPaidPerf && capability === "performance" ? { ...r, agents: r.agents.filter((a) => a.agentId.endsWith(":pageweight")) } : r;
      },
    });
    const done = engine.execute();
    faults(engine, run.id);
    await done;
    const alerts = events.filter((e): e is Extract<EngineEvent, { type: "alert" }> => e.type === "alert").map((e) => e.message);
    return { run: engine.run, attempts: engine.attempts as AttemptView[], alerts, nodes: [...engine.nodes.values()] };
  };
  const perfAttempts = (r: Awaited<ReturnType<typeof runWith>>) => r.attempts.filter((a) => a.nodeId.includes(":perf:"));

  const none = await runWith({}, true);
  expect("no limit: the paid-only step is lost, run partial", none.run.status === "partial" && perfAttempts(none).length === 0 && (none.run.stats?.spentCents ?? -1) === 0, `${none.run.status} ${perfAttempts(none).length}`);
  expect("…and the step says it found nothing usable", none.nodes.filter((n) => n.templateId === "perf" && !n.placeholder).every((n) => /can run unattended/.test(n.error ?? "")));

  const plenty = await runWith({ budgetCents: 100 }, true);
  const paidTries = perfAttempts(plenty);
  expect("with a limit the paid agent runs", plenty.run.status === "completed" && paidTries.length >= 2 && paidTries.every((a) => a.agent.agentId.endsWith(":pageweight")), `${plenty.run.status} ${paidTries.length}`);
  expect("each paid attempt records its cost", paidTries.every((a) => a.costCents === 4), paidTries.map((a) => a.costCents).join(","));
  expect("run total matches the attempts", plenty.run.stats?.spentCents === paidTries.length * 4, String(plenty.run.stats?.spentCents));

  const tight = await runWith({ budgetCents: 4 }, true);
  const tightTries = perfAttempts(tight);
  expect("limit covers one call: only one page gets the paid agent", tightTries.length === 1 && tight.run.stats?.spentCents === 4, `${tightTries.length} tries, ${tight.run.stats?.spentCents}c`);
  expect("…the other page says why it stopped", tight.alerts.some((m) => /over the run's \$0\.04 limit/.test(m)), tight.alerts.filter((m) => /Performance/.test(m)).join(" | "));
  expect("spend never exceeds the limit", (tight.run.stats?.spentCents ?? 0) <= 4);

  // Free agents first: with the full catalog and a limit, a page only reaches the paid agent after every free one fails.
  const freeFirst = await runWith({ budgetCents: 100 }, false);
  const firstPerf = perfAttempts(freeFirst);
  expect("free agents are tried before paying", firstPerf.length > 0 && !firstPerf[0].agent.agentId.endsWith(":pageweight") && !firstPerf[0].costCents, firstPerf.map((a) => a.agent.agentId).join(","));
  expect("nothing spent when free agents succeed", firstPerf.every((a) => a.costCents === undefined || a.agent.agentId.endsWith(":pageweight")) && (freeFirst.run.stats?.spentCents ?? 0) === firstPerf.filter((a) => a.costCents).length * 4);

  // The provider ran the task, so a paid attempt that then fails is still charged.
  const failedPaid = await runWith({ budgetCents: 8 }, true, (engine, runId) => engine.injectFault(`${runId}:perf:*`, "error"));
  const failedTries = perfAttempts(failedPaid);
  expect("a started paid task that fails is still charged", failedTries.some((a) => a.outcome === "hard_failure" && a.costCents === 4), JSON.stringify(failedTries.map((a) => [a.outcome, a.costCents])));
  expect("…and counts against the limit", (failedPaid.run.stats?.spentCents ?? 0) <= 8 && (failedPaid.run.stats?.spentCents ?? 0) === failedTries.reduce((s, a) => s + (a.costCents ?? 0), 0));

  section = "network";
  expect("no request left the machine", blocked.length === 0, blocked.join(", "));
  await server.close();
}

main()
  .catch((err) => {
    checks.push({ name: "harness", pass: false, detail: (err as Error).stack ?? String(err) });
  })
  .finally(() => {
    for (const c of checks) console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}${c.pass || !c.detail ? "" : `\n      ${c.detail}`}`);
    const failed = checks.filter((c) => !c.pass).length;
    console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
    process.exit(failed ? 1 : 0);
  });
