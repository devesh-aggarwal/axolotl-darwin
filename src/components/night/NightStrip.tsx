"use client";
import { HOUR_MARKS, NIGHT_HOURS, OUTCOME_FILL, OUTCOME_LABEL, hourLabel, type RunMark, type SideKey } from "@/components/night/derive";

/** The night from 23:00 to 07:00 with one mark per run, filling in left to right as runs finish. */
export function NightStrip({ side, marks, total, running }: { side: SideKey; marks: RunMark[]; total: number; running: boolean }) {
  const gap = total <= 60 ? 2 : total <= 120 ? 1 : 0;
  const grid = { gridTemplateColumns: `repeat(${total}, minmax(0, 1fr))`, columnGap: gap };
  const slots = Array.from({ length: total }, (_, i) => marks[i]);
  const done = Math.min(marks.length, total);
  const counts = { usable: 0, failed: 0, corrupt: 0 };
  for (const m of marks) counts[m.outcome]++;
  const summary = `${counts.usable} usable, ${counts.failed} failed, ${counts.corrupt} finished but wrong, out of ${done} runs so far`;

  return (
    <div>
      <div className="relative">
        <div className="grid h-[3px]" style={grid} aria-hidden>
          {slots.map((m, i) =>
            m?.recoveries ? (
              <span
                key={`f${i}`}
                className="anim-regrow rounded-full"
                style={{ background: "var(--regrow)" }}
                title={`Run ${m.index}: a backup took over ${m.recoveries === 1 ? "once" : `${m.recoveries} times`}`}
              />
            ) : (
              <span key={`n${i}`} />
            ),
          )}
        </div>
        <div className="mt-[3px] grid h-[32px]" style={grid} role="img" aria-label={summary}>
          {slots.map((m, i) =>
            m ? (
              <span
                key={`r${i}`}
                className="anim-rise rounded-[2px]"
                style={{ background: OUTCOME_FILL[m.outcome] }}
                title={`Run ${m.index} · ${m.clock} · ${OUTCOME_LABEL[m.outcome]}${m.recoveries ? ` · fixed by a backup` : ""}`}
              />
            ) : (
              <span key={`e${i}`} className="rounded-[2px] bg-line" />
            ),
          )}
        </div>
        {running && done < total && (
          <span
            aria-hidden
            className="pointer-events-none absolute -bottom-1 top-[2px] w-px bg-ink transition-[left] duration-300 ease-out"
            style={{ left: `calc((100% + ${gap}px) * ${done / total} - ${gap / 2}px)` }}
          />
        )}
      </div>
      <div className="relative mt-2 h-[16px] text-[11px] text-muted tabular">
        {HOUR_MARKS.map((h) => (
          <span
            key={h}
            className={`absolute top-0 ${h === 0 ? "" : h === NIGHT_HOURS ? "-translate-x-full" : "-translate-x-1/2"}`}
            style={{ left: `${(h / NIGHT_HOURS) * 100}%` }}
          >
            {hourLabel(h)}
          </span>
        ))}
      </div>
      <Legend side={side} />
    </div>
  );
}

function Legend({ side }: { side: SideKey }) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-muted">
      <Key color={OUTCOME_FILL.usable}>Usable</Key>
      <Key color={OUTCOME_FILL.failed}>Failed</Key>
      <Key color={OUTCOME_FILL.corrupt}>Finished but wrong</Key>
      {side === "with" && (
        <Key color="var(--regrow)" bar>
          Fixed by a backup
        </Key>
      )}
    </div>
  );
}

function Key({ color, bar, children }: { color: string; bar?: boolean; children: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={bar ? "h-[3px] w-[10px] rounded-full" : "h-[10px] w-[6px] rounded-[2px]"} style={{ background: color }} />
      {children}
    </span>
  );
}
