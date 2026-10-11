"use client";
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { Button, Empty } from "@/components/ui/primitives";
import { SEVERITY_COLOR } from "@/components/ui/tokens";
import type { FixDraft, FixPlanOutput, PrioritizedIssue } from "@/lib/types";
import { SEV_LABEL, copyText, pageLabel } from "@/components/report/format";

const LANG_LABEL: Record<string, string> = {
  ts: "TypeScript",
  typescript: "TypeScript",
  js: "JavaScript",
  javascript: "JavaScript",
  html: "HTML",
  css: "CSS",
  diff: "Diff",
  json: "JSON",
  xml: "XML",
  txt: "Text",
  text: "Text",
  nginx: "nginx config",
  apache: "Apache config",
  sh: "Shell",
  bash: "Shell",
};

function langLabel(lang: string): string {
  return LANG_LABEL[lang.toLowerCase()] ?? lang;
}

function CopyButton({ text }: { text: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const onClick = async (e: ReactMouseEvent) => {
    e.stopPropagation();
    const ok = await copyText(text);
    setState(ok ? "copied" : "failed");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 1500);
  };
  return (
    <Button tone="ghost" size="sm" onClick={onClick} aria-live="polite" className="min-w-[76px]">
      <span style={state === "copied" ? { color: "var(--s-passed)" } : state === "failed" ? { color: "var(--s-failed)" } : undefined}>
        {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy"}
      </span>
    </Button>
  );
}

function lineColor(lang: string, line: string): string {
  if (lang === "diff") {
    if (line.startsWith("+")) return "var(--s-passed)";
    if (line.startsWith("-")) return "var(--s-failed)";
    if (line.startsWith("@@")) return "var(--muted)";
  }
  return "var(--ink-2)";
}

// Code is shown exactly as typed: no ligatures, so "<!--", "->" and "http://" don't merge into symbols.
const CODE_STYLE = { fontVariantLigatures: "none", fontFeatureSettings: '"liga" 0, "calt" 0' } as const;

/** A drafted patch with its language and a copy button. Monospace lives only here. */
export function CodeBlock({ patch, language }: { patch: string; language: string }) {
  const lines = patch.replace(/\n+$/, "").split("\n");
  const lang = language.toLowerCase();
  return (
    <div className="rounded-[8px] border border-line bg-panel-2">
      <div className="flex items-center justify-between py-1 pl-3.5 pr-1">
        <span className="text-[12px] text-muted">{langLabel(language)}</span>
        <CopyButton text={patch} />
      </div>
      {/* Long lines scroll sideways; the padding sits inside the scrolled box so nothing is cut at either edge. */}
      <div className="max-h-[360px] overflow-auto rounded-b-[8px]" style={{ scrollbarWidth: "thin" }}>
        <pre className="w-max min-w-full px-3.5 pb-4 pt-0.5 font-mono text-[12px] leading-[1.7]" style={CODE_STYLE}>
          {lines.map((line, idx) => (
            <div key={idx} style={{ color: lineColor(lang, line) }}>
              {line || " "}
            </div>
          ))}
        </pre>
      </div>
    </div>
  );
}

export function FixDrafts({ plan, issues, onOpenIssue }: { plan: FixPlanOutput | null; issues: PrioritizedIssue[]; onOpenIssue: (id: string) => void }) {
  if (!plan) return <Empty title="No drafted fixes">The fix-plan step did not finish for this run.</Empty>;
  if (!plan.topFixes.length) return <Empty title="No drafted fixes">Nothing in this run needed a code change.</Empty>;
  const byId = new Map(issues.map((i) => [i.id, i]));
  return (
    <div>
      <p className="max-w-[720px] text-[13px] leading-relaxed text-muted">
        Ready-to-review changes for the {plan.topFixes.length === 1 ? "top problem" : `top ${plan.topFixes.length} problems`}, in the order to fix them. They are
        drafts: check them before merging.
      </p>
      <ol className="mt-6 flex flex-col gap-10">
        {plan.topFixes.map((f, idx) => (
          <FixItem key={`${f.issueId}-${idx}`} fix={f} rank={idx + 1} issue={byId.get(f.issueId)} onOpenIssue={onOpenIssue} />
        ))}
      </ol>
    </div>
  );
}

function FixItem({ fix, rank, issue, onOpenIssue }: { fix: FixDraft; rank: number; issue?: PrioritizedIssue; onOpenIssue: (id: string) => void }) {
  return (
    <li className="flex gap-4">
      <span className="w-5 shrink-0 pt-[1px] text-right text-[15px] font-semibold tabular text-faint">{rank}</span>
      <div className="min-w-0 flex-1">
        <h3 className="text-[15px] font-medium leading-snug text-ink">{fix.title}</h3>
        {issue && (
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-muted">
            <span className="inline-flex items-center gap-1.5" style={{ color: SEVERITY_COLOR[issue.severity] }}>
              <span className="inline-block h-[7px] w-[7px] rounded-full" style={{ background: SEVERITY_COLOR[issue.severity] }} />
              {SEV_LABEL[issue.severity]}
            </span>
            <span>·</span>
            <span>{pageLabel(issue.pageUrl)}</span>
            <span>·</span>
            <button className="underline-offset-2 hover:text-ink-2 hover:underline" onClick={() => onOpenIssue(issue.id)}>
              See the problem
            </button>
          </div>
        )}
        <div className="mt-3">
          <CodeBlock patch={fix.patch} language={fix.language} />
        </div>
      </div>
    </li>
  );
}
