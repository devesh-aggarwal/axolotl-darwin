// Per-capability leaderboards built from /api/stats, with each agent's trust verdict when known.
// Rows rank by score, then speed: the same reliability the router uses to order agents within a tier.
import type { ScoreHistoryView } from "@/components/api";
import { FAILURE_LABEL, VERDICT, fmtMs } from "@/components/ui/tokens";
import { CAPABILITIES, type AgentStats, type Capability, type FailureType, type TrustReport, type TrustVerdict } from "@/lib/types";

/** Beta-Bernoulli prior with no observations: (0 + 1) / (0 + 2). */
export const PRIOR_SCORE = 0.5;

export type HistoryPoint = ScoreHistoryView["points"][number];

export interface BoardRow {
  agentId: string;
  name: string;
  source: AgentStats["source"];
  /** From the trust check, when Axolotl has seen this agent's listing. */
  verdict?: TrustVerdict;
  trustScore?: number;
  score: number;
  attempts: number;
  successes: number;
  avgLatencyMs: number | null;
  failures: Partial<Record<FailureType, number>>;
  history: HistoryPoint[];
}

export interface Board {
  capability: Capability;
  attempts: number;
  successes: number;
  rows: BoardRow[];
}

const key = (agentId: string, capability: string) => `${agentId}|${capability}`;

function compareRows(a: BoardRow, b: BoardRow): number {
  return (
    b.score - a.score ||
    (a.avgLatencyMs || Number.MAX_SAFE_INTEGER) - (b.avgLatencyMs || Number.MAX_SAFE_INTEGER) ||
    a.name.localeCompare(b.name)
  );
}

export function buildBoards(stats: AgentStats[], history: ScoreHistoryView[], trust: TrustReport[] = []): Board[] {
  const historyBy = new Map(history.map((h) => [key(h.agentId, h.capability), h.points]));
  const trustBy = new Map(trust.map((t) => [key(t.agentId, t.capability), t]));

  return CAPABILITIES.map((capability) => {
    const rows: BoardRow[] = stats
      .filter((s) => s.capability === capability)
      .map((s) => {
        const k = key(s.agentId, capability);
        const t = trustBy.get(k);
        return {
          agentId: s.agentId,
          name: s.name || s.agentId,
          source: s.source,
          verdict: t?.verdict,
          trustScore: t?.score,
          score: s.score,
          attempts: s.attempts,
          successes: s.successes,
          avgLatencyMs: s.attempts ? s.avgLatencyMs : null,
          failures: s.failures,
          history: historyBy.get(k) ?? [],
        };
      })
      .sort(compareRows);
    return {
      capability,
      attempts: rows.reduce((n, r) => n + r.attempts, 0),
      successes: rows.reduce((n, r) => n + r.successes, 0),
      rows,
    };
  });
}

/** A score as the whole percentage shown everywhere in the UI ("81%"). */
export function fmtScore(score: number): string {
  return `${Math.round(score * 100)}%`;
}

/** How scores work, for a hover on the page explanation. */
export const SCORE_FORMULA =
  `Score = (passed + 1) / (attempts + 2), shown as a percentage. New agents start at ${fmtScore(PRIOR_SCORE)}; ` +
  "faster agents win ties. Within free or paid agents, a higher score means the agent is tried earlier.";

/** Detail that stays out of the row and shows on hover. */
export function describeRow(r: BoardRow): string {
  const lines = [r.name];
  if (!r.attempts) {
    lines.push(`No attempts yet, starts at ${fmtScore(PRIOR_SCORE)}`);
  } else {
    lines.push(`${r.successes} of ${r.attempts} attempts passed Axolotl's checks · avg ${fmtMs(r.avgLatencyMs ?? undefined)}`);
    const fails = (Object.entries(r.failures) as [FailureType, number][]).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
    lines.push(fails.length ? `Failures: ${fails.map(([t, n]) => `${FAILURE_LABEL[t]} ${n}`).join(", ")}` : "No failures");
  }
  if (r.verdict) lines.push(`Trust check: ${VERDICT[r.verdict].label}${r.trustScore !== undefined ? `, ${r.trustScore} of 100` : ""}`);
  if (r.source === "darwin") lines.push("Darwin agent");
  return lines.join("\n");
}

/** Score band, same thresholds as the reliability meter in the run inspector. */
export function scoreColor(score: number): string {
  if (score >= 0.8) return "var(--s-passed)";
  if (score >= 0.55) return "var(--ink-2)";
  return "var(--s-failed)";
}
