"use client";
import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";

type Tone = "default" | "primary" | "danger" | "ghost" | "regrow";

const TONES: Record<Tone, string> = {
  default: "border-line-strong bg-panel text-ink hover:bg-panel-2",
  primary: "border-transparent bg-ink text-white hover:bg-ink-2",
  danger:
    "border-[color-mix(in_srgb,var(--s-failed)_35%,var(--line))] bg-panel text-[var(--s-failed)] hover:bg-[color-mix(in_srgb,var(--s-failed)_7%,var(--panel))]",
  ghost: "border-transparent bg-transparent text-ink-2 hover:bg-panel-2 hover:text-ink",
  regrow:
    "border-[color-mix(in_srgb,var(--regrow)_40%,var(--line))] bg-[var(--regrow-soft)] text-[var(--regrow)] hover:bg-[color-mix(in_srgb,var(--regrow)_14%,var(--panel))]",
};

export function Button({
  tone = "default",
  size = "md",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: Tone; size?: "sm" | "md" }) {
  const sz = size === "sm" ? "h-7 px-2.5 text-[13.5px]" : "h-9 px-3.5 text-[14.5px]";
  return (
    <button
      {...props}
      className={`inline-flex items-center justify-center gap-1.5 rounded-[8px] border font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${sz} ${TONES[tone]} ${className}`}
    />
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  disabled,
}: {
  value: T;
  options: { value: T; label: ReactNode; title?: string }[];
  onChange: (v: T) => void;
  label?: string;
  disabled?: boolean;
}) {
  return (
    <div className="flex min-w-0 max-w-full items-center gap-2">
      {label && <span className="shrink-0 text-[13.5px] text-muted">{label}</span>}
      <div className="no-scrollbar flex min-w-0 max-w-full overflow-x-auto rounded-[8px] bg-panel-2 p-[3px]" role="radiogroup" aria-label={label}>
        {options.map((o) => (
          <button
            key={o.value}
            role="radio"
            aria-checked={value === o.value}
            title={o.title}
            disabled={disabled}
            onClick={() => onChange(o.value)}
            className={`h-8 shrink-0 whitespace-nowrap rounded-[6px] px-2.5 text-[13.5px] transition-colors disabled:opacity-40 ${
              value === o.value ? "bg-panel font-medium text-ink shadow-[var(--shadow)]" : "text-muted hover:text-ink-2"
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  color = "var(--s-failed)",
  ariaLabel,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
  color?: string;
  ariaLabel?: string;
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={() => onChange(!checked)}
      className="flex min-h-9 items-center gap-2 text-[14px] text-ink-2 hover:text-ink"
    >
      <span className="relative h-[18px] w-[32px] rounded-full transition-colors" style={{ background: checked ? color : "var(--line-strong)" }}>
        <span className="absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white shadow-sm transition-all" style={{ left: checked ? 16 : 2 }} />
      </span>
      {label}
    </button>
  );
}

export function Chip({ color, children, title }: { color: string; children: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className="inline-flex items-center gap-1 rounded-full px-2 py-[1px] text-[12.5px] font-medium"
      style={{ color, background: `color-mix(in srgb, ${color} 11%, transparent)` }}
    >
      {children}
    </span>
  );
}

export function SectionLabel({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-center justify-between px-4 pb-2 pt-4">
      <span className="text-[14px] font-medium text-ink">{children}</span>
      {right}
    </div>
  );
}

export function Meter({ value, max = 1, color = "var(--s-passed)", width = 80 }: { value: number; max?: number; color?: string; width?: number }) {
  const pct = Math.max(0, Math.min(1, max ? value / max : 0));
  return (
    <span className="relative inline-block h-[6px] overflow-hidden rounded-full bg-panel-2" style={{ width }}>
      <span className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-500" style={{ width: `${pct * 100}%`, background: color }} />
    </span>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1.5 px-6 text-center">
      <div className="text-[15px] font-medium text-ink-2">{title}</div>
      {children && <div className="max-w-[340px] text-[14px] leading-relaxed text-muted">{children}</div>}
    </div>
  );
}

/** Number that eases toward its new value, starting from whatever is on screen. */
export function CountUp({ value, decimals = 0, suffix = "" }: { value: number; decimals?: number; suffix?: string }) {
  const [shown, setShown] = useState(value);
  const shownRef = useRef(value);
  useEffect(() => {
    const a = shownRef.current;
    const b = value;
    if (a === b) return;
    const start = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / 500);
      const v = a + (b - a) * (1 - Math.pow(1 - k, 3));
      shownRef.current = v;
      setShown(v);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return (
    <span className="tabular">
      {shown.toFixed(decimals)}
      {suffix}
    </span>
  );
}

/** A number with its label. "lg" is for the one figure a screen exists to answer. */
export function Stat({
  label,
  value,
  color,
  hint,
  size = "md",
}: {
  label: string;
  value: ReactNode;
  color?: string;
  hint?: string;
  size?: "md" | "lg" | "xl";
}) {
  const sz = size === "xl" ? "text-[40px]" : size === "lg" ? "text-[34px]" : "text-[24px]";
  return (
    <div title={hint}>
      <div className={`${sz} font-semibold leading-none tracking-[-0.02em] tabular`} style={{ color: color ?? "var(--ink)" }}>
        {value}
      </div>
      <div className="mt-1.5 text-[13.5px] leading-snug text-muted">{label}</div>
    </div>
  );
}

export function Details({ summary = "Details", children }: { summary?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button className="text-[13.5px] text-muted underline-offset-2 hover:text-ink hover:underline" onClick={() => setOpen((v) => !v)}>
        {open ? `Hide ${summary.toLowerCase()}` : summary}
      </button>
      {open && <div className="mt-2">{children}</div>}
    </div>
  );
}

export function CloseIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export type GlyphKind = "dot" | "check" | "cross" | "alert" | "dash" | "regrow";

/** One drawn icon set for outcomes, so status never relies on font glyphs. */
export function StatusGlyph({ kind, size = 14 }: { kind: GlyphKind; size?: number }) {
  const p = { fill: "none", stroke: "currentColor", strokeWidth: 1.9, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden className="shrink-0">
      {kind === "dot" && <circle cx="8" cy="8" r="3.5" fill="currentColor" />}
      {kind === "check" && <path d="M3.5 8.5l3 3 6-7" {...p} />}
      {kind === "cross" && <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" {...p} />}
      {kind === "alert" && <path d="M8 3.5v5.5M8 12.2v.3" {...p} />}
      {kind === "dash" && <path d="M4.5 8h7" {...p} />}
      {kind === "regrow" && (
        <>
          <path d="M3 13c0-5 3-8 8-8" {...p} />
          <path d="M8.5 2.5 11 5l-2.5 2.5" {...p} />
        </>
      )}
    </svg>
  );
}
