"use client";
// First-sight trust check, as setup shows it: one score and verdict, three plain answers
// (is it safe, does it charge, is it accurate), and a trial button to measure accuracy.
import { useState } from "react";
import { api } from "@/components/api";
import type { TrustDimension, TrustLevel, TrustReport, TrustVerdict } from "@/lib/types";
import { Dot, StatusLabel, TextButton } from "./ui";

const LEVEL_COLOR: Record<TrustLevel, string> = {
  good: "var(--s-passed)",
  unknown: "var(--faint)",
  warn: "var(--s-verifying)",
  bad: "var(--s-failed)",
};

const VERDICT: Record<TrustVerdict, { label: string; color: string; title: string }> = {
  trusted: { label: "Trusted", color: "var(--s-passed)", title: "Safe, free, and proven accurate" },
  untested: { label: "Untested", color: "var(--muted)", title: "Nothing wrong found, but its accuracy hasn't been measured yet" },
  caution: { label: "Caution", color: "var(--s-verifying)", title: "Usable, but read what the check found" },
  avoid: { label: "Unsafe", color: "var(--s-failed)", title: "Failed the safety check: it can't join a pool" },
};

const WORDS: Record<TrustDimension, Record<TrustLevel, string>> = {
  safety: { good: "Safe", unknown: "Safety unknown", warn: "Safety concern", bad: "Unsafe" },
  cost: { good: "Free", unknown: "Cost unknown", warn: "Setup cost", bad: "Charges" },
  quality: { good: "Accurate", unknown: "Not tried", warn: "Mixed results", bad: "Inaccurate" },
};

const DIMENSIONS: TrustDimension[] = ["safety", "cost", "quality"];

export function TrustVerdictLabel({ trust }: { trust: TrustReport }) {
  const v = VERDICT[trust.verdict];
  const label = trust.verdict === "avoid" ? v.label : `${v.label} · ${trust.score}`;
  return <StatusLabel color={v.color} label={label} title={`${v.title}. Trust score ${trust.score} of 100.`} />;
}

/** The three answers in one line: a dot and a word each, the reason on hover. */
export function TrustLine({ trust }: { trust: TrustReport }) {
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[12px] text-muted">
      {DIMENSIONS.map((d) => {
        const view = trust[d];
        return (
          <span key={d} className="inline-flex items-center gap-1.5" title={view.summary}>
            <Dot color={LEVEL_COLOR[view.level]} hollow={view.level === "unknown"} />
            {WORDS[d][view.level]}
          </span>
        );
      })}
    </div>
  );
}

/** "Try it" runs one task on the demo site and returns the updated report. */
export function TrialButton({ templateId, agentId, trust, onTrust }: { templateId: string; agentId: string; trust: TrustReport; onTrust: (t: TrustReport) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (trust.verdict === "avoid") return null;
  const tried = Boolean(trust.trial);
  return (
    <span className="inline-flex items-center gap-2">
      <TextButton
        type="button"
        disabled={busy}
        title="Give it one task on the demo site, where every planted issue is known, and measure what it gets right"
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            onTrust((await api.trial(templateId, agentId)).trust);
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Trying it on the demo site…" : tried ? "Try again" : "Try it"}
      </TextButton>
      {error && <span className="text-[12px] text-[var(--s-failed)]">{error}</span>}
    </span>
  );
}

const SOURCE_WORD = { listing: "Listing", probe: "Trial", history: "Past runs" } as const;

/** Every finding, for the details disclosure. */
export function TrustSignals({ trust }: { trust: TrustReport }) {
  return (
    <ul className="flex flex-col gap-1">
      {trust.signals.map((s, i) => (
        <li key={i} className="flex items-start gap-2">
          <span className="flex h-[19px] shrink-0 items-center">
            <Dot color={LEVEL_COLOR[s.level]} hollow={s.level === "unknown"} />
          </span>
          <span>
            {s.text}
            <span className="text-faint"> · {SOURCE_WORD[s.source]}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
