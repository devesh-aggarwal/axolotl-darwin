// Pure helpers for the overnight time-lapse: per-run outcomes from cumulative ticks, the
// simulated night clock, and the numbers shown on screen.
import type { TimelapseSide, TimelapseTick } from "@/lib/types";

export type SideKey = "without" | "with";
export type RunOutcome = "usable" | "failed" | "corrupt";

export interface RunMark {
  index: number;
  clock: string;
  outcome: RunOutcome;
  /** Backups that took over during this run. */
  recoveries: number;
}

/** The simulated night runs 23:00 → 07:00 (same mapping as the engine). */
export const NIGHT_HOURS = 8;
const NIGHT_START_MIN = 23 * 60;
/** Hour marks shown on the strips and the chart, as offsets from 23:00. */
export const HOUR_MARKS = [0, 2, 4, 6, 8];

export const ZERO_SIDE: TimelapseSide = { runs: 0, completed: 0, silentlyCorrupt: 0, recoveries: 0, humanInterventions: 0, wastedHours: 0 };

export const SIDE_COLOR: Record<SideKey, string> = {
  without: "var(--s-failed)",
  with: "var(--s-passed)",
};

export const OUTCOME_FILL: Record<RunOutcome, string> = {
  usable: "var(--s-passed)",
  failed: "var(--s-failed)",
  corrupt: "var(--s-partial)",
};

export const OUTCOME_LABEL: Record<RunOutcome, string> = {
  usable: "Usable report",
  failed: "Failed",
  corrupt: "Finished but wrong",
};

const pad = (n: number) => String(n).padStart(2, "0");

export function nightClock(index: number, total: number): string {
  const minute = NIGHT_START_MIN + Math.round((index / Math.max(1, total)) * NIGHT_HOURS * 60);
  return `${pad(Math.floor(minute / 60) % 24)}:${pad(minute % 60)}`;
}

export function hourLabel(h: number): string {
  return `${pad((23 + h) % 24)}:00`;
}

/** Ticks in run order, one per index. */
export function sortTicks(ticks: TimelapseTick[]): TimelapseTick[] {
  const byIndex = new Map<number, TimelapseTick>();
  for (const t of ticks) byIndex.set(t.index, t);
  return [...byIndex.values()].sort((a, b) => a.index - b.index);
}

/**
 * One mark per finished run, from deltas between consecutive cumulative ticks:
 * a completed delta is a usable report, a silentlyCorrupt delta is a corrupt report that was
 * accepted, anything else failed. A gap in the tick stream spreads the delta over the missed runs.
 */
export function deriveRuns(ticks: TimelapseTick[], side: SideKey): RunMark[] {
  const out: RunMark[] = [];
  let prev = ZERO_SIDE;
  let prevIndex = 0;
  for (const t of ticks) {
    const span = t.index - prevIndex;
    if (span <= 0) continue;
    const cur = t[side];
    let usable = Math.max(0, cur.completed - prev.completed);
    let corrupt = Math.max(0, cur.silentlyCorrupt - prev.silentlyCorrupt);
    const recoveries = Math.max(0, cur.recoveries - prev.recoveries);
    for (let k = 1; k <= span; k++) {
      let outcome: RunOutcome = "failed";
      if (usable > 0) {
        outcome = "usable";
        usable--;
      } else if (corrupt > 0) {
        outcome = "corrupt";
        corrupt--;
      }
      const index = prevIndex + k;
      out.push({ index, clock: index === t.index ? t.clock : nightClock(index, t.total), outcome, recoveries: span === 1 ? recoveries : 0 });
    }
    prev = cur;
    prevIndex = t.index;
  }
  return out;
}

/** Share of finished runs with a usable report, as the whole percent shown on screen. */
export function usablePercent(s: TimelapseSide): number {
  return s.runs ? Math.round((s.completed / s.runs) * 100) : 0;
}

/** Big-number color, one rule for both sides so the comparison is fair: green when clearly healthy, red when most runs fail. */
export function percentColor(_side: SideKey, pct: number): string {
  if (pct >= 85) return "var(--s-passed)";
  if (pct < 50) return "var(--s-failed)";
  return "var(--ink)";
}

export function fmtCount(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

export const plural = (n: number, one: string, many: string) => (Math.round(n) === 1 ? one : many);

/** The latest tick at or before `index` (ticks sorted by index). */
export function tickAt(ticks: TimelapseTick[], index: number): TimelapseTick | undefined {
  let found: TimelapseTick | undefined;
  for (const t of ticks) {
    if (t.index > index) break;
    found = t;
  }
  return found;
}
