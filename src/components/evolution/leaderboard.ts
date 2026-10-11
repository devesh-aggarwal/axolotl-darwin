// Per-capability leaderboards built from /api/stats plus the configured pools.
// Rows rank by score. Promotion uses the same rule as orderPool() in src/lib/engine/pools.ts,
// so "Now tried first" appears exactly when the engine puts that backup ahead of the primary.
import type { ScoreHistoryView } from "@/components/api";
import { FAILURE_LABEL, fmtMs } from "@/components/ui/tokens";
import type { NodeTemplate } from "@/config/workflow";
import { CAPABILITIES, type AgentPool, type AgentKind, type AgentStats, type Capability, type FailureType, type PoolMember } from "@/lib/types";

import { PROMOTE_MARGIN, PROMOTE_MIN_ATTEMPTS, shouldPromote } from "@/lib/engine/promotion";
export { PROMOTE_MARGIN, PROMOTE_MIN_ATTEMPTS };
/** Beta-Bernoulli prior with no observations: (0 + 1) / (0 + 2). */
export const PRIOR_SCORE = 0.5;

export type HistoryPoint = ScoreHistoryView["points"][number];

export interface BoardRow {
  agentId: string;
  name: string;
  provider?: string;
  source: AgentKind;
  /** null when the agent has stats but is no longer in any pool. */
  role: PoolMember["role"] | null;
  /** Why the engine would skip this pool member right now, if it would. */
  skipReason?: string;
  score: number;
  attempts: number;
  successes: number;
  avgLatencyMs: number | null;
  failures: Partial<Record<FailureType, number>>;
  history: HistoryPoint[];
  /** Backup that out-scores the primary enough to be tried first. */
  promoted: boolean;
  /** Primary that a promoted backup now goes ahead of. */
  demoted: boolean;
}

export interface Board {
  capability: Capability;
  attempts: number;
  successes: number;
  rows: BoardRow[];
}

const key = (agentId: string, capability: string) => `${agentId}|${capability}`;

const latencyOf = (s: AgentStats | undefined) => s?.avgLatencyMs || Number.MAX_SAFE_INTEGER;
const scoreOf = (s: AgentStats | undefined) => s?.score ?? PRIOR_SCORE;

function compareRows(a: BoardRow, b: BoardRow): number {
  return (
    b.score - a.score ||
    (a.avgLatencyMs || Number.MAX_SAFE_INTEGER) - (b.avgLatencyMs || Number.MAX_SAFE_INTEGER) ||
    rolePriority(a.role) - rolePriority(b.role) ||
    a.name.localeCompare(b.name)
  );
}

function rolePriority(role: BoardRow["role"]): number {
  return role === "primary" ? 0 : role === "backup" ? 1 : 2;
}

function skipReason(m: PoolMember): string | undefined {
  if (!m.approved) return "not approved";
  if (!m.ready) return m.healthStatus === "unavailable" ? "unavailable" : "not ready";
  return undefined;
}

/** The (backup, primary) pair orderPool() would swap for this pool, if any. */
function findPromotion(pool: AgentPool, capability: Capability, stats: Map<string, AgentStats>): { member: string; over: string } | null {
  const usable = pool.members.filter((m) => m.approved && m.ready);
  const st = (m: PoolMember) => stats.get(key(m.agentId, capability));
  const primary = usable.find((m) => m.role === "primary");
  if (!primary) return null;
  const backups = usable
    .filter((m) => m !== primary)
    .sort((a, b) => scoreOf(st(b)) - scoreOf(st(a)) || latencyOf(st(a)) - latencyOf(st(b)));
  const best = backups[0];
  if (!best) return null;
  return shouldPromote(st(primary), st(best)) ? { member: best.agentId, over: primary.agentId } : null;
}

function toRow(
  agentId: string,
  stat: AgentStats | undefined,
  history: HistoryPoint[] | undefined,
  member: PoolMember | undefined,
): BoardRow {
  return {
    agentId,
    name: member?.name ?? stat?.name ?? agentId,
    provider: member?.provider,
    source: member?.source ?? stat?.source ?? "mock",
    role: member?.role ?? null,
    skipReason: member ? skipReason(member) : undefined,
    score: scoreOf(stat),
    attempts: stat?.attempts ?? 0,
    successes: stat?.successes ?? 0,
    avgLatencyMs: stat?.attempts ? stat.avgLatencyMs : null,
    failures: stat?.failures ?? {},
    history: history ?? [],
    promoted: false,
    demoted: false,
  };
}

export function buildBoards(
  stats: AgentStats[],
  history: ScoreHistoryView[],
  pools: AgentPool[],
  workflow: NodeTemplate[] | undefined,
): Board[] {
  const templateCapability = new Map<string, Capability>();
  for (const t of workflow ?? []) if (t.kind === "agent" && t.capability) templateCapability.set(t.id, t.capability);

  const statsBy = new Map(stats.map((s) => [key(s.agentId, s.capability), s]));
  const historyBy = new Map(history.map((h) => [key(h.agentId, h.capability), h.points]));

  return CAPABILITIES.map((capability) => {
    const capPools = pools.filter((p) => (templateCapability.get(p.templateId) ?? p.capability) === capability);
    const rows = new Map<string, BoardRow>();

    for (const pool of capPools) {
      for (const m of pool.members) {
        if (rows.has(m.agentId)) continue;
        const k = key(m.agentId, capability);
        rows.set(m.agentId, toRow(m.agentId, statsBy.get(k), historyBy.get(k), m));
      }
    }
    for (const s of stats) {
      if (s.capability !== capability || rows.has(s.agentId)) continue;
      const k = key(s.agentId, capability);
      rows.set(s.agentId, toRow(s.agentId, s, historyBy.get(k), undefined));
    }
    for (const pool of capPools) {
      const p = findPromotion(pool, capability, statsBy);
      if (!p) continue;
      const winner = rows.get(p.member);
      const loser = rows.get(p.over);
      if (winner) winner.promoted = true;
      if (loser) loser.demoted = true;
    }

    const list = [...rows.values()].sort(compareRows);
    return {
      capability,
      attempts: list.reduce((n, r) => n + r.attempts, 0),
      successes: list.reduce((n, r) => n + r.successes, 0),
      rows: list,
    };
  });
}

/** A score as the whole percentage shown everywhere in the UI ("81%"). */
export function fmtScore(score: number): string {
  return `${Math.round(score * 100)}%`;
}

/** How scores and promotion work, for a hover on the page explanation. */
export const SCORE_FORMULA =
  `Score = (passed + 1) / (attempts + 2), shown as a percentage. New agents start at ${fmtScore(PRIOR_SCORE)}; ` +
  `faster agents win ties. A backup is tried first once it scores ${Math.round(PROMOTE_MARGIN * 100)} points above the primary, ` +
  `with at least ${PROMOTE_MIN_ATTEMPTS} attempts each.`;

/** Detail that stays out of the row and shows on hover. */
export function describeRow(r: BoardRow): string {
  const lines = [r.provider ? `${r.name} · ${r.provider}` : r.name];
  if (!r.attempts) {
    lines.push(`No attempts yet, starts at ${fmtScore(PRIOR_SCORE)}`);
  } else {
    lines.push(`${r.successes} of ${r.attempts} attempts passed Axolotl's checks · avg ${fmtMs(r.avgLatencyMs ?? undefined)}`);
    const fails = (Object.entries(r.failures) as [FailureType, number][]).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
    lines.push(fails.length ? `Failures: ${fails.map(([t, n]) => `${FAILURE_LABEL[t]} ${n}`).join(", ")}` : "No failures");
  }
  if (r.promoted) lines.push("Clearly better than the primary, so it is now tried first");
  if (r.demoted) lines.push("A backup is now tried before this agent");
  if (r.skipReason) lines.push(`Skipped for now: ${r.skipReason}`);
  if (r.source === "darwin") lines.push("Darwin agent");
  return lines.join("\n");
}

/** Score band, same thresholds as the reliability meter in the run inspector. */
export function scoreColor(score: number): string {
  if (score >= 0.8) return "var(--s-passed)";
  if (score >= 0.55) return "var(--ink-2)";
  return "var(--s-failed)";
}
