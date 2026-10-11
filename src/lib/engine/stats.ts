// Reliability scoring (spec 7.5): per agent per capability, Beta-Bernoulli
// (successes + 1) / (attempts + 2), latency as tiebreak.
import { getDb, json } from "@/lib/db";
import type { AgentRef, AgentStats, Capability, FailureType } from "@/lib/types";

export function betaScore(successes: number, attempts: number): number {
  return (successes + 1) / (attempts + 2);
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
    capability: r.capability as Capability,
    name: r.name,
    source: r.source as AgentStats["source"],
    attempts: r.attempts,
    successes: r.successes,
    failures: json<AgentStats["failures"]>(r.failures_json, {}),
    totalLatencyMs: r.total_latency_ms,
    score: betaScore(r.successes, r.attempts),
    avgLatencyMs: r.attempts ? Math.round(r.total_latency_ms / r.attempts) : 0,
    updatedAt: r.updated_at,
  };
}

export interface AttemptOutcomeRecord {
  agent: AgentRef;
  capability: Capability;
  success: boolean;
  failureType?: FailureType;
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
    db.prepare(`INSERT INTO agent_score_history (agent_id, capability, score, attempts, at) VALUES (?, ?, ?, ?, ?)`).run(
      o.agent.agentId,
      o.capability,
      betaScore(successes, attempts),
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
  capability: Capability;
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
      h = { agentId: r.agent_id, capability: r.capability as Capability, points: [{ at: r.at, score: 0.5, attempts: 0 }] };
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
  db.exec(`DELETE FROM agent_stats; DELETE FROM agent_score_history;`);
}
