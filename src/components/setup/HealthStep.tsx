"use client";
import type { CSSProperties } from "react";
import { Button } from "@/components/ui/primitives";
import { fmtClock } from "@/components/ui/tokens";
import type { AgentPool, AgentSource } from "@/lib/types";
import { SOURCE_LABEL, memberHealthView, memberKey, plainHealthDetail, poolHealth } from "./model";
import { StatusLabel, StepHeading } from "./ui";

export function HealthStep({
  client,
  pool,
  dirty,
  canSave,
  busy,
  error,
  onSave,
  onCheck,
  done,
  active,
}: {
  client: AgentSource;
  pool: AgentPool | null;
  dirty: boolean;
  canSave: boolean;
  busy: "save" | "check" | null;
  error: string | null;
  onSave: () => void;
  onCheck: () => void;
  done: boolean;
  active: boolean;
}) {
  const h = poolHealth(pool);
  const labels = roleLabels(pool);

  return (
    <div className="px-6 pb-8 pt-5 min-[1100px]:px-5">
      <StepHeading
        n={3}
        title="Check health"
        done={done}
        active={active}
        hint="Saving checks every agent right away. Overnight, only approved agents that pass are used."
      />

      <div className="mt-4 pl-[34px]">
        {dirty || !pool ? (
          <Button tone="primary" className="h-9 w-full" disabled={!canSave || busy !== null} onClick={onSave}>
            {busy === "save" ? "Saving and checking…" : "Save and check health"}
          </Button>
        ) : (
          <Button className="h-9 w-full" disabled={busy !== null} onClick={onCheck}>
            {busy === "check" ? "Checking…" : "Check health again"}
          </Button>
        )}
        {!canSave && (dirty || !pool) && <div className="mt-2 text-[12px] text-faint">Choose a primary agent first.</div>}
        {error && <div className="mt-2 text-[12.5px] text-[var(--s-failed)]">{error}</div>}
      </div>

      <div className="mt-6 flex items-baseline justify-between gap-3 pl-[34px]">
        <div className="text-[13px] font-medium text-ink-2">{dirty && pool ? "Currently saved" : "Saved agents"}</div>
        {pool && (
          <div className="text-[12px] text-muted">
            <span className="tabular" style={{ color: h.ready === h.total ? "var(--s-passed)" : undefined }}>
              {h.ready} of {h.total}
            </span>{" "}
            ready
          </div>
        )}
      </div>

      {!pool ? (
        <p className="mt-2 pl-[34px] text-[12.5px] text-muted">Nothing saved for {SOURCE_LABEL[client]} yet.</p>
      ) : (
        <div className="relative mt-2 pl-[22px] min-[1100px]:pl-0">
          {busy && <div className="scanbar" style={{ "--state": "var(--s-running)", top: 0, bottom: "auto" } as CSSProperties} />}
          <ul className="flex flex-col gap-1">
          {pool.members.map((m, i) => {
            const label = labels[i];
            const v = memberHealthView(m);
            return (
              <li
                key={`${memberKey(m)}:${pool.updatedAt}`}
                className="anim-rise rounded-[6px] px-3 py-2.5"
                style={{ animationDelay: `${i * 70}ms` }}
              >
                <div className="flex items-center gap-3">
                  <span className="w-[62px] shrink-0 text-[12.5px] text-muted">{label}</span>
                  <span className="min-w-0 flex-1 truncate text-[13px] text-ink" title={m.name}>
                    {m.name}
                  </span>
                  <StatusLabel color={v.color} label={v.label} title={v.title} />
                </div>
                <div className="mt-1 pl-[74px] text-[12px] leading-snug text-muted" title={m.healthDetail}>
                  {plainHealthDetail(m)}
                </div>
                <div className="mt-0.5 pl-[74px] text-[11.5px] text-faint">
                  {m.lastHealthCheck ? (
                    <>
                      Checked at <span className="tabular">{fmtClock(m.lastHealthCheck)}</span>
                    </>
                  ) : (
                    "Not checked yet"
                  )}
                </div>
              </li>
            );
          })}
          </ul>
        </div>
      )}
    </div>
  );
}

function roleLabels(pool: AgentPool | null): string[] {
  if (!pool) return [];
  let backups = 0;
  return pool.members.map((m) => (m.role === "primary" ? "Primary" : `Backup ${++backups}`));
}
