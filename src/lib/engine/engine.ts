// The DAG engine (spec 7.1–7.2): topological execution with fan-out, parallel branches,
// partial-tolerant merge, checkpoints, failover across agents found at run time, and
// hard + silent failure detection.
import { DEFAULTS, REAL_TIMING, WORKFLOW, type NodeTemplate } from "@/config/workflow";
import { isDemoSite, measureRecall } from "@/lib/audit/groundTruth";
import { TransportError, type DarwinClient, type TaskHandle, type TaskPoll } from "@/lib/darwin/types";
import { corruptWithHallucinatedPages } from "@/lib/engine/corrupt";
import { runFixPlan, runMerge, runPrioritize } from "@/lib/engine/builtins";
import { getDarwinClient } from "@/lib/engine/clients";
import { discover, fmtCents, orderRoute, type Discovery, type SearchFn } from "@/lib/engine/discovery";
import { recordAttemptOutcome, getStatsMap } from "@/lib/engine/stats";
import { isInterruptedAttempt, markInterrupted, stripNode, type RunStore } from "@/lib/engine/store";
import { adaptInput, type Handoff } from "@/lib/llm/adapter";
import type { RunLlmBudget } from "@/lib/llm/gateway";
import { pickWeighted, rngFor } from "@/lib/rng";
import type {
  AgentNodeInput,
  AgentRef,
  AgentStats,
  AttemptView,
  Capability,
  CrawlOutput,
  EngineEvent,
  FailureType,
  FaultMode,
  MergeOutput,
  NodeView,
  RoutedAgent,
  PrioritizedOutput,
  RunConfig,
  RunStats,
  RunStatus,
  RunSummary,
} from "@/lib/types";
import { translateOutput } from "@/lib/translate";
import { answerHijacks } from "@/lib/trust/signals";
import { recordIncident, type IncidentKind } from "@/lib/trust/store";
import { verifyOutput } from "@/lib/verify";

export interface EngineOptions {
  /** Client for the run's own agent kind; agents of other kinds get theirs from clientFor. */
  client: DarwinClient;
  /** Client for one agent (tests inject fakes). Defaults to one client per kind. */
  clientFor?: (agent: AgentRef) => DarwinClient;
  store: RunStore;
  publish: (e: EngineEvent) => void;
  /**
   * Node views saved by an earlier execution of this run (resume after a crash). Passed nodes are
   * restored with their outputs; the others keep their attempt numbering so no key is ever reused.
   */
  checkpoints?: Map<string, NodeView>;
  /** Attempts saved by the earlier execution, so the run's history and stats cover the whole run. */
  priorAttempts?: AttemptView[];
  /** Agent search per source (tests inject fakes). Defaults to Darwin Search and the simulated catalog. */
  search?: SearchFn;
}

/** Pause between a failure and the backup starting, so the swap is visible (scaled). */
const SWAP_PAUSE_MS = 700;
/** Extra time a manually "timed out" attempt is given before the engine declares it dead. */
const MANUAL_TIMEOUT_MS = 3_000;
/** How long a stopping run waits for a provider to acknowledge a task cancel (real time). */
const CANCEL_WAIT_MS = 2_000;

/** "failed": an unexpected engine error stopped the remaining branches. */
type StopReason = "crashed" | "cancelled" | "failed";

class RunAborted extends Error {
  constructor(readonly reason: StopReason) {
    super(`run ${reason}`);
  }
}

interface ActiveAttempt {
  attempt: AttemptView;
  kill: AbortController;
  /** Manual "timeout": progress is ignored and the attempt dies at hangDeadline. */
  hangDeadline?: number;
  corrupt?: boolean;
  /** The provider accepted the task (a paid agent is charged from here). */
  started?: boolean;
}

type AttemptResult =
  | { ok: true; output: unknown; raw: unknown; corrupted: boolean }
  | { ok: false; failureType: FailureType; detail: string };

export class RunEngine {
  readonly run: RunSummary;
  readonly nodes = new Map<string, NodeView>();
  readonly attempts: AttemptView[] = [];
  private readonly abort = new AbortController();
  private abortReason: StopReason | null = null;
  private readonly manualFaults = new Map<string, FaultMode[]>();
  /** Faults armed on a fan-out placeholder: the first page instance to start an attempt takes them. */
  private readonly templateFaults = new Map<string, FaultMode[]>();
  /** Why the last injectFault call was refused, in plain words for the UI. */
  lastFaultRefusal = "";
  private readonly active = new Map<string, ActiveAttempt>();
  private readonly llmBudget?: RunLlmBudget;
  private crawlPages: string[] = [];
  private oracleCorruptAccepted = false;
  /** Spent on paid agents this run, in cents (reserved when an attempt starts, refunded if its task never did). */
  private spentCents = 0;
  /** One search per step template per run, shared by its page instances. */
  private readonly discoveries = new Map<string, Promise<Discovery>>();
  private readonly slots: Semaphore;
  private readonly startedAt = Date.now();

  constructor(
    run: RunSummary,
    private readonly opts: EngineOptions,
  ) {
    this.run = run;
    this.slots = new Semaphore(Math.max(1, run.config.concurrency));
    for (const a of opts.priorAttempts ?? []) {
      this.attempts.push({ ...a });
      this.spentCents += a.costCents ?? 0;
    }
    if (run.config.llmMode === "live") this.llmBudget = { limit: DEFAULTS.llmCallsPerRun, used: 0 };
  }

  get config(): RunConfig {
    return this.run.config;
  }

  // ---------- external controls ----------

  setChaos(chaos: RunConfig["chaos"]): void {
    this.run.config.chaos = chaos;
  }

  /** Manual fault button. Applies to the running attempt, or the node's next attempt. */
  injectFault(nodeId: string, fault: FaultMode): boolean {
    const node = this.nodes.get(nodeId);
    const refuse = (why: string) => {
      this.lastFaultRefusal = why;
      return false;
    };
    if (this.abortReason) return refuse("The run is stopping.");
    if (!node || node.kind !== "agent") return refuse("Only agent steps can be broken.");
    if (isTerminal(node.state)) return refuse("That step already finished.");
    if (node.state === "verifying") return refuse("Too late: that step's output is already being checked.");
    if (node.placeholder) {
      // The per-page steps don't exist until the crawl finishes; arm the fault for the first one to start.
      const q = this.templateFaults.get(node.templateId) ?? [];
      q.push(fault);
      this.templateFaults.set(node.templateId, q);
      this.alert("warn", `Armed ${faultLabel(fault)} for the first ${node.label.replace(" · each page", "")} step`, nodeId);
      return true;
    }
    const act = this.active.get(nodeId);
    if (act && act.attempt.outcome === "running") {
      act.attempt.injectedFault = fault;
      if (fault === "error") act.kill.abort();
      else if (fault === "timeout" || fault === "stall") act.hangDeadline = Date.now() + this.scaled(MANUAL_TIMEOUT_MS);
      else if (fault === "corrupt") act.corrupt = true;
      else if (fault === "auth_block") act.kill.abort();
      this.alert("warn", `Injected ${faultLabel(fault)} into ${node.label}`, nodeId);
      this.emitAttempt(act.attempt);
      return true;
    }
    const q = this.manualFaults.get(nodeId) ?? [];
    q.push(fault);
    this.manualFaults.set(nodeId, q);
    this.alert("warn", `Queued ${faultLabel(fault)} for ${node.label}'s next attempt`, nodeId);
    return true;
  }

  crash(): void {
    this.stop("crashed");
  }

  cancel(): void {
    this.stop("cancelled");
  }

  private stop(reason: StopReason): void {
    if (this.abortReason) return;
    this.abortReason = reason;
    this.abort.abort();
    for (const a of this.active.values()) a.kill.abort();
  }

  // ---------- main ----------

  async execute(): Promise<RunSummary> {
    const { store } = this.opts;
    if (!this.opts.checkpoints) store.createRun(this.run);
    else store.updateRun(this.run);
    this.emit({ type: "run_started", run: this.run });

    try {
      await this.schedule();
      this.finish(this.computeStatus());
    } catch (err) {
      if (this.abortReason === "crashed" || this.abortReason === "cancelled") {
        this.finish(this.abortReason);
      } else {
        this.alert("error", `Engine error: ${(err as Error).message}`);
        this.finish("failed");
      }
    }
    return this.run;
  }

  private async schedule(): Promise<void> {
    const pending = new Set(WORKFLOW.map((t) => t.id));
    const running = new Map<string, Promise<void>>();

    // Seed the graph so the UI shows the whole workflow before anything runs.
    for (const t of WORKFLOW) {
      if (t.scope === "page") this.addPlaceholder(t);
      else this.addNode(t, this.nodeIdFor(t));
    }

    try {
      while (pending.size || running.size) {
        this.throwIfAborted();
        for (const id of [...pending]) {
          const t = WORKFLOW.find((w) => w.id === id)!;
          if (!t.dependsOn.every((d) => this.templateSettled(d, pending, running))) continue;
          pending.delete(id);
          running.set(
            id,
            this.runTemplate(t).finally(() => running.delete(id)),
          );
        }
        if (running.size) await Promise.race(running.values());
        else if (pending.size) throw new Error(`Deadlock: ${[...pending].join(", ")} can never run`);
      }
    } catch (err) {
      // No branch may outlive the run: stop the others and wait until they have all let go.
      if (!this.abortReason) this.stop("failed");
      await Promise.allSettled([...running.values()]);
      throw err;
    }
  }

  private templateSettled(id: string, pending: Set<string>, running: Map<string, Promise<void>>): boolean {
    return !pending.has(id) && !running.has(id);
  }

  private async runTemplate(t: NodeTemplate): Promise<void> {
    if (t.kind === "builtin") return this.runBuiltin(t);
    if (t.scope === "page") {
      const pages = this.crawlPages;
      const placeholderId = this.placeholderId(t);
      const placeholder = this.nodes.get(placeholderId);
      if (!pages.length) {
        if (placeholder) this.update(placeholder, { state: "failed", error: "No pages: the crawl branch failed" });
        return;
      }
      if (placeholder) {
        this.nodes.delete(placeholderId);
        this.opts.store.deleteNode(placeholderId);
        this.emit({ type: "node_removed", runId: this.run.id, nodeId: placeholderId });
      }
      const instances = pages.map((page, idx) => this.addNode(t, this.nodeIdFor(t, idx), page));
      // allSettled: when one instance is aborted, the template must not settle before its siblings have.
      const results = await Promise.allSettled(instances.map((n) => this.runAgentNode(t, n)));
      const rejected = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
      if (rejected) throw rejected.reason;
      return;
    }
    const node = this.nodes.get(this.nodeIdFor(t))!;
    const output = await this.runAgentNode(t, node);
    if (t.id === "crawl" && output) {
      this.crawlPages = (output as CrawlOutput).pages.map((p) => p.url);
    }
  }

  // ---------- node bookkeeping ----------

  private nodeIdFor(t: NodeTemplate, idx?: number): string {
    return idx === undefined ? `${this.run.id}:${t.id}` : `${this.run.id}:${t.id}:${idx}`;
  }
  private placeholderId(t: NodeTemplate): string {
    return `${this.run.id}:${t.id}:*`;
  }

  private addPlaceholder(t: NodeTemplate): void {
    const node: NodeView = {
      id: this.placeholderId(t),
      runId: this.run.id,
      templateId: t.id,
      label: `${t.label} · each page`,
      kind: "agent",
      capability: t.capability,
      dependsOn: t.dependsOn.map((d) => this.depIds(d)).flat(),
      state: "idle",
      attemptCount: 0,
      swaps: 0,
      placeholder: true,
    };
    this.nodes.set(node.id, node);
    this.emit({ type: "node_added", runId: this.run.id, node });
  }

  private depIds(templateId: string): string[] {
    const dep = WORKFLOW.find((w) => w.id === templateId)!;
    if (dep.scope !== "page") return [this.nodeIdFor(dep)];
    const instances = [...this.nodes.values()].filter((n) => n.templateId === templateId);
    return instances.length ? instances.map((n) => n.id) : [this.placeholderId(dep)];
  }

  private addNode(t: NodeTemplate, id: string, page?: string): NodeView {
    const restored = this.opts.checkpoints?.get(id);
    const node: NodeView = {
      id,
      runId: this.run.id,
      templateId: t.id,
      label: page ? `${t.label} · ${pagePath(page)}` : t.label,
      kind: t.kind,
      capability: t.capability,
      builtin: t.builtin,
      itemKey: page,
      dependsOn: t.dependsOn.map((d) => this.depIds(d)).flat(),
      state: "idle",
      attemptCount: 0,
      swaps: 0,
    };
    if (restored && restored.state === "passed") {
      Object.assign(node, {
        state: "passed",
        restored: true,
        output: restored.output,
        currentAgent: restored.currentAgent,
        attemptCount: restored.attemptCount,
        swaps: restored.swaps,
        startedAt: restored.startedAt,
        finishedAt: restored.finishedAt,
      });
    } else if (restored && t.kind === "agent") {
      // Re-run, but continue the attempt numbering: attempt ids and idempotency keys must not repeat.
      node.attemptCount = restored.attemptCount ?? 0;
      node.swaps = restored.swaps ?? 0;
    }
    this.nodes.set(id, node);
    // Downstream nodes created earlier point at placeholders; refresh their edges.
    if (page) this.refreshDependents(t.id);
    this.opts.store.upsertNode(node);
    this.emit({ type: "node_added", runId: this.run.id, node: stripNode(node) });
    return node;
  }

  private refreshDependents(templateId: string): void {
    for (const n of this.nodes.values()) {
      const t = WORKFLOW.find((w) => w.id === n.templateId);
      if (!t?.dependsOn.includes(templateId)) continue;
      n.dependsOn = t.dependsOn.map((d) => this.depIds(d)).flat();
      this.opts.store.upsertNode(n);
      this.emit({ type: "node_updated", runId: this.run.id, node: stripNode(n) });
    }
  }

  private update(node: NodeView, patch: Partial<NodeView>): void {
    Object.assign(node, patch);
    this.opts.store.upsertNode(node);
    this.emit({ type: "node_updated", runId: this.run.id, node: stripNode(node) });
  }

  // ---------- agent nodes ----------

  private async runAgentNode(t: NodeTemplate, node: NodeView): Promise<unknown> {
    if (this.keepCheckpoint(t, node)) {
      this.alert("info", `${node.label} restored from checkpoint`, node.id);
      return node.output;
    }
    const capability = t.capability as Capability;
    // No agents are picked ahead of time: search for this step now, vet what comes back, and order it.
    let found: Discovery;
    try {
      found = await this.abortable(this.discoverFor(t));
    } catch (err) {
      if (err instanceof RunAborted) throw err;
      this.update(node, { state: "failed", error: `Couldn't search for agents: ${(err as Error).message}` });
      this.alert("error", `${node.label}: couldn't search for agents`, node.id);
      return null;
    }
    this.throwIfAborted();
    // Exploration is seeded per run and step, so a replay with the same seed routes the same way.
    const explore = this.config.baseline ? undefined : rngFor(this.config.seed, "explore", node.id.slice(this.run.id.length + 1));
    const stats = this.config.recordStats ? getStatsMap() : new Map<string, AgentStats>();
    const route = orderRoute(found, capability, stats, explore, this.config.baseline);
    this.update(node, { route: route.plan });
    if (route.explored) {
      this.alert("info", `${node.label}: ${route.explored.name} is tried second this time (still being evaluated)`, node.id);
    }
    const reasons = new Map(route.plan.agents.map((c) => [c.agent.agentId, c.reason]));
    const candidates = route.agents;
    if (!candidates.length) {
      this.update(node, { state: "failed", error: "No agent found for this step can run unattended" });
      this.alert("error", `${node.label}: no agent found can run this step unattended`, node.id);
      return null;
    }

    this.update(node, { state: "queued", startedAt: Date.now() });
    const release = await this.slots.acquire(this.abort.signal);
    try {
      let previous: RoutedAgent | null = null;
      let lastFailure = "";
      let tried = 0;
      // Each backup is told what the agents before it got wrong.
      const failed: { name: string; reason: string }[] = [];
      for (const agent of candidates) {
        this.throwIfAborted();
        // Paid agents run only while the run's spending limit covers their price.
        const reserved = this.reserve(agent);
        if (reserved === null) {
          this.alert("info", `${node.label}: skipping ${agent.name}, its price would go over the run's ${fmtCents(this.config.budgetCents)} limit`, node.id);
          continue;
        }
        tried++;
        if (previous) {
          this.update(node, { state: "swapping", swaps: node.swaps + 1 });
          this.emit({ type: "swap", runId: this.run.id, nodeId: node.id, from: toRef(previous), to: toRef(agent), reason: lastFailure });
          await this.sleep(SWAP_PAUSE_MS);
          this.throwIfAborted();
        }
        const result = await this.runAttempt(t, node, agent, {
          routeReason: reasons.get(agent.agentId),
          handoff: failed.length ? { failed: [...failed] } : undefined,
          reservedCents: reserved,
        });
        if (result.ok) {
          // Oracle only (never read by verification): a corrupted output got through, with or without Axolotl.
          if (result.corrupted) this.oracleCorruptAccepted = true;
          this.update(node, { state: "passed", output: result.output, finishedAt: Date.now() });
          return result.output;
        }
        lastFailure = result.detail;
        failed.push({ name: agent.name, reason: result.detail });
        previous = agent;
      }
      const error = tried ? `All ${tried} agents failed. Last: ${lastFailure}` : "Every agent found was over the run's spending limit";
      this.update(node, { state: "failed", finishedAt: Date.now(), error });
      this.alert(
        "error",
        this.config.baseline
          ? `${node.label} failed: ${lastFailure}`
          : `${node.label}: every agent found for this step failed — branch stopped, run continues as partial`,
        node.id,
      );
      return null;
    } finally {
      release();
    }
  }

  /** Search for a step's agents once per run; alerts say what was found and what was left out. */
  private discoverFor(t: NodeTemplate): Promise<Discovery> {
    let p = this.discoveries.get(t.id);
    if (p) return p;
    p = discover({
      template: t,
      client: this.config.client,
      simulatedBackups: this.config.simulatedBackups,
      budgetCents: this.config.budgetCents,
      stats: this.config.recordStats ? getStatsMap() : new Map<string, AgentStats>(),
      useHistory: this.config.recordStats && !this.config.baseline,
      pinReal: this.config.realAgents === true && !this.config.baseline,
      search: this.opts.search,
    }).then((d) => {
      if (!this.config.baseline) {
        const nodeId = this.templateNodeId(t);
        for (const n of d.notes) this.alert("warn", `${t.label}: ${n}`, nodeId);
        const usable = d.vetted.length;
        this.alert("info", `${t.label}: found ${usable} agent${usable === 1 ? "" : "s"} that can run unattended${d.skipped.length ? `, left out ${d.skipped.length}` : ""}`, nodeId);
        for (const s of d.skipped) this.alert("info", `${t.label}: left out ${s.agent.name} — ${s.reason}`, nodeId);
        if (this.config.client === "darwin" && usable && d.vetted.every((v) => v.tier === "simulated")) {
          this.alert("warn", `${t.label}: no real agent from Darwin can run this step — using simulated agents`, nodeId);
        }
      }
      return d;
    });
    // A failed search isn't cached, so the next instance of the step searches again.
    p.catch(() => this.discoveries.delete(t.id));
    this.discoveries.set(t.id, p);
    return p;
  }

  private templateNodeId(t: NodeTemplate): string | undefined {
    if (t.scope !== "page") return this.nodeIdFor(t);
    return this.nodes.has(this.placeholderId(t)) ? this.placeholderId(t) : undefined;
  }

  private async runAttempt(
    t: NodeTemplate,
    node: NodeView,
    agent: RoutedAgent,
    route: { routeReason?: string; handoff?: Handoff; reservedCents?: number } = {},
  ): Promise<AttemptResult> {
    const attemptNo = node.attemptCount + 1;
    const input = this.inputFor(t, node);
    // One key per attempt (node ids embed the run id); only a transport retry of this same request reuses it.
    const idempotencyKey = `axl:${node.id}:${attemptNo}`;
    const manual = this.takeManualFault(node.id);
    const fault = manual ?? this.rollChaos(node.id, agent.agentId, attemptNo);

    const attempt: AttemptView = {
      id: `${node.id}#${attemptNo}`,
      runId: this.run.id,
      nodeId: node.id,
      attemptNo,
      agent: toRef(agent),
      idempotencyKey,
      transportRetries: 0,
      instruction: "",
      input,
      rawOutput: null,
      outcome: "running",
      injectedFault: fault,
      faultSource: fault ? (manual ? "manual" : "chaos") : undefined,
      routeReason: route.routeReason,
      ...(route.reservedCents ? { costCents: route.reservedCents } : {}),
      startedAt: Date.now(),
    };
    this.attempts.push(attempt);
    this.update(node, { state: "running", currentAgent: toRef(agent), attemptCount: attemptNo });

    const act: ActiveAttempt = { attempt, kill: new AbortController() };
    this.active.set(node.id, act);
    try {
      const adapted = await this.abortable(
        adaptInput({ agent, template: t, input, llmMode: this.config.llmMode, budget: this.llmBudget, handoff: route.handoff }),
      );
      attempt.instruction = adapted.instruction;
      this.emitAttempt(attempt);

      // The mock simulates chaos faults itself. A manual "corrupt" is always applied by the engine
      // (deterministic demo failure: issues on pages that don't exist), and real Darwin agents
      // get every fault emulated here.
      const client = this.clientFor(agent);
      const real = client.kind !== "mock";
      if (fault === "corrupt" && (real || manual === "corrupt")) act.corrupt = true;
      const emulate = real ? fault : undefined;
      // A hang pressed by hand gets the short deadline whether it was queued or hit a running attempt.
      if (emulate === "timeout" || emulate === "stall" || manual === "timeout" || manual === "stall") {
        act.hangDeadline = Date.now() + this.scaled(MANUAL_TIMEOUT_MS);
      }
      const clientFault = !real && !act.corrupt ? fault : undefined;

      const res = await this.drive(client, t, node, agent, attempt, act, adapted, clientFault, emulate);
      this.throwIfAborted();
      if (!res.ok) {
        // An agent that stops an unattended run for money or a sign-in counts against its trust score.
        if (res.failureType === "payment_block") this.recordIncident(t, agent, attempt, "payment", res.detail);
        else if (res.failureType === "auth_block") this.recordIncident(t, agent, attempt, "sign_in", res.detail);
        return this.failAttempt(t, node, agent, attempt, res.failureType, res.detail);
      }
      if (real && answerHijacks(res.raw)) {
        this.recordIncident(t, agent, attempt, "hijack", "Answer tried to override the caller's instructions");
        return this.failAttempt(t, node, agent, attempt, "verification", "The answer tried to override Axolotl's instructions, so it was discarded", true);
      }

      let output = res.output;
      if (real) {
        // Real agents answer in their own format; read it into the step's contract before checking it.
        const translated = await this.abortable(
          translateOutput(output, { template: t, input, llmMode: this.config.llmMode, llmBudget: this.llmBudget }),
        );
        attempt.translation = translated.note;
        output = translated.output;
      }
      let corrupted = res.corrupted;
      if (act.corrupt) {
        output = corruptWithHallucinatedPages(output, this.config.siteUrl, t.category);
        corrupted = true;
      }
      attempt.rawOutput = output;

      if (this.config.baseline) {
        // Without Axolotl: whatever comes back is accepted.
        attempt.outcome = "passed";
        attempt.latencyMs = Date.now() - attempt.startedAt;
        attempt.finishedAt = Date.now();
        this.persistAttempt(attempt);
        return { ok: true, output, raw: res.raw, corrupted };
      }

      attempt.outcome = "verifying";
      this.update(node, { state: "verifying" });
      this.emitAttempt(attempt);
      const verification = await this.abortable(
        verifyOutput({
          template: t,
          input,
          output,
          siteUrl: this.config.siteUrl,
          crawledPages: t.id === "crawl" ? [] : this.crawlPages,
          seed: this.config.seed + attemptNo,
          llmMode: this.config.llmMode,
          llmBudget: this.llmBudget,
        }),
      );
      attempt.verification = verification;
      attempt.latencyMs = Date.now() - attempt.startedAt;
      attempt.finishedAt = Date.now();
      if (!verification.pass) {
        const failed = verification.layers.find((l) => !l.pass && !l.skipped);
        const detail = failed ? `Layer ${failed.layer} (${failed.name}): ${failed.reason}` : "verification failed";
        return this.failAttempt(t, node, agent, attempt, "verification", detail, true);
      }
      attempt.outcome = "passed";
      this.persistAttempt(attempt);
      this.recordStats(t, agent, true, undefined, attempt.latencyMs, successNote(output, verification.layers.filter((l) => !l.skipped).length));
      return { ok: true, output, raw: res.raw, corrupted };
    } catch (err) {
      // Aborted attempts are closed by finish(); an attempt that already has a verdict is never judged twice.
      if (err instanceof RunAborted || (attempt.outcome !== "running" && attempt.outcome !== "verifying")) throw err;
      return this.failAttempt(t, node, agent, attempt, "error", `Attempt crashed: ${(err as Error).message}`);
    } finally {
      this.active.delete(node.id);
      // A paid agent is only charged for a task that actually started.
      if (!act.started && attempt.costCents) {
        this.spentCents -= attempt.costCents;
        delete attempt.costCents;
        this.persistAttempt(attempt);
      }
    }
  }

  /** Reserve a paid agent's price against the run's limit: cents reserved (0 for free agents), or null when it doesn't fit. */
  private reserve(agent: RoutedAgent): number | null {
    if (!agent.paid || this.config.baseline) return 0;
    const price = agent.priceCents ?? 0;
    if (this.spentCents + price > this.config.budgetCents) return null;
    this.spentCents += price;
    return price;
  }

  /** Start the task and poll it to completion, applying timeout and stall detection. */
  private async drive(
    client: DarwinClient,
    t: NodeTemplate,
    node: NodeView,
    agent: RoutedAgent,
    attempt: AttemptView,
    act: ActiveAttempt,
    adapted: { instruction: string; arguments?: Record<string, unknown> },
    clientFault: FaultMode | undefined,
    emulated: FaultMode | undefined,
  ): Promise<AttemptResult> {
    const context = {
      runId: this.run.id,
      // Run-independent id, so the same seed replays the same agent behavior across runs.
      nodeInstanceId: node.id.slice(this.run.id.length + 1),
      capability: t.capability as Capability,
      input: attempt.input as AgentNodeInput,
      seed: this.config.seed,
      attemptNo: attempt.attemptNo,
      timeScale: this.config.timeScale,
      forcedFault: clientFault,
      knownPages: this.crawlPages,
    };
    if (emulated === "error") return { ok: false, failureType: "error", detail: "Injected agent error (HTTP 500 from provider)" };
    if (emulated === "auth_block")
      return { ok: false, failureType: "auth_block", detail: "Agent requested authentication during an unattended run" };
    // Killed by a manual fault before the task was even created: don't start one.
    if (act.kill.signal.aborted) return killedResult(act);

    let handle: TaskHandle;
    try {
      handle = await this.abortable(
        this.withTransportRetry(attempt, () =>
          client.startTask({
            agent,
            instruction: adapted.instruction,
            arguments: adapted.arguments,
            idempotencyKey: attempt.idempotencyKey,
            searchId: agent.searchId,
            context,
          }),
        ),
        // The run stopped while the task was being created: cancel it once it exists.
        (late) => void this.cancelQuietly(client, late),
      );
    } catch (err) {
      if (err instanceof RunAborted) throw err;
      const transport = err instanceof TransportError;
      return { ok: false, failureType: transport ? "transport" : "error", detail: (err as Error).message };
    }

    act.started = true;
    const started = Date.now();
    // Real and direct agents run on the clock; simulated ones on the run's time scale.
    const real = client.kind !== "mock";
    const timing = real ? REAL_TIMING : DEFAULTS;
    const timeoutMs = real ? timing.attemptTimeoutMs : this.scaled(timing.attemptTimeoutMs);
    const stallMs = real ? timing.stallMs : this.scaled(timing.stallMs);
    const pollMs = real ? timing.pollIntervalMs / Math.max(0.01, this.config.timeScale) : timing.pollIntervalMs;
    let lastCursor: string | undefined;
    let lastProgress = started;
    const cancel = () => this.cancelQuietly(client, handle);

    while (true) {
      if (this.abortReason) {
        await cancel();
        throw new RunAborted(this.abortReason);
      }
      if (act.kill.signal.aborted) {
        await cancel();
        return killedResult(act);
      }
      const now = Date.now();
      if (act.hangDeadline && now >= act.hangDeadline) {
        await cancel();
        return act.attempt.injectedFault === "stall"
          ? { ok: false, failureType: "stall", detail: `Thread stalled: no cursor progress for ${fmtMs(now - lastProgress)}` }
          : { ok: false, failureType: "timeout", detail: `No response for ${fmtMs(now - lastProgress)} — attempt timed out` };
      }
      if (now - started > timeoutMs) {
        await cancel();
        return { ok: false, failureType: "timeout", detail: `Exceeded ${fmtMs(timeoutMs)} attempt timeout` };
      }
      if (now - lastProgress > stallMs) {
        await cancel();
        return { ok: false, failureType: "stall", detail: `Thread stalled: no cursor progress for ${fmtMs(now - lastProgress)}` };
      }

      let poll: TaskPoll;
      try {
        poll = await this.abortable(this.withTransportRetry(attempt, () => client.pollTask(handle, lastCursor)));
      } catch (err) {
        await cancel();
        if (err instanceof RunAborted) throw err;
        return { ok: false, failureType: err instanceof TransportError ? "transport" : "error", detail: (err as Error).message };
      }

      if (!act.hangDeadline) {
        if (poll.status === "running") {
          if (poll.cursor !== lastCursor) {
            lastCursor = poll.cursor;
            lastProgress = Date.now();
          }
        } else if (poll.status === "completed") {
          return { ok: true, output: poll.output, raw: poll.raw, corrupted: Boolean(poll.oracle?.corrupted) };
        } else if (poll.status === "error") {
          return { ok: false, failureType: "error", detail: `${poll.code}: ${poll.message}` };
        } else if (poll.status === "blocked") {
          await cancel();
          return {
            ok: false,
            failureType: poll.kind === "payment" ? "payment_block" : "auth_block",
            detail: `Unattended run blocked: ${poll.message}`,
          };
        }
      }
      await this.sleep(pollMs, act.kill.signal);
    }
  }

  /** Retry a transport failure exactly once with the same idempotency key. */
  private async withTransportRetry<T>(attempt: AttemptView, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof TransportError)) throw err;
      this.throwIfAborted();
      attempt.transportRetries++;
      this.emitAttempt(attempt);
      await this.sleep(250);
      this.throwIfAborted();
      return fn();
    }
  }

  private failAttempt(
    t: NodeTemplate,
    node: NodeView,
    agent: RoutedAgent,
    attempt: AttemptView,
    failureType: FailureType,
    detail: string,
    silent = false,
  ): AttemptResult {
    attempt.outcome = silent ? "silent_failure" : "hard_failure";
    attempt.failureType = failureType;
    attempt.failureDetail = detail;
    attempt.finishedAt = Date.now();
    attempt.latencyMs = attempt.finishedAt - attempt.startedAt;
    this.persistAttempt(attempt);
    this.recordStats(t, agent, false, failureType, attempt.latencyMs, detail);
    this.update(node, { state: "failed" });
    this.alert(silent ? "warn" : "error", `${node.label}: ${agent.name} ${silent ? "returned bad output" : "failed"} — ${detail}`, node.id);
    return { ok: false, failureType, detail };
  }

  private recordStats(t: NodeTemplate, agent: AgentRef, success: boolean, failureType: FailureType | undefined, latencyMs: number, note?: string): void {
    if (!this.config.recordStats || this.config.baseline) return;
    recordAttemptOutcome({ agent, capability: t.capability as Capability, success, failureType, note, latencyMs });
    this.emit({ type: "stats_updated", at: Date.now() });
  }

  /** Faults Axolotl injected itself (chaos, buttons) are not the agent's doing, so they never count. */
  private recordIncident(t: NodeTemplate, agent: AgentRef, attempt: AttemptView, kind: IncidentKind, detail: string): void {
    if (!this.config.recordStats || this.config.baseline || attempt.injectedFault) return;
    recordIncident(agent.agentId, t.capability as Capability, kind, detail, this.run.id);
  }

  private inputFor(t: NodeTemplate, node: NodeView): AgentNodeInput {
    const siteUrl = this.config.siteUrl;
    if (t.id === "crawl") return { siteUrl, maxPages: this.config.maxPages };
    if (t.scope === "page") return { siteUrl, pageUrl: node.itemKey! };
    return { siteUrl, pages: this.crawlPages.length ? this.crawlPages : [siteUrl] };
  }

  private takeManualFault(nodeId: string): FaultMode | undefined {
    const own = this.manualFaults.get(nodeId)?.shift();
    if (own) return own;
    const templateId = this.nodes.get(nodeId)?.templateId;
    return templateId ? this.templateFaults.get(templateId)?.shift() : undefined;
  }

  private rollChaos(nodeId: string, agentId: string, attemptNo: number): FaultMode | undefined {
    const chaos = this.config.chaos;
    if (!chaos.enabled || chaos.rate <= 0) return undefined;
    const rand = rngFor(this.config.seed, "chaos", nodeId.replace(this.run.id, ""), agentId, attemptNo);
    if (rand() >= chaos.rate) return undefined;
    return pickWeighted(rand, chaos.weights);
  }

  // ---------- built-in nodes ----------

  private async runBuiltin(t: NodeTemplate): Promise<void> {
    const node = this.nodes.get(this.nodeIdFor(t))!;
    if (this.keepCheckpoint(t, node)) return;
    this.update(node, { state: "running", startedAt: Date.now(), currentAgent: AXOLOTL_AGENT, attemptCount: 1 });
    await this.sleep(400);
    this.throwIfAborted();
    let output: unknown;
    let partial = false;
    if (t.builtin === "merge") {
      const audits = [...this.nodes.values()].filter(
        (n) => n.kind === "agent" && n.templateId !== "crawl" && !n.placeholder,
      );
      const placeholders = [...this.nodes.values()].filter((n) => n.placeholder && n.state === "failed");
      const merged = runMerge([...audits, ...placeholders]);
      partial = merged.partialBranches.length > 0;
      output = merged;
    } else if (t.builtin === "prioritize") {
      const merge = this.nodeOutput<MergeOutput>("merge");
      output = runPrioritize(merge ?? { issues: [], partialBranches: [], coverage: [] });
    } else {
      const merge = this.nodeOutput<MergeOutput>("merge");
      const prioritized = this.nodeOutput<PrioritizedOutput>("prioritize") ?? { issues: [], dedupedFrom: 0 };
      output = await this.abortable(
        runFixPlan({
          prioritized,
          siteUrl: this.config.siteUrl,
          partialBranches: merge?.partialBranches ?? [],
          llmMode: this.config.llmMode,
          budget: this.llmBudget,
        }),
      );
    }
    this.update(node, { state: partial ? "partial" : "passed", output, finishedAt: Date.now() });
  }

  /**
   * A checkpoint is only valid if everything upstream was restored too: when a dependency ran again
   * (a lost branch recovered on resume, or a crawl that failed before), the saved output is stale.
   */
  private keepCheckpoint(t: NodeTemplate, node: NodeView): boolean {
    if (!(node.state === "passed" && node.restored)) return false;
    const upstreamRestored = t.dependsOn.every((d) => {
      const deps = [...this.nodes.values()].filter((n) => n.templateId === d);
      return deps.length > 0 && deps.every((n) => !n.placeholder && n.restored === true);
    });
    if (upstreamRestored) return true;
    this.update(node, { state: "idle", restored: false, output: undefined, finishedAt: undefined });
    return false;
  }

  private nodeOutput<T>(templateId: string): T | undefined {
    return this.nodes.get(`${this.run.id}:${templateId}`)?.output as T | undefined;
  }

  // ---------- finish ----------

  private computeStatus(): RunStatus {
    const nodes = [...this.nodes.values()];
    if (nodes.some((n) => n.state === "failed" || n.state === "partial")) {
      const fixplan = this.nodes.get(`${this.run.id}:fixplan`);
      return fixplan && (fixplan.state === "passed" || fixplan.state === "partial") ? "partial" : "failed";
    }
    return "completed";
  }

  private finish(status: RunStatus): void {
    if (this.abortReason) this.closeInFlight(status);
    this.run.status = status;
    this.run.finishedAt = Date.now();
    this.run.stats = this.computeStats();
    this.opts.store.updateRun(this.run);
    this.emit({ type: "run_finished", run: this.run });
  }

  /** Every branch has let go by now: close what was in flight so nothing is left "running". */
  private closeInFlight(status: RunStatus): void {
    const now = Date.now();
    for (const a of this.attempts) {
      if (a.outcome !== "running" && a.outcome !== "verifying") continue;
      markInterrupted(a, status, now);
      this.persistAttempt(a);
    }
    for (const n of this.nodes.values()) {
      if (!isTerminal(n.state)) this.update(n, { state: "cancelled", finishedAt: now });
    }
  }

  computeStats(): RunStats {
    const all = [...this.nodes.values()];
    const nodes = all.filter((n) => !n.placeholder);
    const agentNodes = nodes.filter((n) => n.kind === "agent");
    // Attempts cut off by a crash or cancel are not agent failures.
    const judged = this.attempts.filter((a) => !isInterruptedAttempt(a));
    const hard = judged.filter((a) => a.outcome === "hard_failure").length;
    const silent = judged.filter((a) => a.outcome === "silent_failure").length;
    const hadFailure = new Set(judged.filter((a) => a.outcome === "hard_failure" || a.outcome === "silent_failure").map((a) => a.nodeId));
    const recoveries = agentNodes.filter((n) => n.state === "passed" && hadFailure.has(n.id)).length;
    // A fan-out template whose crawl never produced pages is a lost branch too (its placeholder failed).
    const failedBranches =
      agentNodes.filter((n) => n.state === "failed").length + all.filter((n) => n.placeholder && n.state === "failed").length;
    const prioritized = this.nodeOutput<PrioritizedOutput>("prioritize");
    const stats: RunStats = {
      nodes: nodes.length,
      passed: nodes.filter((n) => n.state === "passed").length,
      failedBranches,
      attempts: this.attempts.length,
      recoveries,
      hardFailures: hard,
      silentFailures: silent,
      // Someone has to step in when a branch was lost or a corrupted result was accepted, with or without Axolotl.
      humanInterventions: failedBranches > 0 || this.oracleCorruptAccepted ? 1 : 0,
      issuesFound: prioritized?.issues.length ?? 0,
      durationMs: Date.now() - this.startedAt,
      acceptedCorruptOutput: this.oracleCorruptAccepted,
      spentCents: this.spentCents,
    };
    if (prioritized && isDemoSite(this.config.siteUrl)) {
      stats.recall = measureRecall(this.config.siteUrl, prioritized.issues).ratio;
    }
    return stats;
  }

  // ---------- plumbing ----------

  private scaled(ms: number): number {
    return Math.max(1, ms * this.config.timeScale);
  }

  private sleep(ms: number, extra?: AbortSignal): Promise<void> {
    const d = this.scaled(ms);
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.abort.signal.removeEventListener("abort", done);
        extra?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, d);
      this.abort.signal.addEventListener("abort", done, { once: true });
      extra?.addEventListener("abort", done, { once: true });
    });
  }

  private throwIfAborted(): void {
    if (this.abortReason) throw new RunAborted(this.abortReason);
  }

  /** Rejects with RunAborted as soon as the run stops; `onLate` gets the value if it arrives afterwards. */
  private abortable<T>(p: Promise<T>, onLate?: (value: T) => void): Promise<T> {
    const late = () => void p.then((v) => onLate?.(v), () => undefined);
    if (this.abortReason) {
      late();
      return Promise.reject(new RunAborted(this.abortReason));
    }
    return new Promise<T>((resolve, reject) => {
      const signal = this.abort.signal;
      const onAbort = () => {
        late();
        reject(new RunAborted(this.abortReason ?? "cancelled"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      p.then(
        (v) => {
          signal.removeEventListener("abort", onAbort);
          resolve(v);
        },
        (e: unknown) => {
          signal.removeEventListener("abort", onAbort);
          reject(e);
        },
      );
    });
  }

  /** Best-effort cancel that never blocks a stopping run for long. */
  private clientFor(agent: AgentRef): DarwinClient {
    if (this.opts.clientFor) return this.opts.clientFor(agent);
    const kind = agent.source === "direct" ? "mcp" : agent.source === "darwin" ? "real" : "mock";
    return kind === this.opts.client.kind ? this.opts.client : getDarwinClient(agent.source);
  }

  private cancelQuietly(client: DarwinClient, handle: TaskHandle): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wait = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, CANCEL_WAIT_MS);
    });
    const cancel = client.cancelTask(handle).catch(() => undefined);
    return Promise.race([cancel, wait]).finally(() => clearTimeout(timer));
  }

  private emit(e: EngineEvent): void {
    this.opts.publish(e);
  }

  private emitAttempt(a: AttemptView): void {
    this.emit({ type: "attempt", runId: this.run.id, attempt: { ...a } });
  }

  private persistAttempt(a: AttemptView): void {
    this.opts.store.upsertAttempt(a);
    this.emitAttempt(a);
  }

  private alert(level: "info" | "warn" | "error", message: string, nodeId?: string): void {
    this.emit({ type: "alert", runId: this.run.id, nodeId, level, message, at: Date.now() });
  }
}

// ---------- helpers ----------

export const AXOLOTL_AGENT: AgentRef = {
  agentId: "axolotl:builtin",
  capabilityId: "axolotl:builtin",
  name: "Axolotl (built-in)",
  source: "mock",
  provider: "Axolotl",
};

function killedResult(act: ActiveAttempt): AttemptResult {
  return act.attempt.injectedFault === "auth_block"
    ? { ok: false, failureType: "auth_block", detail: "Agent requested authentication during an unattended run" }
    : { ok: false, failureType: "killed", detail: "Agent process killed mid-task" };
}

function toRef(m: RoutedAgent | AgentRef): AgentRef {
  return { agentId: m.agentId, capabilityId: m.capabilityId, name: m.name, source: m.source, provider: m.provider };
}

function isTerminal(s: NodeView["state"]): boolean {
  return s === "passed" || s === "failed" || s === "partial" || s === "cancelled";
}

function pagePath(url: string): string {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    const last = parts[parts.length - 1];
    return !last || u.pathname.endsWith("/") ? "home" : last.replace(/\.html?$/i, "");
  } catch {
    return url;
  }
}

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

function faultLabel(f: FaultMode): string {
  return { error: "a crash", timeout: "a timeout", stall: "a stall", auth_block: "an auth request", corrupt: "corrupted output" }[f];
}

class Semaphore {
  private queue: (() => void)[] = [];
  private inUse = 0;
  constructor(private readonly max: number) {}

  acquire(signal: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      const grant = () => {
        this.inUse++;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.inUse--;
          this.queue.shift()?.();
        });
      };
      if (signal.aborted) return reject(new RunAborted("cancelled"));
      if (this.inUse < this.max) return grant();
      const waiter = () => {
        signal.removeEventListener("abort", onAbort);
        grant();
      };
      const onAbort = () => {
        this.queue = this.queue.filter((w) => w !== waiter);
        reject(new RunAborted("cancelled"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.queue.push(waiter);
    });
  }
}

/** What a passing attempt delivered, in a few words, for the agent panel on Rankings. */
function successNote(output: unknown, checks: number): string {
  const o = output as { pages?: unknown[]; issues?: unknown[]; pagesChecked?: unknown[] } | null;
  const what = Array.isArray(o?.pages)
    ? `found ${o.pages.length} ${o.pages.length === 1 ? "page" : "pages"}`
    : Array.isArray(o?.issues)
      ? `reported ${o.issues.length} ${o.issues.length === 1 ? "issue" : "issues"}${Array.isArray(o.pagesChecked) ? ` on ${o.pagesChecked.length} ${o.pagesChecked.length === 1 ? "page" : "pages"}` : ""}`
      : "answered";
  return `${what}; passed all ${checks} checks`;
}
