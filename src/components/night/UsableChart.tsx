"use client";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis, type DotItemDotProps, type TooltipContentProps } from "recharts";
import { HOUR_MARKS, NIGHT_HOURS, SIDE_COLOR, fmtCount, nightClock } from "@/components/night/derive";
import type { TimelapseTick } from "@/lib/types";

interface Point {
  index: number;
  clock: string;
  runs: number;
  with: number;
  without: number;
}

type CountKey = "with" | "without";

const SERIES: { key: CountKey; name: string; color: string }[] = [
  { key: "without", name: "Without Axolotl", color: SIDE_COLOR.without },
  { key: "with", name: "With Axolotl", color: SIDE_COLOR.with },
];

const AXIS_TICK = { fill: "var(--muted)", fontSize: 11 };

/**
 * Usable reports so far, after each finished run. Counts instead of rates: a running rate swings
 * wildly over the first few runs, a count only ever grows. Same tick values as the cards.
 */
export function UsableChart({ ticks, total }: { ticks: TimelapseTick[]; total: number }) {
  const data: Point[] = ticks
    .filter((t) => t.index >= 1)
    .map((t) => ({ index: t.index, clock: t.clock, runs: t.with.runs, with: t.with.completed, without: t.without.completed }));
  const last = data.length ? data[data.length - 1] : undefined;
  const xTicks = HOUR_MARKS.map((h) => (h / NIGHT_HOURS) * total);
  const yTicks = [0, Math.round(total / 2), total];

  const endMark = (key: CountKey, name: string, color: string) =>
    function EndMark(p: DotItemDotProps) {
      if (!last || p.index !== data.length - 1 || p.cx === undefined || p.cy === undefined) return <g key={p.index} />;
      const mine = last[key];
      const other = last[key === "with" ? "without" : "with"];
      // When the two ends sit close together, the higher one labels above and the lower one below.
      const close = Math.abs(mine - other) < total * 0.1;
      const above = mine > other || (mine === other && key === "with");
      const dy = close ? (above ? -7 : 15) : 4;
      return (
        <g key={p.index}>
          <circle cx={p.cx} cy={p.cy} r={4} fill={color} stroke="var(--panel)" strokeWidth={2} />
          <text x={p.cx + 10} y={p.cy + dy} fontSize={12} fill="var(--ink-2)">
            {name}{" "}
            <tspan fill="var(--ink)" fontWeight={600}>
              {fmtCount(mine)}
            </tspan>
          </text>
        </g>
      );
    };

  return (
    <ResponsiveContainer width="100%" height="100%" minHeight={120}>
      <LineChart data={data} margin={{ top: 16, right: 140, bottom: 0, left: 0 }}>
        <CartesianGrid vertical={false} stroke="var(--line)" />
        <XAxis
          type="number"
          dataKey="index"
          domain={[0, total]}
          ticks={xTicks}
          interval={0}
          tickFormatter={(v: number) => nightClock(v, total)}
          tick={AXIS_TICK}
          tickLine={false}
          axisLine={{ stroke: "var(--line-strong)" }}
          tickMargin={8}
          height={28}
        />
        <YAxis domain={[0, total]} ticks={yTicks} allowDecimals={false} tick={AXIS_TICK} tickLine={false} axisLine={false} width={36} />
        <Tooltip content={ChartTip} cursor={{ stroke: "var(--line-strong)", strokeWidth: 1 }} isAnimationActive={false} />
        {SERIES.map((s) => (
          <Line
            key={s.key}
            type="monotoneX"
            dataKey={s.key}
            name={s.name}
            stroke={s.color}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            dot={endMark(s.key, s.name, s.color)}
            activeDot={{ r: 4, fill: s.color, stroke: "var(--panel)", strokeWidth: 2 }}
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

function ChartTip({ active, payload }: TooltipContentProps) {
  const p = active ? (payload?.[0]?.payload as Point | undefined) : undefined;
  if (!p) return null;
  return (
    <div className="card px-3 py-2 text-[12.5px]">
      <div className="mb-1 text-muted">
        Run {p.index} · {p.clock}
      </div>
      {[...SERIES].reverse().map((s) => (
        <div key={s.key} className="flex items-center gap-2">
          <span className="h-[2px] w-3 rounded-full" style={{ background: s.color }} />
          <span className="text-ink-2">
            {s.name}: <span className="font-semibold text-ink tabular">{fmtCount(p[s.key])}</span> of {fmtCount(p.runs)} usable
          </span>
        </div>
      ))}
    </div>
  );
}
