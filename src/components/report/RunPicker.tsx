"use client";
import { useEffect, useRef, useState } from "react";
import type { RunSummary } from "@/lib/types";
import { RUN_STATUS_COLOR, RUN_STATUS_LABEL, fmtDuration, fmtWhen, plural } from "@/components/report/format";
import { siteNameStart } from "@/components/report/planText";

function StatusDot({ run }: { run: RunSummary }) {
  const color = RUN_STATUS_COLOR[run.status];
  return (
    <span
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${run.status === "running" ? "anim-pulse" : ""}`}
      style={{ background: color, ["--state" as string]: color }}
    />
  );
}

function runLine(r: RunSummary): string {
  const parts = [siteNameStart(r.config.siteUrl)];
  if (r.status === "running") parts.push("in progress");
  else if (r.finishedAt) parts.push(`took ${fmtDuration(r.finishedAt - r.createdAt)}`);
  if (r.stats) parts.push(plural(r.stats.issuesFound, "problem"));
  return parts.join(" · ");
}

export function RunPicker({ runs, value, onChange }: { runs: RunSummary[]; value: string | null; onChange: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = runs.find((r) => r.id === value) ?? null;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex h-8 items-center gap-2 rounded-[8px] border border-line-strong bg-panel px-3 text-[13px] text-ink transition-colors hover:bg-panel-2"
      >
        {current ? (
          <>
            <StatusDot run={current} />
            <span className="tabular">{fmtWhen(current.createdAt)}</span>
            <span className="text-muted">{RUN_STATUS_LABEL[current.status]}</span>
            {current.config.baseline && <span className="text-muted">· without Axolotl</span>}
          </>
        ) : (
          <span className="text-muted">Choose a run</span>
        )}
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden className="ml-0.5 text-muted">
          <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
        </svg>
      </button>
      {open && (
        <div role="listbox" aria-label="Recent runs" className="card anim-rise absolute left-0 top-[calc(100%+6px)] z-30 w-[min(400px,calc(100vw-32px))] overflow-hidden py-1">
          <div className="max-h-[360px] overflow-y-auto">
            {runs.map((r) => {
              const selected = r.id === value;
              return (
                <button
                  key={r.id}
                  role="option"
                  aria-selected={selected}
                  onClick={() => {
                    onChange(r.id);
                    setOpen(false);
                  }}
                  className={`flex w-full items-start gap-3 px-3 py-2 text-left transition-colors ${selected ? "bg-panel-2" : "hover:bg-panel-2"}`}
                >
                  <span className="pt-[6px]">
                    <StatusDot run={r} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-3 text-[13px]">
                      <span className="tabular text-ink">
                        {fmtWhen(r.createdAt)}
                        {r.config.baseline && <span className="text-muted"> · without Axolotl</span>}
                      </span>
                      <span className="shrink-0 text-[12px]" style={{ color: RUN_STATUS_COLOR[r.status] }}>
                        {RUN_STATUS_LABEL[r.status]}
                      </span>
                    </span>
                    <span className="block truncate text-[12px] text-muted">{runLine(r)}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
