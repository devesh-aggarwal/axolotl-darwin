// Headless engine tests: fan-out, failover order, manual faults (queued and on running attempts),
// exhausted branches, baseline semantics, cancellation, crash + resume, stats bookkeeping and the
// time-lapse cancel. Mock client against a local demo server, temp data dir. Exits non-zero on failure.
// Usage: npx tsx --tsconfig tsconfig.json scripts/test-engine.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Before any project import: env.ts reads these at load time.
process.env.AXOLOTL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "axolotl-engine-test-"));
process.env.OPENAI_API_KEY = "";
process.env.AXOLOTL_CLIENT = "mock";

import type { AttemptView, EngineEvent, NodeView, RunConfig, RunStats, RunSummary } from "@/lib/types";

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred: () => boolean, timeoutMs = 10_000, stepMs = 3): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(stepMs);
  }
  return pred();
}

const ACTIVE = new Set(["idle", "queued", "running", "verifying", "swapping"]);
const inFlight = (a: AttemptView) => a.outcome === "running" || a.outcome === "verifying";
const failed = (a: AttemptView) => a.outcome === "hard_failure" || a.outcome === "silent_failure";

async function main(): Promise<void> {
  installNetworkGuard();
  const { startDemoServer } = await import("./serve-demo-site");
  const server = await startDemoServer(0);
  const siteUrl = `${server.origin}/demo-site/`;
  process.env.DEMO_SITE_URL = siteUrl;

  const { RunEngine } = await import("@/lib/engine/engine");
  const { NullStore, SqliteStore, isInterruptedAttempt } = await import("@/lib/engine/store");
  const { MockDarwinClient } = await import("@/lib/darwin/mock");
  const runtime = await import("@/lib/engine/runtime");
  const { subscribe } = await import("@/lib/events");
  const { getAllStats } = await import("@/lib/engine/stats");
  const timelapse = await import("@/lib/engine/timelapse");
  type TaskHandle = import("@/lib/darwin/types").TaskHandle;

  const client = new MockDarwinClient();
  const sqlite = new SqliteStore();
  const statAttempts = () => getAllStats().reduce((s, a) => s + a.attempts, 0);
  let counter = 0;

  function config(over: Partial<RunConfig> = {}): RunConfig {
    return {
      siteUrl,
      maxPages: 2,
      client: "mock",
      simulatedBackups: false,
      budgetCents: 0,
      chaos: { enabled: false, rate: 0, weights: { ...runtime.DEFAULT_CHAOS.weights } },
      llmMode: "mock",
      seed: 101,
      timeScale: 0.03,
      concurrency: 6,
      baseline: false,
      persist: true,
      recordStats: true,
      ...over,
    };
  }

  function mk(over: Partial<RunConfig> = {}, opts: { store?: InstanceType<typeof SqliteStore>; onEvent?: (e: EngineEvent) => void } = {}) {
    const run: RunSummary = { id: `t${++counter}_${Date.now().toString(36)}`, status: "running", config: config(over), createdAt: Date.now() };
    const events: EngineEvent[] = [];
    let finishedAt = 0;
    const engine = new RunEngine(run, {
      client,
      store: opts.store ?? new NullStore(),
      publish: (e) => {
        events.push(e);
        if (e.type === "run_finished") finishedAt = events.length;
        opts.onEvent?.(e);
      },
    });
    const node = (tpl: string) => engine.nodes.get(`${run.id}:${tpl}`);
    const attemptsOf = (tpl: string) => engine.attempts.filter((a) => a.nodeId === `${run.id}:${tpl}`);
    const eventsAfterFinish = () => events.slice(finishedAt).filter((e) => e.type !== "stats_updated");
    return { engine, run, events, node, attemptsOf, eventsAfterFinish };
  }

  /** Independent recomputation of the RunStats fields the engine derives from nodes and attempts. */
  function expectedStats(nodes: NodeView[], attempts: AttemptView[]) {
    const judged = attempts.filter((a) => !isInterruptedAttempt(a));
    const hadFailure = new Set(judged.filter(failed).map((a) => a.nodeId));
    const agents = nodes.filter((n) => n.kind === "agent" && !n.placeholder);
    return {
      recoveries: agents.filter((n) => n.state === "passed" && hadFailure.has(n.id)).length,
      failedBranches: agents.filter((n) => n.state === "failed").length + nodes.filter((n) => n.placeholder && n.state === "failed").length,
      hardFailures: judged.filter((a) => a.outcome === "hard_failure").length,
      silentFailures: judged.filter((a) => a.outcome === "silent_failure").length,
    };
  }

  function statsMatch(stats: RunStats | undefined, nodes: NodeView[], attempts: AttemptView[]): void {
    const want = expectedStats(nodes, attempts);
    const got = { recoveries: stats?.recoveries, failedBranches: stats?.failedBranches, hardFailures: stats?.hardFailures, silentFailures: stats?.silentFailures };
    expect("RunStats recoveries / failedBranches / failures match the attempts", JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
    expect("RunStats.attempts counts every attempt", stats?.attempts === attempts.length, `${stats?.attempts} vs ${attempts.length}`);
  }

  function uniqueKeys(attempts: AttemptView[]): void {
    const keys = new Set(attempts.map((a) => a.idempotencyKey));
    const ids = new Set(attempts.map((a) => a.id));
    expect("every attempt has its own idempotency key", keys.size === attempts.length, `${keys.size} keys for ${attempts.length} attempts`);
    expect("attempt ids are unique", ids.size === attempts.length);
  }

  // ---------- 1. clean run: fan-out wiring, persistence, stats once per attempt ----------
  {
    section = "clean run";
    const before = statAttempts();
    const t = mk({ seed: 101 }, { store: sqlite });
    const run = await t.engine.execute();
    const nodes = [...t.engine.nodes.values()];
    const crawlPages = ((t.node("crawl")?.output as { pages: { url: string }[] } | undefined)?.pages ?? []).map((p) => p.url);
    expect("run completed", run.status === "completed", run.status);
    expect("crawl found pages", crawlPages.length > 0, String(crawlPages.length));
    for (const tpl of ["a11y", "perf"]) {
      const inst = nodes.filter((n) => n.templateId === tpl);
      expect(`${tpl} fans out one instance per crawled page`, inst.length === crawlPages.length && inst.every((n, i) => n.id === `${run.id}:${tpl}:${i}` && n.itemKey === crawlPages[i]));
    }
    expect("placeholders are gone after fan-out", !nodes.some((n) => n.placeholder));
    const merge = t.node("merge")!;
    const wantDeps = nodes.filter((n) => ["a11y", "perf", "seo", "security", "links"].includes(n.templateId)).map((n) => n.id).sort();
    expect("merge depends on every audit instance", JSON.stringify([...merge.dependsOn].sort()) === JSON.stringify(wantDeps), merge.dependsOn.join(","));
    expect("merge ran after every audit branch settled", nodes.filter((n) => wantDeps.includes(n.id)).every((n) => (n.finishedAt ?? Infinity) <= (merge.startedAt ?? 0)));
    expect("no attempt left in flight", !t.engine.attempts.some(inFlight));
    uniqueKeys(t.engine.attempts);
    statsMatch(run.stats, nodes, t.engine.attempts);
    expect("agent stats recorded exactly once per attempt", statAttempts() - before === t.engine.attempts.length, `${statAttempts() - before} vs ${t.engine.attempts.length}`);
    const rec = sqlite.loadRun(run.id)!;
    expect("stored run is completed with stats", rec.run.status === "completed" && Boolean(rec.run.stats));
    expect("no placeholder rows are stored", !rec.nodes.some((n) => n.placeholder));
    const storedMerge = rec.nodes.find((n) => n.templateId === "merge");
    expect("stored merge edges point at real instances", JSON.stringify([...(storedMerge?.dependsOn ?? [])].sort()) === JSON.stringify(wantDeps));
    expect("stored attempts match memory", rec.attempts.length === t.engine.attempts.length);
    expect("recall measured on the demo site", typeof run.stats?.recall === "number");
  }

  // ---------- 2. failover via queued faults, in the order the router planned ----------
  {
    section = "failover";
    const t = mk({ seed: 202 });
    const done = t.engine.execute();
    const rid = t.run.id;
    expect("fault on a placeholder is armed for the first page step", t.engine.injectFault(`${rid}:a11y:*`, "error") === true);
    expect("fault on a builtin is refused", t.engine.injectFault(`${rid}:merge`, "error") === false);
    expect("crash queued on seo", t.engine.injectFault(`${rid}:seo`, "error"));
    expect("corrupt queued on links", t.engine.injectFault(`${rid}:links`, "corrupt"));
    const run = await done;
    const seo = t.attemptsOf("seo");
    const seoOrder = (t.engine.nodes.get(`${rid}:seo`)?.route?.agents ?? []).map((c) => c.agent.agentId);
    const links = t.attemptsOf("links");
    expect("seo attempt 1 got the queued crash", seo[0]?.injectedFault === "error" && seo[0]?.outcome === "hard_failure" && seo[0]?.failureType === "error", JSON.stringify(seo[0]?.failureType));
    expect("seo recovered on a backup", t.node("seo")?.state === "passed" && seo.length >= 2 && (t.node("seo")?.swaps ?? 0) >= 1);
    expect(
      "seo walked the agents in the planned order",
      seo.every((a, i) => a.agent.agentId === seoOrder[i]),
      `${seo.map((a) => a.agent.agentId).join(" > ")} vs ${seoOrder.join(" > ")}`,
    );
    expect("links attempt 1: corrupted output caught by verification", links[0]?.outcome === "silent_failure" && links[0]?.failureType === "verification", links[0]?.failureDetail ?? "");
    expect("links recovered on a backup", t.node("links")?.state === "passed" && links[1]?.agent.agentId !== links[0]?.agent.agentId);
    expect("caught corruption is not 'accepted corrupt output'", run.stats?.acceptedCorruptOutput === false);
    expect("run completed with two recoveries", run.status === "completed" && (run.stats?.recoveries ?? 0) >= 2, `${run.status} ${run.stats?.recoveries}`);
    expect("no human intervention when everything recovered", run.stats?.humanInterventions === 0);
    uniqueKeys(t.engine.attempts);
    statsMatch(run.stats, [...t.engine.nodes.values()], t.engine.attempts);
  }

  // ---------- 3. manual faults on running attempts ----------
  {
    section = "manual faults (running)";
    const plan: Record<string, "timeout" | "stall" | "error" | "auth_block"> = { security: "timeout", links: "stall", seo: "error", "a11y:0": "auth_block" };
    const injected: Record<string, boolean> = {};
    const t: ReturnType<typeof mk> = mk(
      { seed: 303 },
      {
        onEvent: (e) => {
          if (e.type !== "attempt" || e.attempt.attemptNo !== 1 || e.attempt.outcome !== "running" || !e.attempt.instruction) return;
          const tpl = e.attempt.nodeId.slice(t.run.id.length + 1);
          const fault = plan[tpl];
          if (!fault || tpl in injected) return;
          injected[tpl] = false;
          setTimeout(() => (injected[tpl] = t.engine.injectFault(e.attempt.nodeId, fault)), 0);
        },
      },
    );
    const run = await t.engine.execute();
    for (const [tpl, fault] of Object.entries(plan)) {
      const a = t.attemptsOf(tpl)[0];
      const want = fault === "error" ? "killed" : fault;
      expect(`${fault} injected into running ${tpl}`, injected[tpl] === true && a?.injectedFault === fault, String(injected[tpl]));
      expect(`${tpl} attempt 1 failed as ${want}`, a?.outcome === "hard_failure" && a?.failureType === want, `${a?.outcome} ${a?.failureType}`);
      expect(`${tpl} recovered on a backup`, t.node(tpl)?.state === "passed");
    }
    expect("run completed", run.status === "completed", run.status);
    statsMatch(run.stats, [...t.engine.nodes.values()], t.engine.attempts);
  }

  // ---------- 4. exhausted branch: partial run ----------
  {
    section = "exhausted branch";
    const t = mk({ seed: 404 });
    const done = t.engine.execute();
    for (let i = 0; i < 6; i++) t.engine.injectFault(`${t.run.id}:seo`, "error");
    const run = await done;
    const merge = t.node("merge")!;
    const mergeOut = merge.output as { partialBranches: { nodeId: string }[] };
    expect("seo failed after every agent", t.node("seo")?.state === "failed" && t.attemptsOf("seo").length === (t.node("seo")?.route?.agents.length ?? -1));
    expect("run is partial, not failed", run.status === "partial", run.status);
    expect("merge marked partial and lists seo", merge.state === "partial" && mergeOut.partialBranches.some((b) => b.nodeId === `${t.run.id}:seo`));
    expect("fix plan still produced", t.node("fixplan")?.state === "passed");
    expect("lost branch needs a human", run.stats?.humanInterventions === 1);
    expect("alert says the branch stopped", t.events.some((e) => e.type === "alert" && e.level === "error" && /every agent found for this step failed/.test(e.message)));
    statsMatch(run.stats, [...t.engine.nodes.values()], t.engine.attempts);
  }

  // ---------- 5. crawl exhausted: fan-out branches lost ----------
  {
    section = "crawl exhausted";
    const t = mk({ seed: 505 });
    const done = t.engine.execute();
    for (let i = 0; i < 6; i++) t.engine.injectFault(`${t.run.id}:crawl`, "error");
    const run = await done;
    const placeholders = [...t.engine.nodes.values()].filter((n) => n.placeholder);
    expect("both fan-out placeholders failed", placeholders.length === 2 && placeholders.every((n) => n.state === "failed"));
    expect("failedBranches counts crawl + both fan-out templates", (run.stats?.failedBranches ?? 0) >= 3, String(run.stats?.failedBranches));
    expect("site-wide audits still ran on the site root", t.node("seo")?.state === "passed" && t.node("security")?.state === "passed");
    const mergeOut = t.node("merge")?.output as { partialBranches: { nodeId: string }[] };
    expect("merge lists the lost fan-out branches", placeholders.every((p) => mergeOut.partialBranches.some((b) => b.nodeId === p.id)));
    expect("run is partial", run.status === "partial", run.status);
    statsMatch(run.stats, [...t.engine.nodes.values()], t.engine.attempts);
  }

  // ---------- 6. baseline ----------
  {
    section = "baseline";
    const before = statAttempts();
    const t = mk({ seed: 606, baseline: true, recordStats: false });
    const done = t.engine.execute();
    t.engine.injectFault(`${t.run.id}:seo`, "error");
    t.engine.injectFault(`${t.run.id}:links`, "corrupt");
    const run = await done;
    const nodes = [...t.engine.nodes.values()].filter((n) => n.kind === "agent" && !n.placeholder);
    expect("one attempt per node, no failover", nodes.every((n) => t.attemptsOf(n.id.slice(t.run.id.length + 1)).length <= 1 && n.swaps === 0));
    expect("crashed seo is not retried", t.node("seo")?.state === "failed");
    expect("corrupted links output accepted unverified", t.node("links")?.state === "passed" && !t.attemptsOf("links")[0]?.verification);
    expect("no attempt is verified", !t.engine.attempts.some((a) => a.verification));
    expect("acceptedCorruptOutput set", run.stats?.acceptedCorruptOutput === true);
    expect("humanInterventions 1, recoveries 0", run.stats?.humanInterventions === 1 && run.stats?.recoveries === 0);
    expect("no agent stats recorded", statAttempts() === before, `${statAttempts() - before} recorded`);
    expect("no promotion alerts", !t.events.some((e) => e.type === "alert" && /promoted/.test(e.message)));
    statsMatch(run.stats, [...t.engine.nodes.values()], t.engine.attempts);
  }

  // ---------- 7. cancellation ----------
  {
    section = "cancel";
    const before = statAttempts();
    const t = mk({ seed: 707, timeScale: 0.2 }, { store: sqlite });
    const done = t.engine.execute();
    const busy = await waitFor(() => t.engine.attempts.filter((a) => a.outcome === "running").length >= 3);
    expect("several attempts in flight before cancel", busy);
    const keys = t.engine.attempts.filter(inFlight).map((a) => a.idempotencyKey);
    const t0 = Date.now();
    t.engine.cancel();
    const run = await done;
    const took = Date.now() - t0;
    expect("execute() settles promptly", took < 1_000, `${took} ms`);
    expect("status cancelled", run.status === "cancelled", run.status);
    expect("no attempt left in flight", !t.engine.attempts.some(inFlight));
    expect("in-flight attempts closed as interrupted", t.engine.attempts.filter((a) => keys.includes(a.idempotencyKey)).every(isInterruptedAttempt));
    expect("no node left active", ![...t.engine.nodes.values()].some((n) => ACTIVE.has(n.state)));
    expect("fault after cancel refused", t.engine.injectFault(`${t.run.id}:seo`, "error") === false);
    await sleep(300);
    expect("nothing published after run_finished", t.eventsAfterFinish().length === 0, t.eventsAfterFinish().map((e) => e.type).join(","));
    const judged = t.engine.attempts.filter((a) => !isInterruptedAttempt(a)).length;
    expect("stats recorded only for judged attempts", statAttempts() - before === judged, `${statAttempts() - before} vs ${judged}`);
    const rec = sqlite.loadRun(t.run.id)!;
    expect("stored attempts closed too", !rec.attempts.some(inFlight) && rec.attempts.length === t.engine.attempts.length);
    expect("stored nodes closed too", !rec.nodes.some((n) => ACTIVE.has(n.state)));
    // Every task this run started at the provider is cancelled or finished.
    const internals = client as unknown as { tasks: Map<string, { handle: TaskHandle }> };
    const handles = [...internals.tasks.entries()].filter(([k]) => k.startsWith(`axl:${t.run.id}:`)).map(([, v]) => v.handle);
    const polls = await Promise.all(handles.map((h) => client.pollTask(h)));
    expect("no provider task left running", polls.every((p) => p.status !== "running"), polls.map((p) => p.status).join(","));
    statsMatch(run.stats, [...t.engine.nodes.values()], t.engine.attempts);
  }

  // ---------- 8. concurrency limit ----------
  {
    section = "concurrency";
    const busy = new Set<string>();
    let peak = 0;
    const t = mk(
      { seed: 808, concurrency: 2 },
      {
        onEvent: (e) => {
          if (e.type !== "node_updated" || e.node.kind !== "agent") return;
          if (["running", "verifying", "swapping"].includes(e.node.state)) busy.add(e.node.id);
          else busy.delete(e.node.id);
          peak = Math.max(peak, busy.size);
        },
      },
    );
    const run = await t.engine.execute();
    expect("never more than `concurrency` agent nodes at work", peak <= 2 && peak >= 1, String(peak));
    expect("run finished", run.status === "completed" || run.status === "partial", run.status);
  }

  // ---------- 9. crash + resume through the runtime ----------
  {
    section = "crash + resume";
    const events: EngineEvent[] = [];
    const unsubscribe = subscribe((e) => events.push(e));
    const finished = (id: string, n: number) => events.filter((e) => e.type === "run_finished" && e.run.id === id).length >= n;
    const started = runtime.startRun({ siteUrl, maxPages: 2, timeScale: 0.05, seed: 909, chaos: { enabled: false, rate: 0, weights: runtime.DEFAULT_CHAOS.weights } });
    const id = started.id;
    const record = () => runtime.getRunRecord(id)!;
    const ready = await waitFor(() => {
      const r = record();
      const passedAudits = r.nodes.filter((n) => n.state === "passed" && n.templateId !== "crawl").length;
      return r.nodes.some((n) => n.templateId === "crawl" && n.state === "passed") && passedAudits >= 1 && r.attempts.some((a) => a.outcome === "running");
    });
    expect("crawl and one audit passed, others in flight", ready);
    const crawlPages = ((record().nodes.find((n) => n.templateId === "crawl")?.output as { pages: { url: string }[] }).pages ?? []).map((p) => p.url);
    expect("crash accepted", runtime.crashRun(id));
    expect("crash settles promptly", await waitFor(() => finished(id, 1), 1_000));
    let threw = "";
    try {
      runtime.crashRun(id);
    } catch (e) {
      threw = (e as Error).message;
    }
    expect("second crash is a no-op", threw === "" && runtime.crashRun(id) === false);

    const crashed = sqlite.loadRun(id)!;
    expect("stored status crashed", crashed.run.status === "crashed", crashed.run.status);
    expect("no stored attempt still running", !crashed.attempts.some(inFlight));
    const passedBefore = crashed.nodes.filter((n) => n.state === "passed").map((n) => n.id);
    const attemptsBefore = new Map(passedBefore.map((nid) => [nid, crashed.attempts.filter((a) => a.nodeId === nid).length]));
    const preCrash = crashed.attempts.map((a) => a.id);

    runtime.resumeRun(id);
    let second = "";
    try {
      runtime.resumeRun(id);
    } catch (e) {
      second = (e as Error).message;
    }
    expect("double resume refused while running", /still running/.test(second), second);
    expect("resumed run completes", await waitFor(() => finished(id, 2), 15_000));
    const done = record();
    expect("final status completed", done.run.status === "completed", done.run.status);
    const restored = done.nodes.filter((n) => n.restored).map((n) => n.id);
    expect("every checkpointed node restored", passedBefore.every((nid) => restored.includes(nid)), `${restored.length} restored of ${passedBefore.length}`);
    expect("restored nodes did not run again", passedBefore.every((nid) => done.attempts.filter((a) => a.nodeId === nid).length === attemptsBefore.get(nid)));
    for (const tpl of ["a11y", "perf"]) {
      const inst = done.nodes.filter((n) => n.templateId === tpl);
      expect(`${tpl} instance ids line up with the restored crawl`, inst.length === crawlPages.length && inst.every((n) => n.itemKey === crawlPages[Number(n.id.split(":").pop())]));
    }
    expect("pre-crash attempts kept in the record", preCrash.every((aid) => done.attempts.some((a) => a.id === aid)));
    uniqueKeys(done.attempts);
    expect("no attempt left in flight", !done.attempts.some(inFlight));
    expect("crash-interrupted attempts are not counted as failures", done.attempts.some(isInterruptedAttempt));
    statsMatch(done.run.stats, done.nodes, done.attempts);
    let again = "";
    try {
      runtime.resumeRun(id);
    } catch (e) {
      again = (e as Error).message;
    }
    expect("resume of a completed run refused", /already completed/.test(again), again);
    let missing = "";
    try {
      runtime.resumeRun("run_does_not_exist");
    } catch (e) {
      missing = e instanceof runtime.RunNotFoundError ? "notfound" : (e as Error).message;
    }
    expect("resume of an unknown run is not-found", missing === "notfound", missing);
    const stored = sqlite.loadRun(id)!;
    expect("stored record matches memory after resume", stored.attempts.length === done.attempts.length && !stored.nodes.some((n) => n.placeholder));

    // Crash before the crawl finished: the crawl reruns with fresh attempt numbers, then fans out.
    section = "crash before crawl";
    const early = runtime.startRun({ siteUrl, maxPages: 2, timeScale: 0.2, seed: 910, chaos: { enabled: false, rate: 0, weights: runtime.DEFAULT_CHAOS.weights } });
    const crawlRunning = await waitFor(() => runtime.getRunRecord(early.id)!.attempts.some((a) => a.outcome === "running" && a.nodeId.endsWith(":crawl")));
    expect("crawl attempt in flight", crawlRunning);
    runtime.crashRun(early.id);
    expect("crashed", await waitFor(() => finished(early.id, 1), 1_000));
    runtime.resumeRun(early.id);
    expect("resumed run completes", await waitFor(() => finished(early.id, 2), 20_000));
    const er = runtime.getRunRecord(early.id)!;
    const crawlAttempts = er.attempts.filter((a) => a.nodeId === `${early.id}:crawl`);
    expect("crawl attempt numbering continues after resume", crawlAttempts.length >= 2 && crawlAttempts[0].attemptNo === 1 && crawlAttempts[1].attemptNo === 2 && isInterruptedAttempt(crawlAttempts[0]));
    expect("fan-out happened after resume", er.nodes.some((n) => n.templateId === "a11y" && !n.placeholder) && !er.nodes.some((n) => n.placeholder));
    expect("status completed", er.run.status === "completed", er.run.status);
    uniqueKeys(er.attempts);
    statsMatch(er.run.stats, er.nodes, er.attempts);

    // Resume of a partial run: the lost branch reruns, so everything downstream of it must rerun too.
    section = "resume partial run";
    const chaosOff = { enabled: false, rate: 0, weights: runtime.DEFAULT_CHAOS.weights };
    const part = runtime.startRun({ siteUrl, maxPages: 2, timeScale: 0.03, seed: 911, chaos: chaosOff });
    for (let i = 0; i < 6; i++) runtime.injectFault(part.id, `${part.id}:seo`, "error");
    expect("first pass ends partial", (await waitFor(() => finished(part.id, 1), 15_000)) && runtime.getRunRecord(part.id)!.run.status === "partial");
    const stalePrioritized = runtime.getRunRecord(part.id)!.nodes.find((n) => n.templateId === "prioritize")?.output as { issues: { category: string }[] };
    expect("first pass has no SEO findings", !stalePrioritized.issues.some((i) => i.category === "seo"));
    runtime.resumeRun(part.id);
    expect("resumed partial run finishes", await waitFor(() => finished(part.id, 2), 15_000));
    const pr = runtime.getRunRecord(part.id)!;
    const byTpl = (tpl: string) => pr.nodes.find((n) => n.templateId === tpl)!;
    expect("seo reran and passed", byTpl("seo").state === "passed" && !byTpl("seo").restored);
    expect("merge, prioritize and fix plan reran (not restored)", ["merge", "prioritize", "fixplan"].every((tpl) => byTpl(tpl).state === "passed" && !byTpl(tpl).restored));
    const fresh = byTpl("prioritize").output as { issues: { category: string }[] };
    expect("final report includes the recovered branch", fresh.issues.some((i) => i.category === "seo"));
    expect("untouched branches stay restored", byTpl("security").restored === true && byTpl("crawl").restored === true);
    expect("status completed", pr.run.status === "completed", pr.run.status);
    statsMatch(pr.run.stats, pr.nodes, pr.attempts);

    // Resume after the crawl was lost: site audits that ran on the site root alone must rerun on the real pages.
    section = "resume after lost crawl";
    const lost = runtime.startRun({ siteUrl, maxPages: 2, timeScale: 0.03, seed: 912, chaos: chaosOff });
    for (let i = 0; i < 6; i++) runtime.injectFault(lost.id, `${lost.id}:crawl`, "error");
    expect("first pass ends partial", (await waitFor(() => finished(lost.id, 1), 15_000)) && runtime.getRunRecord(lost.id)!.run.status === "partial");
    expect("site audits passed on the fallback input", runtime.getRunRecord(lost.id)!.nodes.some((n) => n.templateId === "links" && n.state === "passed"));
    runtime.resumeRun(lost.id);
    expect("resumed run finishes", await waitFor(() => finished(lost.id, 2), 15_000));
    const lr = runtime.getRunRecord(lost.id)!;
    const links = lr.nodes.find((n) => n.templateId === "links")!;
    const linksInput = lr.attempts.filter((a) => a.nodeId === links.id).at(-1)?.input as { pages: string[] };
    expect("links reran on the crawled pages", !links.restored && links.state === "passed" && linksInput.pages.length > 1, JSON.stringify(linksInput?.pages));
    expect("fan-out happened", lr.nodes.some((n) => n.templateId === "a11y" && !n.placeholder) && !lr.nodes.some((n) => n.placeholder));
    expect("status completed", lr.run.status === "completed", lr.run.status);
    statsMatch(lr.run.stats, lr.nodes, lr.attempts);
    unsubscribe();
  }

  // ---------- 10. config sanitizing ----------
  {
    section = "config";
    const c = runtime.sanitizeConfig({
      baseline: "false" as unknown as boolean,
      chaos: { enabled: "yes" as unknown as boolean, rate: "abc" as unknown as number, weights: { error: -3, bogus: 9 } as unknown as RunConfig["chaos"]["weights"] },
      maxPages: "lots" as unknown as number,
      llmMode: "LIVE" as unknown as "live",
      evil: 1,
    } as unknown as RunConfig);
    expect("non-boolean baseline is false", c.baseline === false && c.recordStats === true);
    expect("NaN chaos rate does not become 'always fail'", Number.isFinite(c.chaos.rate) && c.chaos.rate >= 0 && c.chaos.rate <= 1);
    expect("weights limited to known faults, non-negative", !("bogus" in c.chaos.weights) && c.chaos.weights.error === 0);
    expect("unknown keys dropped", !("evil" in c));
    expect("llmMode only 'live' when exactly 'live'", c.llmMode === "mock");
    expect("maxPages falls back", c.maxPages >= 1 && c.maxPages <= 10);
    expect("null body handled", runtime.sanitizeConfig(null).client === "mock");
    const prevRate = runtime.getChaos().rate;
    const after = runtime.setChaos({ rate: "abc" as unknown as number });
    expect("setChaos ignores a non-numeric rate", after.rate === prevRate);
    runtime.setChaos({ enabled: false, rate: 0.15 });
  }

  // ---------- 11. time-lapse cancel ----------
  {
    section = "time-lapse";
    const s = timelapse.startTimelapse({ runs: 6, durationMs: 10_000, chaosRate: 0.1, seed: 11 });
    expect("first night finishes", await waitFor(() => s.ticks.length >= 1, 10_000));
    const t0 = Date.now();
    expect("cancel accepted", timelapse.cancelTimelapse());
    expect("stops promptly", await waitFor(() => !s.running, 1_500), `${Date.now() - t0} ms`);
    expect("stopped early", s.ticks.length < 6, String(s.ticks.length));
    expect("stored last tick is final", s.ticks[s.ticks.length - 1]?.done === true);
    const ticks = s.ticks.filter((k) => k.index > 0);
    expect("tally counts only finished nights", ticks.every((k) => k.with.runs === k.index && k.without.runs === k.index));

    const s2 = timelapse.startTimelapse({ runs: "abc" as unknown as number, chaosRate: Number.NaN, durationMs: 10_000 });
    expect("bad options fall back to defaults", s2.options.runs === 50 && s2.options.chaosRate === 0.1);
    timelapse.cancelTimelapse();
    expect("cancel before the first night still ends it", await waitFor(() => !s2.running, 1_500));
    expect("a final tick is stored", s2.ticks[s2.ticks.length - 1]?.done === true);
  }

  await server.close();

  section = "network";
  expect("no request left the machine", blocked.length === 0, blocked.join(","));

  const width = Math.max(...checks.map((c) => c.name.length));
  for (const c of checks) console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name.padEnd(width)}  ${c.pass ? "" : c.detail}`);
  const bad = checks.filter((c) => !c.pass);
  console.log(`\n${checks.length - bad.length}/${checks.length} checks passed`);
  process.exit(bad.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
