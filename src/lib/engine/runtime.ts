// Process-wide registry of live runs. Route handlers call into this; engines publish to the bus.
import { DEFAULTS } from "@/config/workflow";
import { demoSiteUrl, env } from "@/lib/env";
import { getDarwinClient } from "@/lib/engine/clients";
import { RunEngine } from "@/lib/engine/engine";
import { startHealthScheduler } from "@/lib/engine/pools";
import { SqliteStore, listRuns, markOrphanedRunsCrashed, type RunRecord } from "@/lib/engine/store";
import { publish } from "@/lib/events";
import { randomId } from "@/lib/rng";
import type { ChaosConfig, FaultMode, NodeView, RunConfig, RunSummary } from "@/lib/types";

const FAULT_MODES: FaultMode[] = ["error", "timeout", "stall", "auth_block", "corrupt"];

export const DEFAULT_CHAOS: ChaosConfig = {
  enabled: false,
  rate: 0.15,
  weights: { error: 3, timeout: 1, stall: 1, auth_block: 1, corrupt: 3 },
};

interface Runtime {
  engines: Map<string, RunEngine>;
  chaos: ChaosConfig;
  activeRunId: string | null;
  booted: boolean;
}

const g = globalThis as unknown as { __axolotlRuntime?: Runtime };

function rt(): Runtime {
  if (!g.__axolotlRuntime) {
    g.__axolotlRuntime = { engines: new Map(), chaos: { ...DEFAULT_CHAOS, weights: { ...DEFAULT_CHAOS.weights } }, activeRunId: null, booted: false };
  }
  const r = g.__axolotlRuntime;
  if (!r.booted) {
    r.booted = true;
    markOrphanedRunsCrashed();
    startHealthScheduler();
  }
  return r;
}

const store = new SqliteStore();

export function defaultRunConfig(): RunConfig {
  return {
    siteUrl: demoSiteUrl(),
    maxPages: DEFAULTS.maxPages,
    client: env.defaultClient === "real" ? "darwin" : "mock",
    simulatedBackups: true,
    chaos: { ...rt().chaos, weights: { ...rt().chaos.weights } },
    llmMode: "mock",
    seed: Math.floor(Math.random() * 1_000_000),
    timeScale: 1,
    concurrency: DEFAULTS.concurrency,
    baseline: false,
    persist: true,
    recordStats: true,
  };
}

/** Builds a run config from untrusted input: only known fields, each type-checked and clamped. */
export function sanitizeConfig(input: Partial<RunConfig> | null | undefined): RunConfig {
  const base = defaultRunConfig();
  const i: Partial<RunConfig> = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  let siteUrl = base.siteUrl;
  try {
    const u = new URL(String(i.siteUrl ?? base.siteUrl));
    if (u.protocol === "http:" || u.protocol === "https:") siteUrl = u.toString();
  } catch {
    // keep the default
  }
  const seed = Number(i.seed);
  const baseline = i.baseline === true;
  return {
    siteUrl,
    maxPages: Math.round(clamp(num(i.maxPages, base.maxPages), 1, 10)),
    client: i.client === "darwin" ? "darwin" : "mock",
    simulatedBackups: i.simulatedBackups !== false,
    chaos: sanitizeChaos(i.chaos, base.chaos),
    llmMode: i.llmMode === "live" ? "live" : "mock",
    seed: i.seed !== undefined && i.seed !== null && Number.isFinite(seed) ? Math.floor(seed) : base.seed,
    timeScale: clamp(num(i.timeScale, 1), 0.01, 5),
    concurrency: Math.round(clamp(num(i.concurrency, base.concurrency), 1, 16)),
    baseline,
    persist: true,
    recordStats: !baseline,
  };
}

function sanitizeChaos(patch: unknown, base: ChaosConfig): ChaosConfig {
  const p = (patch && typeof patch === "object" ? patch : {}) as Partial<ChaosConfig>;
  const w = (p.weights && typeof p.weights === "object" ? p.weights : {}) as Partial<Record<FaultMode, unknown>>;
  const weights = { ...base.weights };
  for (const f of FAULT_MODES) if (w[f] !== undefined) weights[f] = Math.max(0, num(w[f], base.weights[f]));
  return {
    enabled: typeof p.enabled === "boolean" ? p.enabled : base.enabled,
    rate: clamp(num(p.rate, base.rate), 0, 1),
    weights,
  };
}

/** Finite number or the fallback (NaN would otherwise slip through clamp and e.g. make chaos fire on every attempt). */
function num(v: unknown, fallback: number): number {
  if (v === null || v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function launch(engine: RunEngine): void {
  const r = rt();
  r.engines.set(engine.run.id, engine);
  r.activeRunId = engine.run.id;
  void engine
    .execute()
    .catch((err: unknown) => console.error("[engine] run", engine.run.id, "failed to finish:", (err as Error)?.message))
    .finally(() => {
      // Keep finished engines briefly so late UI requests still read memory state.
      setTimeout(() => {
        if (r.engines.get(engine.run.id) === engine) r.engines.delete(engine.run.id);
      }, 10 * 60_000).unref?.();
    });
}

export function startRun(input?: Partial<RunConfig>): RunSummary {
  const config = sanitizeConfig(input);
  const run: RunSummary = { id: randomId("run"), status: "running", config, createdAt: Date.now() };
  const engine = new RunEngine(run, { client: getDarwinClient(config.client), store, publish });
  launch(engine);
  return run;
}

export class RunNotFoundError extends Error {
  constructor() {
    super("Run not found");
  }
}

export function resumeRun(runId: string): RunSummary {
  const live = rt().engines.get(runId);
  if (live && live.run.status === "running") throw new Error("Run is still running");
  const rec = store.loadRun(runId);
  if (!rec) throw new RunNotFoundError();
  if (rec.run.status === "completed") throw new Error("Run already completed");
  // Only a crashed process leaves a "running" row without a live engine, and boot marks those crashed.
  if (rec.run.status === "running") throw new Error("Run is still running");
  // Every saved node goes to the engine: passed ones are restored, the rest continue their attempt numbering.
  const checkpoints = new Map<string, NodeView>(rec.nodes.map((n) => [n.id, n]));
  const restored = rec.nodes.filter((n) => n.state === "passed").length;
  const run: RunSummary = { ...rec.run, status: "running", finishedAt: undefined, stats: undefined };
  run.config.chaos = { ...rt().chaos, weights: { ...rt().chaos.weights } };
  const engine = new RunEngine(run, {
    client: getDarwinClient(run.config.client),
    store,
    publish,
    checkpoints,
    priorAttempts: rec.attempts,
  });
  launch(engine);
  publish({
    type: "alert",
    runId,
    level: "info",
    message: `Resumed from checkpoint: ${restored} node(s) restored, continuing from the last good node`,
    at: Date.now(),
  });
  return run;
}

export function crashRun(runId: string): boolean {
  const e = rt().engines.get(runId);
  if (!e || e.run.status !== "running") return false;
  e.crash();
  return true;
}

export function cancelRun(runId: string): boolean {
  const e = rt().engines.get(runId);
  if (!e || e.run.status !== "running") return false;
  e.cancel();
  return true;
}

export function injectFault(runId: string, nodeId: string, fault: FaultMode): { ok: true } | { ok: false; reason: string } {
  const e = rt().engines.get(runId);
  if (!e || e.run.status !== "running") return { ok: false, reason: "That run isn't running." };
  return e.injectFault(nodeId, fault) ? { ok: true } : { ok: false, reason: e.lastFaultRefusal || "That step can't be broken right now." };
}

export function getChaos(): ChaosConfig {
  return rt().chaos;
}

export function setChaos(patch: Partial<ChaosConfig> | null | undefined): ChaosConfig {
  const r = rt();
  r.chaos = sanitizeChaos(patch, r.chaos);
  for (const e of r.engines.values()) if (e.run.status === "running" && !e.run.config.baseline) e.setChaos({ ...r.chaos });
  return r.chaos;
}

export function getActiveRunId(): string | null {
  return rt().activeRunId;
}

/** Live state from memory when the run is in this process, otherwise from SQLite. */
export function getRunRecord(runId: string): RunRecord | null {
  const e = rt().engines.get(runId);
  if (e) return { run: e.run, nodes: [...e.nodes.values()], attempts: [...e.attempts] };
  return store.loadRun(runId);
}

export function recentRuns(limit = 20): RunSummary[] {
  rt();
  const runs = listRuns(limit);
  // Prefer the live object for running runs (fresher status).
  return runs.map((r) => rt().engines.get(r.id)?.run ?? r);
}

export function ensureBooted(): void {
  rt();
}
