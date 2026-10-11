"use client";
// Rankings agent panel: one agent on one step, what it gets right and how it usually fails.
// Opens from a leaderboard row.
import { useEffect, useRef, useState } from "react";
import { api } from "@/components/api";
import { fmtScore } from "@/components/evolution/leaderboard";
import { CloseIcon, StatusGlyph } from "@/components/ui/primitives";
import { FAILURE_LABEL, fmtClock, fmtMs } from "@/components/ui/tokens";
import type { ResultBreakdown } from "@/lib/engine/resultBreakdown";
import type { AgentStats } from "@/lib/types";

export interface AgentDetailTarget {
  agentId: string;
  capability: string;
  name: string;
  /** Where its results come from ("Map service", "Darwin", ...), as the row says. */
  sourceLabel: string;
}

/** Time today, date and time before that. */
function fmtWhen(at: number): string {
  const d = new Date(at);
  if (d.toDateString() === new Date().toDateString()) return fmtClock(at);
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

const pct = (n: number, of: number) => (of ? Math.round((n / of) * 100) : 0);

export function AgentDetail({ target, version, onClose }: { target: AgentDetailTarget; version: number; onClose: () => void }) {
  const [data, setData] = useState<{ stats: AgentStats; breakdown: ResultBreakdown } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // Refetch when the agent changes or new results land while the panel is open.
  useEffect(() => {
    let live = true;
    api
      .agentStats(target.agentId, target.capability)
      .then((d) => live && (setData(d), setError(null)))
      .catch((err) => live && setError((err as Error).message));
    return () => {
      live = false;
    };
  }, [target.agentId, target.capability, version]);

  // Focus moves into the panel and back to the row that opened it.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      opener?.focus();
    };
  }, [onClose]);

  const s = data?.stats;
  const b = data?.breakdown;
  const failures = s ? s.attempts - s.successes : 0;

  return (
    <div className="fixed inset-0 z-30">
      <div className="absolute inset-0 bg-[color-mix(in_srgb,var(--ink)_18%,transparent)]" onClick={onClose} aria-hidden />
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-detail-title"
        className="absolute inset-y-0 right-0 flex w-[min(440px,92vw)] flex-col border-l border-line bg-panel shadow-[var(--shadow-panel)]"
      >
        <header className="flex items-start gap-3 border-b border-line px-5 pb-4 pt-5">
          <div className="min-w-0 flex-1">
            <h2 id="agent-detail-title" className="break-words text-[18px] font-semibold leading-snug tracking-[-0.02em] text-ink">
              {target.name}
            </h2>
          </div>
          <button
            ref={closeRef}
            onClick={onClose}
            aria-label="Close"
            className="-mr-1.5 -mt-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] text-muted hover:bg-panel-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-[var(--ink-2)]"
          >
            <CloseIcon />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {error ? (
            <p className="text-[13.5px] text-failed">Couldn&rsquo;t load this agent: {error}</p>
          ) : !s || !b ? (
            <p className="text-[13.5px] text-muted">Loading…</p>
          ) : (
            <>
              <p className="tabular text-[14px] text-ink-2">
                Passed {s.successes} of {s.attempts} {s.attempts === 1 ? "check" : "checks"} · {fmtScore(s.score)} score
                {s.avgLatencyMs > 0 && ` · avg ${fmtMs(s.avgLatencyMs)}`}
              </p>
              <div className="mt-2.5 flex h-[6px] overflow-hidden rounded-full bg-panel-2" aria-hidden>
                <div className="h-full bg-[var(--s-passed)]" style={{ width: `${pct(s.successes, s.attempts)}%` }} />
                <div className="h-full bg-[var(--s-failed)]" style={{ width: `${pct(failures, s.attempts)}%` }} />
              </div>

              <section className="mt-6" aria-labelledby="agent-wins">
                <h3 id="agent-wins" className="flex items-baseline justify-between gap-3 text-[14px] font-semibold text-ink">
                  What it gets right
                  <span className="tabular text-[13px] font-normal text-muted">{s.successes} passed</span>
                </h3>
                {s.successes === 0 ? (
                  <p className="mt-1.5 text-[13.5px] text-muted">No answer has passed Axolotl&rsquo;s checks yet.</p>
                ) : b.wins.recent.length === 0 ? (
                  <p className="mt-1.5 text-[13.5px] text-muted">Passed {s.successes} {s.successes === 1 ? "time" : "times"}, all before results were written down. New passes will show here.</p>
                ) : (
                  <ul className="mt-2.5 flex flex-col gap-2">
                    {b.wins.recent.map((w, i) => (
                      <li key={`${w.at}-${i}`} className="flex gap-2 text-[13.5px] leading-snug text-ink-2">
                        <span className="mt-[2px] text-[var(--s-passed)]">
                          <StatusGlyph kind="check" />
                        </span>
                        <span className="min-w-0">
                          {w.note}
                          <span className="tabular ml-1.5 text-[12.5px] text-muted">{fmtWhen(w.at)}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="mt-6" aria-labelledby="agent-losses">
                <h3 id="agent-losses" className="flex items-baseline justify-between gap-3 text-[14px] font-semibold text-ink">
                  How it fails
                  <span className="tabular text-[13px] font-normal text-muted">
                    {failures} {failures === 1 ? "failure" : "failures"}
                  </span>
                </h3>
                {failures === 0 ? (
                  <p className="mt-1.5 text-[13.5px] text-muted">No failures yet.</p>
                ) : b.losses.groups.length === 0 ? (
                  <p className="mt-1.5 text-[13.5px] text-muted">These failures came before results were written down. New failures will show here.</p>
                ) : (
                  <ul className="mt-3 flex flex-col gap-5">
                    {b.losses.groups.map((g) => (
                      <li key={g.failureType}>
                        <div className="flex items-baseline justify-between gap-3">
                          <span className="text-[14px] font-medium text-ink">{FAILURE_LABEL[g.failureType] ?? g.failureType}</span>
                          <span className="tabular text-[13px] text-muted">
                            {g.count} of {b.losses.recorded} · {pct(g.count, b.losses.recorded)}%
                          </span>
                        </div>
                        <div className="mt-1.5 h-[6px] overflow-hidden rounded-full bg-panel-2" aria-hidden>
                          <div className="h-full rounded-full bg-[var(--s-failed)]" style={{ width: `${pct(g.count, b.losses.recorded)}%` }} />
                        </div>
                        <ul className="mt-2.5 flex flex-col gap-2">
                          {g.patterns.map((p) => (
                            <li key={p.pattern} className="flex gap-2 text-[13.5px] leading-snug text-ink-2" title={p.example}>
                              <span className="mt-[2px] text-[var(--s-failed)]">
                                <StatusGlyph kind="cross" />
                              </span>
                              <span className="min-w-0">
                                {p.count > 1 && <span className="tabular mr-1.5 text-muted">{p.count}×</span>}
                                {p.count > 1 ? p.pattern : p.example}
                                <span className="tabular ml-1.5 text-[12.5px] text-muted">last {fmtWhen(p.lastAt)}</span>
                              </span>
                            </li>
                          ))}
                        </ul>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {b.unrecorded > 0 && b.wins.recent.length + b.losses.groups.length > 0 && (
                <p className="mt-6 text-[13px] text-muted">
                  {b.unrecorded} older {b.unrecorded === 1 ? "result has" : "results have"} a score but no written result.
                </p>
              )}
            </>
          )}
        </div>
      </aside>
    </div>
  );
}
