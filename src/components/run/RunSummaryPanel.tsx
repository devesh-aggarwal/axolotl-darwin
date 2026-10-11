"use client";
import { useAxolotl, type ActivityItem } from "@/components/store";
import { CountUp, Empty, Stat } from "@/components/ui/primitives";
import { useCopy } from "@/components/ui/copy";
import { fmtCents } from "@/components/ui/tokens";

const STATUS_TEXT: Record<string, string> = {
  running: "Running",
  completed: "Run complete",
  partial: "Finished with a gap",
  failed: "Run failed",
  crashed: "Engine crashed",
  cancelled: "Stopped",
};

const STATUS_COLOR: Record<string, string> = {
  running: "var(--s-running)",
  completed: "var(--s-passed)",
  partial: "var(--s-partial)",
  failed: "var(--s-failed)",
  crashed: "var(--s-failed)",
  cancelled: "var(--muted)",
};

const ACTIVITY_COLOR: Record<ActivityItem["kind"], string> = {
  recovered: "var(--regrow)",
  lost: "var(--s-failed)",
  done: "var(--s-passed)",
  started: "var(--s-running)",
  note: "var(--muted)",
};

export function RunSummaryPanel() {
  const { state, actions } = useAxolotl();
  const copy = useCopy();
  const run = state.run;
  if (!run) return <Empty title="No run yet">Start a run to watch the workflow fix itself.</Empty>;

  const nodes = Object.values(state.nodes).filter((n) => !n.placeholder);
  const done = nodes.filter((n) => n.state === "passed" || n.state === "partial").length;
  const recoveries = nodes.filter((n) => n.kind === "agent" && n.state === "passed" && n.swaps > 0).length;
  const issues = run.stats?.issuesFound;
  const running = run.status === "running";
  const stuck = nodes.filter((n) => n.state === "failed" && Boolean(n.error)).length;
  const needsYou = stuck || (run.status === "failed" ? 1 : 0);
  // With the live stream down, "Running" would be a guess. Say what we know and when.
  const stale = running && !state.connected;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="px-4 pt-4">
        {stale && (
          <div className="mb-3 rounded-[8px] bg-panel-2 px-3 py-2 text-[13.5px] leading-snug text-ink-2">
            Live updates paused. This is the last state we received.{" "}
            <button className="font-medium text-[var(--focus)] underline-offset-2 hover:underline" onClick={() => void actions.loadRun(run.id)}>
              Refresh
            </button>
          </div>
        )}
        <div className="flex items-center gap-2">
          <span
            className={`inline-block h-[10px] w-[10px] rounded-full ${running && !stale ? "anim-pulse" : ""}`}
            style={{ background: STATUS_COLOR[run.status], ["--state" as string]: STATUS_COLOR[run.status] }}
          />
          <span className="text-[20px] font-semibold tracking-[-0.015em] text-ink">{STATUS_TEXT[run.status] ?? run.status}</span>
        </div>
        {run.config.request && <p className="mt-2 text-[14.5px] leading-snug text-ink-2">&ldquo;{run.config.request}&rdquo;</p>}
        <div className="mt-1 text-[13.5px] text-muted">
          {done === nodes.length && nodes.length > 0 ? `All ${nodes.length} steps done` : `${done} of ${nodes.length} steps done`} · {siteName(run.config.siteUrl)}
        </div>
        <div key={run.id} className="mt-5 grid grid-cols-[1.25fr_1fr_1fr] items-start gap-3">
          <Stat
            label={needsYou === 1 ? "Step needs you" : "Steps need you"}
            value={String(needsYou)}
            size="lg"
            color={needsYou ? "var(--s-failed)" : "var(--s-passed)"}
            hint={needsYou ? "Every agent found for these steps failed, so someone has to look at them" : "Every step finished or recovered on its own"}
          />
          <Stat label={copy.recovered} value={<CountUp value={recoveries} />} size="lg" color={recoveries ? "var(--regrow)" : undefined} />
          <Stat label="Problems found" value={issues === undefined ? "—" : <CountUp value={issues} />} size="lg" />
        </div>
        {run.stats?.recall !== undefined && (
          <div className="mt-4 text-[13.5px] text-muted">
            Caught {Math.round(run.stats.recall * 100)}% of the problems we planted in the demo site
.
          </div>
        )}
        {Boolean(run.stats?.spentCents) && (
          <div className="mt-2 text-[13.5px] text-muted">
            Spent {fmtCents(run.stats?.spentCents ?? 0)} on paid agents
            {run.config.budgetCents ? ` (limit ${fmtCents(run.config.budgetCents)})` : ""}.
          </div>
        )}
        {!running && (
          <button className="mt-3 text-[13.5px] font-medium text-[var(--focus)] underline-offset-2 hover:underline" onClick={() => actions.setTab("report")}>
            Open the report →
          </button>
        )}
      </div>
      <div className="mt-5 border-t border-line px-4 pt-4 text-[14px] font-medium text-ink">Activity</div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-2">
        {state.activity.length === 0 ? (
          <div className="text-[14px] text-muted">{running ? "Nothing has gone wrong yet." : "Nothing to report."}</div>
        ) : (
          <ul className="flex flex-col gap-2.5">
            {[...state.activity].reverse().map((a) => (
              <li key={a.id} className="anim-rise flex gap-2.5">
                <span className="mt-[6px] inline-block h-[7px] w-[7px] shrink-0 rounded-full" style={{ background: ACTIVITY_COLOR[a.kind] }} />
                <button
                  className="min-w-0 text-left text-[14px] leading-snug text-ink-2 hover:text-ink disabled:cursor-default disabled:hover:text-ink-2"
                  disabled={!a.nodeId || !state.nodes[a.nodeId]}
                  onClick={() => a.nodeId && actions.selectNode(a.nodeId)}
                >
                  {a.text}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="border-t border-line px-4 py-3 text-[13.5px] text-muted">Click any step in the graph to see what happened.</div>
    </div>
  );
}

function siteName(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname.includes("/demo-site") ? "Demo site" : u.host;
  } catch {
    return url;
  }
}
