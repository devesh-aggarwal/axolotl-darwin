"use client";
// Small hand-rolled marks for the leaderboard rows: ticking score, reliability bar, sparkline.
import { PRIOR_SCORE, fmtScore, type HistoryPoint } from "@/components/evolution/leaderboard";
import { useTween } from "@/components/evolution/hooks";

/** Score as a whole percentage (same as the run inspector), easing toward new values. */
export function TickingScore({ value }: { value: number }) {
  const shown = useTween(value);
  return <span className="tabular text-[14px] font-medium text-ink">{fmtScore(shown)}</span>;
}

export function ReliabilityBar({ value, color, width = 64 }: { value: number; color: string; width?: number }) {
  const fill = Math.max(0, Math.min(1, value)) * 100;
  return (
    <span className="relative block h-[6px] overflow-hidden rounded-full bg-line" style={{ width }} aria-hidden>
      <span
        className="absolute inset-y-0 left-0 rounded-full"
        style={{ width: `${fill}%`, background: color, transition: "width 600ms cubic-bezier(0.2, 0.7, 0.1, 1), background-color 600ms" }}
      />
    </span>
  );
}

/** Score history on a fixed 0–100% scale so rows compare at a glance, with a hairline at the 50% starting score. */
export function Sparkline({ points, color, width = 64, height = 26 }: { points: HistoryPoint[]; color: string; width?: number; height?: number }) {
  const pad = 3;
  const series = points.length ? points : [{ at: 0, score: PRIOR_SCORE, attempts: 0 }];
  const n = series.length;
  const x = (i: number) => (n === 1 ? width - pad : pad + (i / (n - 1)) * (width - pad * 2));
  const y = (s: number) => pad + (1 - Math.max(0, Math.min(1, s))) * (height - pad * 2);
  const d = series.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(p.score).toFixed(1)}`).join(" ");
  const first = series[0];
  const last = series[n - 1];
  const label = n > 1 ? `Score ${fmtScore(first.score)} → ${fmtScore(last.score)} over ${last.attempts} attempts` : "No history yet";
  const baseline = Math.round(y(PRIOR_SCORE)) + 0.5;

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="block overflow-visible" role="img" aria-label={label}>
      <line x1={0} x2={width} y1={baseline} y2={baseline} stroke="var(--line)" strokeWidth={1} />
      {n > 1 && <path d={d} fill="none" stroke={color} strokeOpacity={0.75} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />}
      <circle cx={x(n - 1)} cy={y(last.score)} r={3} fill={color} stroke="var(--panel)" strokeWidth={1.5} />
    </svg>
  );
}
