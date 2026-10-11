"use client";
import { useEffect, useState } from "react";
import { useAxolotl } from "@/components/store";

/** Shows the latest error from a button press (e.g. "Too late: that step's output is already being checked"). */
export function Toasts() {
  const { state } = useAxolotl();
  const latest = [...state.alerts].reverse().find((a) => !a.runId && a.level === "error");
  const [now, setNow] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null);
  useEffect(() => {
    if (!latest) return;
    const tick = setInterval(() => setNow(Date.now()), 400);
    const stop = setTimeout(() => clearInterval(tick), 6000);
    return () => {
      clearInterval(tick);
      clearTimeout(stop);
    };
  }, [latest]);
  if (!latest || dismissed === latest.id || (now && now - latest.at > 4500)) return null;
  return (
    <div role="status" className="pointer-events-none fixed inset-x-0 bottom-5 z-50 flex justify-center px-4">
      <div className="card anim-rise pointer-events-auto flex max-w-[480px] items-start gap-3 px-4 py-3 text-[13px] text-ink">
        <span className="mt-[6px] inline-block h-[7px] w-[7px] shrink-0 rounded-full bg-[var(--s-failed)]" />
        <span className="leading-snug">{latest.message}</span>
        <button className="ml-1 text-[16px] leading-none text-muted hover:text-ink" onClick={() => setDismissed(latest.id)} aria-label="Dismiss">
          ×
        </button>
      </div>
    </div>
  );
}
