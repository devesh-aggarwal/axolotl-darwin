"use client";
import { NightStrip } from "@/components/night/NightStrip";
import { OUTCOME_FILL, SIDE_COLOR, fmtCount, percentColor, plural, usablePercent, type RunMark, type SideKey } from "@/components/night/derive";
import { useTween } from "@/components/night/useTween";
import { Stat } from "@/components/ui/primitives";
import type { TimelapseSide } from "@/lib/types";

const COPY: Record<SideKey, { title: string; detail: string }> = {
  without: { title: "Without Axolotl", detail: "One agent per step. Nobody checks its work." },
  with: { title: "With Axolotl", detail: "Every result is checked. Failures go to a backup." },
};

/**
 * One side of the night. `data` is the tick on screen; the percentage and "x of y" both come from
 * it, so they always agree. `hours` is the displayed (tweened) rework figure, shared with the headline.
 */
export function SidePanel({
  side,
  data,
  hours,
  marks,
  total,
  running,
}: {
  side: SideKey;
  data: TimelapseSide;
  hours: number;
  marks: RunMark[];
  total: number;
  running: boolean;
}) {
  const has = data.runs > 0;
  const pct = usablePercent(data);

  return (
    <section className="card @container flex min-w-0 flex-col p-5">
      <div className="flex items-center gap-2.5">
        <span className="h-[3px] w-4 rounded-full" style={{ background: SIDE_COLOR[side] }} aria-hidden />
        <h2 className="text-[15px] font-semibold text-ink">{COPY[side].title}</h2>
      </div>
      <p className="mt-1 text-[13px] leading-snug text-muted">{COPY[side].detail}</p>

      <div className="mt-5 grid grid-cols-2 items-end gap-x-6 gap-y-5 @min-[480px]:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <div className="col-span-2 @min-[480px]:col-span-1">
          <div
            className="flex items-baseline font-semibold leading-none tracking-[-0.03em] tabular"
            style={{ color: has ? percentColor(side, pct) : "var(--faint)" }}
            aria-label={has ? `${pct}% usable reports` : "No runs yet"}
          >
            <span className="text-[60px]">{has ? pct : "–"}</span>
            <span className="ml-0.5 text-[26px]">%</span>
          </div>
          <div className="mt-2 text-[13px] text-muted tabular">
            {has ? (
              <>
                <span className="font-medium text-ink-2">
                  {fmtCount(data.completed)} of {fmtCount(data.runs)}
                </span>{" "}
                reports usable
              </>
            ) : (
              "Waiting for the first run"
            )}
          </div>
        </div>
        <Stat label="Human interventions" hint="Runs someone has to notice and fix by hand in the morning" value={<Count value={data.humanInterventions} />} />
        <Stat label="Hours of rework" hint="Each failed run means redoing the audit by hand" value={<span className="tabular">{fmtCount(hours)}</span>} />
      </div>

      <Note side={side} data={data} />

      <div className="mt-5">
        <NightStrip side={side} marks={marks} total={total} running={running} />
      </div>
    </section>
  );
}

/** One plain sentence under the numbers: what went wrong unseen, or what Axolotl fixed. */
function Note({ side, data }: { side: SideKey; data: TimelapseSide }) {
  if (!data.runs) return <div className="mt-4 h-[19px]" aria-hidden />;
  const text =
    side === "without"
      ? data.silentlyCorrupt
        ? `${fmtCount(data.silentlyCorrupt)} ${plural(data.silentlyCorrupt, "run", "runs")} finished but ${plural(data.silentlyCorrupt, "was", "were")} wrong.`
        : "No run finished with a wrong report."
      : data.recoveries
        ? `A backup took over ${fmtCount(data.recoveries)} ${plural(data.recoveries, "time", "times")} when an agent failed.`
        : "No backup was needed.";
  const color = side === "without" ? (data.silentlyCorrupt ? OUTCOME_FILL.corrupt : undefined) : data.recoveries ? "var(--regrow)" : undefined;
  return (
    <p className="mt-4 flex items-center gap-2 text-[13px] leading-snug text-ink-2">
      {color && (
        <span
          className={side === "without" ? "h-[10px] w-[6px] shrink-0 rounded-[2px]" : "h-[3px] w-[10px] shrink-0 rounded-full"}
          style={{ background: color }}
          aria-hidden
        />
      )}
      {text}
    </p>
  );
}

function Count({ value }: { value: number }) {
  const shown = useTween(value, 600);
  return <span className="tabular">{fmtCount(shown)}</span>;
}
