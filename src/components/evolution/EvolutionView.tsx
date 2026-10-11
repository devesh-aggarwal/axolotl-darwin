"use client";
// Evolution: per-capability leaderboards. Every checked or failed attempt moves an agent's
// reliability score, and the router tries higher-scoring agents earlier.
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/components/api";
import { useAxolotl } from "@/components/store";
import { Button, Details, Empty } from "@/components/ui/primitives";
import { fmtClock } from "@/components/ui/tokens";
import { AgentDetail, type AgentDetailTarget } from "@/components/evolution/AgentDetail";
import { CapabilityBoard } from "@/components/evolution/CapabilityBoard";
import { useThrottledLoad } from "@/components/evolution/hooks";
import { PRIOR_SCORE, SCORE_FORMULA, buildBoards, fmtScore, sourceLabel, type BoardRow } from "@/components/evolution/leaderboard";

const loadStats = () => api.stats();
const loadTrust = () => api.trust();

export function EvolutionView() {
  const { state, actions } = useAxolotl();
  const stats = useThrottledLoad(loadStats, state.statsVersion, 1000);
  // Trust verdicts are a nice-to-have on each row; the boards render without them.
  const trust = useThrottledLoad(loadTrust, state.statsVersion, 5000);
  const [resetting, setResetting] = useState(false);
  // Two-step reset inline: window.confirm() is suppressed in the in-app browser.
  const [confirming, setConfirming] = useState(false);
  const [detail, setDetail] = useState<AgentDetailTarget | null>(null);
  const closeDetail = useCallback(() => setDetail(null), []);
  const openDetail = useCallback((row: BoardRow) => setDetail({ agentId: row.agentId, capability: row.capability, name: row.name, sourceLabel: sourceLabel(row) }), []);

  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(false), 8000);
    return () => clearTimeout(t);
  }, [confirming]);

  const boards = useMemo(() => {
    if (!stats.data) return null;
    return buildBoards(stats.data.stats, stats.data.history, trust.data?.reports);
  }, [stats.data, trust.data]);

  // Simulated agents are left off the boards, so only real rows count as "has data".
  const hasStats = Boolean(boards?.some((b) => b.rows.length));
  const lastUpdated = useMemo(() => stats.data?.stats.reduce((m, s) => Math.max(m, s.updatedAt), 0) ?? 0, [stats.data]);

  const reset = async () => {
    setConfirming(false);
    setResetting(true);
    try {
      await api.resetStats();
      stats.refresh();
    } catch (err) {
      actions.notify("error", `Reset failed: ${(err as Error).message}`);
    } finally {
      setResetting(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mx-auto flex w-full max-w-[1232px] flex-wrap items-end gap-x-8 gap-y-3 px-4 pb-4 pt-6 md:px-6">
        <div className="min-w-[280px] flex-1">
          <h1 className="text-[24px] font-semibold leading-tight tracking-[-0.02em] text-ink">Agent reliability</h1>
          <p className="mt-1.5 max-w-[64ch] text-[14.5px] leading-relaxed text-muted">
            Agents are ranked by how often their work passes Axolotl&rsquo;s checks. When a step needs an agent, the most reliable ones are tried
            first. Scores come from real calls only: audit runs on Darwin, and the address lookups and delivery carts Axolotl checks through
            its MCP tools.
          </p>
          <div className="mt-2">
            <Details summary="How scores work">
              <p className="max-w-[64ch] text-[13.5px] leading-relaxed text-ink-2">{SCORE_FORMULA}</p>
            </Details>
          </div>
        </div>
        {confirming ? (
          <div key="confirm" className="flex flex-wrap items-center gap-2" role="group" aria-label="Confirm reset">
            <span className="mr-1 text-[13.5px] text-ink-2">Set every score back to {fmtScore(PRIOR_SCORE)}?</span>
            <Button size="sm" tone="danger" onClick={reset}>
              Confirm reset
            </Button>
            <Button size="sm" tone="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <div key="idle" className="flex items-center gap-5">
            <FeedStatus lastUpdated={lastUpdated} error={stats.data ? stats.error : null} />
            <Button size="sm" onClick={() => setConfirming(true)} disabled={resetting || !hasStats}>
              {resetting ? "Resetting…" : "Reset scores"}
            </Button>
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6 md:px-6">
        {!boards ? (
          stats.error ? (
            <Empty title="Couldn't load scores">{stats.error}</Empty>
          ) : (
            <Empty title="Loading scores…" />
          )
        ) : !hasStats ? (
          <Empty title="No results recorded yet">
            Every checked or failed attempt by a real agent moves its score. Start a run on Darwin, or ask for an address or a delivery cart
            through Axolotl&rsquo;s MCP tools.
            <span className="mt-4 flex justify-center gap-2">
              <Button size="sm" onClick={() => actions.setTab("run")}>
                Open live run
              </Button>
            </span>
          </Empty>
        ) : (
          <div className="mx-auto grid max-w-[1200px] gap-3 md:grid-cols-2 xl:grid-cols-3">
            {/* Steps no real agent has run yet stay off the page instead of showing an empty board. */}
            {boards
              .filter((b) => b.rows.length > 0)
              .map((b) => (
                <CapabilityBoard key={b.capability} board={b} onSelect={openDetail} />
              ))}
          </div>
        )}
      </div>
      {detail && <AgentDetail target={detail} version={state.statsVersion} onClose={closeDetail} />}
    </div>
  );
}

function FeedStatus({ lastUpdated, error }: { lastUpdated: number; error: string | null }) {
  if (error) return <span className="text-[13.5px] text-failed">Couldn&rsquo;t refresh scores</span>;
  if (!lastUpdated) return null;
  return <span className="tabular text-[13.5px] text-muted">Updated {fmtClock(lastUpdated)}</span>;
}
