// Reliability scoring (spec 7.5), per agent per capability. The score shown everywhere is the pass rate
// (an agent that has never failed shows 100%); routing orders agents by the Beta-Bernoulli estimate
// (successes + 1) / (attempts + 2) so one lucky pass doesn't jump an agent ahead of a proven one.
import { getDb, json } from "@/lib/db";
import type { AgentRef, AgentStats, FailureType, ScoredCapability } from "@/lib/types";

export function betaScore(successes: number, attempts: number): number {
  return (successes + 1) / (attempts + 2);
}

/** Share of attempts that passed; 50% before the first attempt. */
export function passRate(successes: number, attempts: number): number {
  return attempts ? successes / attempts : 0.5;
}

interface StatsRow {
  agent_id: string;
  capability: string;
  name: string;
  source: string;
  attempts: number;
  successes: number;
  failures_json: string;
  total_latency_ms: number;
  updated_at: number;
}

function rowToStats(r: StatsRow): AgentStats {
  return {
    agentId: r.agent_id,
    capability: r.capability as ScoredCapability,
    name: r.name,
    source: r.source as AgentStats["source"],
    attempts: r.attempts,
    successes: r.successes,
    failures: json<AgentStats["failures"]>(r.failures_json, {}),
    totalLatencyMs: r.total_latency_ms,
    score: passRate(r.successes, r.attempts),
    avgLatencyMs: r.attempts ? Math.round(r.total_latency_ms / r.attempts) : 0,
    updatedAt: r.updated_at,
  };
}

export interface AttemptOutcomeRecord {
  agent: AgentRef;
  capability: ScoredCapability;
  success: boolean;
  failureType?: FailureType;
  /** One line on what happened: what it got right, or why it failed. Shown in the agent panel on Rankings. */
  note?: string;
  latencyMs: number;
}

export function recordAttemptOutcome(o: AttemptOutcomeRecord): AgentStats {
  const db = getDb();
  const now = Date.now();
  const tx = db.transaction(() => {
    const existing = db
      .prepare(`SELECT * FROM agent_stats WHERE agent_id = ? AND capability = ?`)
      .get(o.agent.agentId, o.capability) as StatsRow | undefined;
    const failures = json<Record<string, number>>(existing?.failures_json, {});
    if (!o.success && o.failureType) failures[o.failureType] = (failures[o.failureType] ?? 0) + 1;
    const attempts = (existing?.attempts ?? 0) + 1;
    const successes = (existing?.successes ?? 0) + (o.success ? 1 : 0);
    const latency = (existing?.total_latency_ms ?? 0) + Math.round(o.latencyMs);
    db.prepare(
      `INSERT INTO agent_stats (agent_id, capability, name, source, attempts, successes, failures_json, total_latency_ms, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(agent_id, capability) DO UPDATE SET name = excluded.name, attempts = excluded.attempts,
         successes = excluded.successes, failures_json = excluded.failures_json,
         total_latency_ms = excluded.total_latency_ms, updated_at = excluded.updated_at`,
    ).run(o.agent.agentId, o.capability, o.agent.name, o.agent.source, attempts, successes, JSON.stringify(failures), latency, now);
    db.prepare(`INSERT INTO agent_results (agent_id, capability, success, failure_type, note, at) VALUES (?, ?, ?, ?, ?, ?)`).run(
      o.agent.agentId,
      o.capability,
      o.success ? 1 : 0,
      o.success ? null : (o.failureType ?? "error"),
      (o.note ?? "").replace(/\s+/g, " ").trim().slice(0, 500),
      now,
    );
    db.prepare(`INSERT INTO agent_score_history (agent_id, capability, score, attempts, at) VALUES (?, ?, ?, ?, ?)`).run(
      o.agent.agentId,
      o.capability,
      passRate(successes, attempts),
      attempts,
      now,
    );
    return db.prepare(`SELECT * FROM agent_stats WHERE agent_id = ? AND capability = ?`).get(o.agent.agentId, o.capability) as StatsRow;
  });
  return rowToStats(tx());
}

export function getAllStats(): AgentStats[] {
  return (getDb().prepare(`SELECT * FROM agent_stats`).all() as StatsRow[]).map(rowToStats);
}

export function getStatsMap(): Map<string, AgentStats> {
  const m = new Map<string, AgentStats>();
  for (const s of getAllStats()) m.set(`${s.agentId}|${s.capability}`, s);
  return m;
}

export interface ScoreHistory {
  agentId: string;
  capability: ScoredCapability;
  points: { at: number; score: number; attempts: number }[];
}

/** Downsampled score history per agent for sparklines. */
export function getScoreHistory(maxPoints = 40): ScoreHistory[] {
  const rows = getDb()
    .prepare(`SELECT agent_id, capability, score, attempts, at FROM agent_score_history ORDER BY id`)
    .all() as { agent_id: string; capability: string; score: number; attempts: number; at: number }[];
  const by = new Map<string, ScoreHistory>();
  for (const r of rows) {
    const k = `${r.agent_id}|${r.capability}`;
    let h = by.get(k);
    if (!h) {
      h = { agentId: r.agent_id, capability: r.capability as ScoredCapability, points: [{ at: r.at, score: 0.5, attempts: 0 }] };
      by.set(k, h);
    }
    h.points.push({ at: r.at, score: r.score, attempts: r.attempts });
  }
  for (const h of by.values()) {
    if (h.points.length > maxPoints) {
      const step = (h.points.length - 1) / (maxPoints - 1);
      h.points = Array.from({ length: maxPoints }, (_, i) => h.points[Math.round(i * step)]);
    }
  }
  return [...by.values()];
}

export function resetStats(): void {
  const db = getDb();
  db.exec(`DELETE FROM agent_stats; DELETE FROM agent_score_history; DELETE FROM agent_results;`);
}

export interface ResultRecord {
  success: boolean;
  failureType?: FailureType;
  note: string;
  at: number;
}

/** An agent's most recent results on one step, newest first. */
export function getResults(agentId: string, capability: string, limit = 300): ResultRecord[] {
  const rows = getDb()
    .prepare(`SELECT success, failure_type, note, at FROM agent_results WHERE agent_id = ? AND capability = ? ORDER BY id DESC LIMIT ?`)
    .all(agentId, capability, limit) as { success: number; failure_type: string | null; note: string; at: number }[];
  return rows.map((r) => ({ success: r.success === 1, ...(r.failure_type ? { failureType: r.failure_type as FailureType } : {}), note: r.note, at: r.at }));
}
