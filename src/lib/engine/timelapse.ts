// Overnight time-lapse (spec 6.5): N full workflow executions back to back with chaos on,
// compressed into about a minute, run twice per "night" with identical seeds:
// without Axolotl (primary only, no verification) and with Axolotl.
import { DEFAULTS } from "@/config/workflow";
import { getDarwinClient } from "@/lib/engine/clients";
import { RunEngine } from "@/lib/engine/engine";
import { DEFAULT_CHAOS, defaultRunConfig } from "@/lib/engine/runtime";
import { NullStore } from "@/lib/engine/store";
import { publish } from "@/lib/events";
import { randomId } from "@/lib/rng";
import type { ChaosConfig, RunConfig, RunSummary, TimelapseSide, TimelapseTick } from "@/lib/types";

export interface TimelapseOptions {
  runs?: number;
  chaosRate?: number;
  seed?: number;
  /** Target wall-clock length of the whole time-lapse. */
  durationMs?: number;
}

interface TimelapseState {
  id: string;
  ticks: TimelapseTick[];
  running: boolean;
  cancelled: boolean;
  options: Required<TimelapseOptions>;
  /** The night in flight, so a cancel stops it instead of waiting for it to finish. */
  engines?: RunEngine[];
  /** Wakes the pause between nights on cancel. */
  wake?: () => void;
}

const g = globalThis as unknown as { __axolotlTimelapse?: TimelapseState };

/** Mock latencies/timeouts are multiplied by this: 4s agent calls become ~120ms. */
const TIME_SCALE = 0.03;
/** Each simulated night audits the site's key pages. */
const PAGES_PER_NIGHT = 3;
/** The simulated night runs 23:00 → 07:00. */
const NIGHT_START_MIN = 23 * 60;
const NIGHT_LENGTH_MIN = 8 * 60;

export function getTimelapse(): TimelapseState | null {
  return g.__axolotlTimelapse ?? null;
}

export function cancelTimelapse(): boolean {
  const s = g.__axolotlTimelapse;
  if (!s?.running) return false;
  s.cancelled = true;
  for (const e of s.engines ?? []) e.cancel();
  s.wake?.();
  return true;
}

export function startTimelapse(input?: TimelapseOptions | null): TimelapseState {
  const existing = g.__axolotlTimelapse;
  if (existing?.running) return existing;
  const opts: TimelapseOptions = input && typeof input === "object" ? input : {};
  const options: Required<TimelapseOptions> = {
    runs: Math.round(clamp(num(opts.runs, 50), 5, 200)),
    chaosRate: clamp(num(opts.chaosRate, 0.1), 0, 0.9),
    seed: Math.floor(num(opts.seed, Math.random() * 1_000_000)),
    durationMs: clamp(num(opts.durationMs, 60_000), 10_000, 300_000),
  };
  const state: TimelapseState = { id: randomId("tl"), ticks: [], running: true, cancelled: false, options };
  g.__axolotlTimelapse = state;
  void run(state).catch((err) => {
    console.error("[timelapse] failed:", (err as Error).message);
    state.running = false;
    state.engines = undefined;
  });
  return state;
}

function emptySide(): TimelapseSide {
  return { runs: 0, completed: 0, silentlyCorrupt: 0, recoveries: 0, humanInterventions: 0, wastedHours: 0 };
}

async function run(state: TimelapseState): Promise<void> {
  const { runs, chaosRate, seed, durationMs } = state.options;
  const chaos: ChaosConfig = { enabled: true, rate: chaosRate, weights: { ...DEFAULT_CHAOS.weights } };
  const without = emptySide();
  const withAx = emptySide();
  const perRunMs = durationMs / runs;
  const client = getDarwinClient("mock");
  const base = defaultRunConfig();

  for (let i = 0; i < runs && !state.cancelled; i++) {
    const started = Date.now();
    const config = (baseline: boolean): RunConfig => ({
      ...base,
      maxPages: PAGES_PER_NIGHT,
      client: "mock",
      simulatedBackups: false,
      chaos,
      llmMode: "mock",
      seed: seed + i * 7919,
      timeScale: TIME_SCALE,
      concurrency: 12,
      baseline,
      persist: false,
      recordStats: !baseline,
    });
    const mk = (baseline: boolean): RunSummary => ({ id: randomId(baseline ? "tlb" : "tla"), status: "running", config: config(baseline), createdAt: Date.now() });
    const quiet = () => undefined;
    const engines = [
      new RunEngine(mk(true), { client, store: new NullStore(), publish: quiet }),
      new RunEngine(mk(false), { client, store: new NullStore(), publish: quiet }),
    ];
    state.engines = engines;
    const [b, a] = await Promise.all(engines.map((e) => e.execute()));
    state.engines = undefined;
    // A night cut short by a cancel says nothing about either side: don't count it.
    if (state.cancelled) break;

    tally(without, b);
    tally(withAx, a);
    if (i % 3 === 2 || i === runs - 1) publish({ type: "stats_updated", at: Date.now() });

    const minute = NIGHT_START_MIN + Math.round(((i + 1) / runs) * NIGHT_LENGTH_MIN);
    const clock = `${String(Math.floor(minute / 60) % 24).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
    const tick: TimelapseTick = {
      id: state.id,
      index: i + 1,
      total: runs,
      clock,
      without: { ...without },
      with: { ...withAx },
      done: i === runs - 1,
      point: { index: i + 1, clock, withRate: rate(withAx), withoutRate: rate(without) },
    };
    state.ticks.push(tick);
    publish({ type: "timelapse", data: tick });

    const spent = Date.now() - started;
    if (spent < perRunMs && i < runs - 1 && !state.cancelled) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, perRunMs - spent);
        state.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      state.wake = undefined;
    }
  }
  state.running = false;
  if (state.cancelled) {
    // Tell the UI it is over even when no night finished; the stored ticks match what it was told.
    const prev = state.ticks[state.ticks.length - 1];
    const last: TimelapseTick = prev
      ? { ...prev, done: true }
      : { id: state.id, index: 0, total: runs, clock: "23:00", without: emptySide(), with: emptySide(), done: true };
    if (prev) state.ticks[state.ticks.length - 1] = last;
    else state.ticks.push(last);
    publish({ type: "timelapse", data: last });
  }
}

/** A run only counts if it finished every branch AND nobody accepted a corrupted report. */
function tally(side: TimelapseSide, run: RunSummary): void {
  const s = run.stats;
  side.runs++;
  const corrupt = Boolean(s?.acceptedCorruptOutput);
  const ok = run.status === "completed" && !corrupt;
  if (ok) side.completed++;
  if (corrupt) side.silentlyCorrupt++;
  side.recoveries += s?.recoveries ?? 0;
  if (!ok) {
    // Someone has to notice in the morning and redo the audit by hand.
    side.humanInterventions += 1;
    side.wastedHours += DEFAULTS.manualAuditHours;
  }
}

function rate(s: TimelapseSide): number {
  return s.runs ? Math.round((s.completed / s.runs) * 1000) / 10 : 0;
}

function num(v: unknown, fallback: number): number {
  if (v === null || v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
