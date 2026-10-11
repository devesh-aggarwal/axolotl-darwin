"use client";
import { useAxolotl, type ActivityItem } from "@/components/store";
import { CountUp, Empty, Stat } from "@/components/ui/primitives";
import { useCopy } from "@/components/ui/copy";

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
  const lostBranch = nodes.some((n) => n.state === "failed" && Boolean(n.error));
  const humanNeeded = lostBranch || run.status === "failed" ? 1 : 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="px-4 pt-4">
        <div className="flex items-center gap-2">
          <span
            className={`inline-block h-[9px] w-[9px] rounded-full ${running ? "anim-pulse" : ""}`}
            style={{ background: STATUS_COLOR[run.status], ["--state" as string]: STATUS_COLOR[run.status] }}
          />
          <span className="text-[16px] font-semibold text-ink">{STATUS_TEXT[run.status] ?? run.status}</span>
        </div>
        <div className="mt-1 text-[12.5px] text-muted">
          {done === nodes.length && nodes.length > 0 ? `All ${nodes.length} steps done` : `${done} of ${nodes.length} steps done`} · {siteName(run.config.siteUrl)}
        </div>
        <div key={run.id} className="mt-5 grid grid-cols-3 gap-3">
          <Stat label="Problems found" value={issues === undefined ? "—" : <CountUp value={issues} />} />
          <Stat label={copy.recovered} value={<CountUp value={recoveries} />} color={recoveries ? "var(--regrow)" : undefined} />
          <Stat
            label="Human interventions"
            value={String(humanNeeded)}
            color={humanNeeded ? "var(--s-failed)" : "var(--s-passed)"}
            hint={humanNeeded ? "A step ran out of backups, so someone has to look at it" : undefined}
          />
        </div>
        {run.stats?.recall !== undefined && (
          <div className="mt-4 text-[12.5px] text-muted">
            Caught {Math.round(run.stats.recall * 100)}% of the problems we planted in the demo site.
          </div>
        )}
        {!running && (
          <button className="mt-3 text-[12.5px] font-medium text-[var(--focus)] hover:underline" onClick={() => actions.setTab("report")}>
            Open the report →
          </button>
        )}
      </div>
      <div className="mt-5 border-t border-line px-4 pt-4 text-[13px] font-medium text-ink">Activity</div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-2">
        {state.activity.length === 0 ? (
          <div className="text-[13px] text-muted">{running ? "Nothing has gone wrong yet." : "Nothing to report."}</div>
        ) : (
          <ul className="flex flex-col gap-2.5">
            {[...state.activity].reverse().map((a) => (
              <li key={a.id} className="anim-rise flex gap-2.5">
                <span className="mt-[6px] inline-block h-[7px] w-[7px] shrink-0 rounded-full" style={{ background: ACTIVITY_COLOR[a.kind] }} />
                <button
                  className="min-w-0 text-left text-[13px] leading-snug text-ink-2 hover:text-ink disabled:cursor-default disabled:hover:text-ink-2"
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
      <div className="border-t border-line px-4 py-3 text-[12.5px] text-muted">Click any step in the graph to see what happened.</div>
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
