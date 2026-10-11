"use client";
import type { NodeTemplate } from "@/config/workflow";
import type { AgentPool } from "@/lib/types";
import { POOL_STATUS_COLOR, POOL_STATUS_LABEL, poolHealth, stepName } from "./model";
import { Dot } from "./ui";

export interface RailEntry {
  template: NodeTemplate;
  pool: AgentPool | null;
  dirty: boolean;
}

interface Props {
  entries: RailEntry[];
  selectedId: string | undefined;
  onSelect: (id: string) => void;
}

/** Full step list for wide screens: one row per step with its primary agent and readiness. */
export function NodeRail({ entries, selectedId, onSelect }: Props) {
  const totals = entries.reduce(
    (acc, e) => {
      const h = poolHealth(e.pool);
      return { ready: acc.ready + h.ready, total: acc.total + h.total };
    },
    { ready: 0, total: 0 },
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="px-4 pb-2 pt-4">
        <div className="text-[13px] font-semibold text-ink">Workflow steps</div>
        <div className="mt-0.5 text-[12px] text-muted">
          {totals.total === 0 ? (
            "No agents set up yet"
          ) : (
            <>
              <span className="tabular">{totals.ready}</span> of <span className="tabular">{totals.total}</span> agents ready
            </>
          )}
        </div>
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-2" aria-label="Workflow steps">
        {entries.map(({ template: t, pool, dirty }) => {
          const h = poolHealth(pool);
          const primary = pool?.members.find((m) => m.role === "primary");
          const backups = pool ? pool.members.length - (primary ? 1 : 0) : 0;
          const selected = t.id === selectedId;
          return (
            <button
              key={t.id}
              onClick={() => onSelect(t.id)}
              aria-current={selected ? "true" : undefined}
              className={`mt-0.5 block w-full rounded-[6px] px-3 py-2.5 text-left transition-colors ${selected ? "bg-panel-2" : "hover:bg-panel"}`}
            >
              <div className="flex items-center gap-2">
                <span title={POOL_STATUS_LABEL[h.status]} className="flex">
                  <Dot color={POOL_STATUS_COLOR[h.status]} hollow={h.status === "none"} />
                </span>
                <span className={`min-w-0 truncate text-[13px] font-medium ${selected ? "text-ink" : "text-ink-2"}`}>{stepName(t)}</span>
                {dirty && <span className="ml-auto shrink-0 text-[11.5px] text-[var(--s-verifying)]">unsaved</span>}
              </div>
              <div className="mt-1 truncate pl-[15px] text-[12px] text-muted" title={primary?.name}>
                {primary ? primary.name : pool ? "No primary" : "Not set up"}
              </div>
              {pool && (
                <div className="mt-0.5 pl-[15px] text-[11.5px] text-faint">
                  {backups} backup{backups === 1 ? "" : "s"} · <span className="tabular">{h.ready}</span>/<span className="tabular">{h.total}</span> ready
                </div>
              )}
            </button>
          );
        })}
      </nav>
      <p className="px-4 pb-4 pt-3 text-[12px] leading-relaxed text-faint">
        Overnight runs only use these agents. A backup that takes over at 3am never needs a new approval.
      </p>
    </div>
  );
}

/** Compact step picker for narrow screens: one horizontal row that scrolls sideways if it must. */
export function NodeStrip({ entries, selectedId, onSelect }: Props) {
  return (
    <nav className="flex items-center gap-1 overflow-x-auto px-3 py-2" aria-label="Workflow steps">
      {entries.map(({ template: t, pool, dirty }) => {
        const h = poolHealth(pool);
        const selected = t.id === selectedId;
        return (
          <button
            key={t.id}
            onClick={() => onSelect(t.id)}
            aria-current={selected ? "true" : undefined}
            title={`${stepName(t)}: ${POOL_STATUS_LABEL[h.status]}${dirty ? ", unsaved changes" : ""}`}
            className={`flex h-8 shrink-0 items-center gap-2 whitespace-nowrap rounded-[6px] px-3 text-[13px] transition-colors ${
              selected ? "bg-panel font-medium text-ink shadow-[inset_0_0_0_1px_var(--line-strong)]" : "text-ink-2 hover:bg-panel"
            }`}
          >
            <Dot color={POOL_STATUS_COLOR[h.status]} hollow={h.status === "none"} />
            {stepName(t)}
            {dirty && <span className="text-[11.5px] font-normal text-[var(--s-verifying)]">unsaved</span>}
          </button>
        );
      })}
    </nav>
  );
}
