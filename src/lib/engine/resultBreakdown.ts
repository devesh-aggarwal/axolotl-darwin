// One agent's track record on one step, for the agent panel on Rankings: what it gets right (recent
// passing answers) and how it usually fails (failures by type, then by note pattern). Notes that differ
// only in quoted names or numbers ("A162 ..." vs "B7 ...") fold into one pattern.
import type { ResultRecord } from "@/lib/engine/stats";
import type { FailureType } from "@/lib/types";

export interface NotePattern {
  /** The note with quoted text and numbers folded out. */
  pattern: string;
  /** The most recent full note behind this pattern. */
  example: string;
  count: number;
  lastAt: number;
}

export interface FailureGroup {
  failureType: FailureType;
  count: number;
  patterns: NotePattern[];
}

export interface ResultBreakdown {
  /** Passing answers with a stored note, newest first. */
  wins: { recorded: number; recent: { note: string; at: number }[] };
  /** Failures with a stored note, grouped. */
  losses: { recorded: number; groups: FailureGroup[] };
  /** Scored attempts with no stored note (they predate notes). */
  unrecorded: number;
}

export function notePattern(note: string): string {
  const r = note
    .replace(/"[^"]*"|“[^”]*”/g, "“…”")
    .replace(/\d+(\.\d+)?/g, "#")
    .replace(/\s+/g, " ")
    .trim();
  return r || "No reason recorded";
}

export function breakdownResults(attempts: number, records: ResultRecord[], opts: { recentWins?: number; maxPatterns?: number } = {}): ResultBreakdown {
  const wins = records.filter((r) => r.success);
  const byType = new Map<FailureType, Map<string, NotePattern>>();
  // Records arrive newest first, so the first one seen for a pattern is its latest example.
  for (const r of records) {
    if (r.success) continue;
    const type = r.failureType ?? "error";
    const patterns = byType.get(type) ?? new Map<string, NotePattern>();
    byType.set(type, patterns);
    const key = notePattern(r.note);
    const p = patterns.get(key);
    if (p) p.count++;
    else patterns.set(key, { pattern: key, example: r.note || "No reason recorded", count: 1, lastAt: r.at });
  }
  const groups = [...byType.entries()]
    .map(([failureType, patterns]) => {
      const all = [...patterns.values()].sort((a, b) => b.count - a.count || b.lastAt - a.lastAt);
      return { failureType, count: all.reduce((n, p) => n + p.count, 0), patterns: all.slice(0, opts.maxPatterns ?? 3) };
    })
    .sort((a, b) => b.count - a.count);
  return {
    wins: { recorded: wins.length, recent: wins.slice(0, opts.recentWins ?? 5).map((w) => ({ note: w.note || "Passed Axolotl's checks", at: w.at })) },
    losses: { recorded: records.length - wins.length, groups },
    unrecorded: Math.max(0, attempts - records.length),
  };
}
