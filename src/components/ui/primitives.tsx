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
  const sz = size === "sm" ? "h-7 px-2.5 text-[12.5px]" : "h-9 px-3.5 text-[13.5px]";
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
    <div className="flex items-center gap-2">
      {label && <span className="text-[12.5px] text-muted">{label}</span>}
      <div className="flex rounded-[8px] bg-panel-2 p-[3px]" role="radiogroup" aria-label={label}>
        {options.map((o) => (
          <button
            key={o.value}
            role="radio"
            aria-checked={value === o.value}
            title={o.title}
            disabled={disabled}
            onClick={() => onChange(o.value)}
            className={`h-7 rounded-[6px] px-2.5 text-[12.5px] transition-colors disabled:opacity-40 ${
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
      className="flex items-center gap-2 text-[13px] text-ink-2 hover:text-ink"
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
      className="inline-flex items-center gap-1 rounded-full px-2 py-[1px] text-[11.5px] font-medium"
      style={{ color, background: `color-mix(in srgb, ${color} 11%, transparent)` }}
    >
      {children}
    </span>
  );
}

export function SectionLabel({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-center justify-between px-4 pb-2 pt-4">
      <span className="text-[13px] font-medium text-ink">{children}</span>
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
      <div className="text-[14px] font-medium text-ink-2">{title}</div>
      {children && <div className="max-w-[340px] text-[13px] leading-relaxed text-muted">{children}</div>}
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

export function Stat({ label, value, color, hint }: { label: string; value: ReactNode; color?: string; hint?: string }) {
  return (
    <div title={hint}>
      <div className="text-[24px] font-semibold leading-none tracking-[-0.01em]" style={{ color: color ?? "var(--ink)" }}>
        {value}
      </div>
      <div className="mt-1.5 text-[12.5px] text-muted">{label}</div>
    </div>
  );
}

export function Details({ summary = "Details", children }: { summary?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button className="text-[12.5px] text-muted underline-offset-2 hover:text-ink hover:underline" onClick={() => setOpen((v) => !v)}>
        {open ? `Hide ${summary.toLowerCase()}` : summary}
      </button>
      {open && <div className="mt-2">{children}</div>}
    </div>
  );
}
