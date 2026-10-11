"use client";
import type { ButtonHTMLAttributes, ReactNode } from "react";

/** Numbered step heading. The number turns into a check once the step is done. */
export function StepHeading({ n, title, done, active, hint, right }: { n: number; title: string; done: boolean; active: boolean; hint?: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span
        aria-hidden
        className="mt-[1px] flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full text-[12px] font-medium tabular transition-colors"
        style={
          done
            ? { background: "color-mix(in srgb, var(--s-passed) 18%, transparent)", color: "var(--s-passed)" }
            : active
              ? { background: "var(--ink)", color: "var(--bg)" }
              : { boxShadow: "inset 0 0 0 1px var(--line-strong)", color: "var(--muted)" }
        }
      >
        {done ? <CheckGlyph /> : n}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-3">
          {/* relative keeps the sr-only prefix inside the scroll area instead of stretching the page */}
          <h3 className={`relative text-[14px] font-semibold ${done || active ? "text-ink" : "text-ink-2"}`}>
            <span className="sr-only">Step {n}: </span>
            {title}
          </h3>
          {right}
        </div>
        {hint && <div className="mt-1 text-[12.5px] leading-relaxed text-muted">{hint}</div>}
      </div>
    </div>
  );
}

export function CheckGlyph({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" aria-hidden>
      <path d="M2.5 6.4 5 8.8 9.6 3.4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Dot({ color, hollow }: { color: string; hollow?: boolean }) {
  return (
    <span
      aria-hidden
      className="inline-block h-[7px] w-[7px] shrink-0 rounded-full"
      style={hollow ? { boxShadow: `inset 0 0 0 1.5px ${color}` } : { background: color }}
    />
  );
}

/** Small plain status label: a dot and a word, no pill. */
export function StatusLabel({ color, label, title }: { color: string; label: string; title?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[12px]" style={{ color }} title={title}>
      <Dot color={color} />
      {label}
    </span>
  );
}

/** Two-state pick button used for Primary / Backup assignment. */
export function PickButton({ active, strong, className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { active: boolean; strong?: boolean }) {
  const look = active
    ? strong
      ? "bg-ink text-bg"
      : "bg-panel-2 text-ink shadow-[inset_0_0_0_1px_var(--line-strong)]"
    : "text-ink-2 shadow-[inset_0_0_0_1px_var(--line)] hover:text-ink hover:shadow-[inset_0_0_0_1px_var(--line-strong)]";
  return (
    <button
      {...props}
      aria-pressed={active}
      className={`h-7 whitespace-nowrap rounded-[5px] px-2.5 text-[12px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${look} ${className}`}
    />
  );
}

/** Explicit approval control. Rendered as a checkbox so the decision is a deliberate click. */
export function ApproveBox({ checked, onChange, name, label = "Approve now" }: { checked: boolean; onChange: (v: boolean) => void; name: string; label?: string }) {
  return (
    <button
      role="checkbox"
      aria-checked={checked}
      aria-label={`Approve ${name}`}
      onClick={() => onChange(!checked)}
      className="group inline-flex items-center gap-2 whitespace-nowrap text-[12.5px]"
    >
      <span
        className="flex h-[16px] w-[16px] items-center justify-center rounded-[4px] transition-colors"
        style={
          checked
            ? { background: "color-mix(in srgb, var(--s-passed) 20%, transparent)", boxShadow: "inset 0 0 0 1px var(--s-passed)", color: "var(--s-passed)" }
            : { boxShadow: "inset 0 0 0 1px var(--line-strong)", background: "var(--bg)" }
        }
      >
        {checked && <CheckGlyph size={10} />}
      </span>
      <span className={checked ? "text-ink-2" : "text-ink group-hover:text-ink"}>{checked ? "Approved" : label}</span>
    </button>
  );
}

export function TextButton({ className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className={`text-[12px] text-muted transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 ${className}`}
    />
  );
}
