"use client";
import { useEffect, useState } from "react";
import { useAxolotl } from "@/components/store";
import { CloseIcon } from "@/components/ui/primitives";

// Long enough to read a two-line error; it can always be dismissed sooner.
const SHOW_MS = 9000;

/** Shows the latest error from a button press (e.g. "Too late: that step's output is already being checked"). */
export function Toasts() {
  const { state } = useAxolotl();
  const latest = [...state.alerts].reverse().find((a) => !a.runId && a.level === "error");
  const [now, setNow] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null);
  useEffect(() => {
    if (!latest) return;
    const tick = setInterval(() => setNow(Date.now()), 400);
    const stop = setTimeout(() => clearInterval(tick), SHOW_MS + 1000);
    return () => {
      clearInterval(tick);
      clearTimeout(stop);
    };
  }, [latest]);
  if (!latest || dismissed === latest.id || (now && now - latest.at > SHOW_MS)) return null;
  return (
    <div role="status" className="pointer-events-none fixed inset-x-0 bottom-5 z-50 flex justify-center px-4">
      <div className="card anim-rise pointer-events-auto flex max-w-[480px] items-start gap-3 px-4 py-3 text-[14px] text-ink">
        <span className="mt-[6px] inline-block h-[7px] w-[7px] shrink-0 rounded-full bg-[var(--s-failed)]" />
        <span className="leading-snug">{latest.message}</span>
        <button
          className="-mr-1 ml-1 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px] text-muted hover:bg-panel-2 hover:text-ink"
          onClick={() => setDismissed(latest.id)}
          aria-label="Dismiss"
        >
          <CloseIcon />
        </button>
      </div>
    </div>
  );
}
