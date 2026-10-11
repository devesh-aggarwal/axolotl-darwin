"use client";
import { useState, type ReactNode } from "react";
import { CountUp, StatusGlyph } from "@/components/ui/primitives";
import { SEVERITY_COLOR, fmtCents } from "@/components/ui/tokens";
import type { RunReport } from "@/lib/engine/report";
import { SEVERITIES } from "@/lib/types";
import { fmtDuration, fmtHours, fmtWhen, listJoin, plural } from "@/components/report/format";
import { planHeadline, planSummary, siteName, stepLabel } from "@/components/report/planText";
import { useCopy } from "@/components/ui/copy";

/**
 * Headline and summary. Built-in plans are worded from the run's data, so older runs read the same
 * as new ones; the partial-check note below the numbers covers missing checks, so the summary skips them.
 */
function wording(report: RunReport): { headline: string; summary: string } {
  const plan = report.fixPlan;
  const run = report.run;
  const prioritized = report.prioritized;
  const issues = prioritized?.issues ?? [];
  const siteUrl = run.config.siteUrl;
  if (plan?.source === "template" && prioritized) {
    return {
      headline: planHeadline(issues, siteUrl, report.partialBranches.length),
      summary: planSummary({ issues, dedupedFrom: prioritized.dedupedFrom, siteUrl, fixCount: plan.topFixes.length, partial: [] }),
    };
  }
  if (plan) return { headline: plan.headline, summary: plan.summary };
  return {
    headline: `${plural(issues.length, "problem")} found on ${siteName(siteUrl)}`,
    summary: !prioritized
      ? ""
      : run.status === "running"
        ? "Still running. The summary and drafted fixes appear when the fix-plan step finishes; the problems below are already ranked."
        : "The fix-plan step did not finish, so there are no drafted fixes. The problems below are still ranked by what to fix first.",
  };
}

export function ReportHeader({ report, onShowTimeline }: { report: RunReport; onShowTimeline: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const plan = report.fixPlan;
  const run = report.run;
  const { headline, summary } = wording(report);
  const long = summary.length > 280;
  const meta = [
    `Audit of ${siteName(run.config.siteUrl)}`,
    run.finishedAt ? `finished ${fmtWhen(run.finishedAt).replace(/^(Today|Yesterday)/, (m) => m.toLowerCase())}` : "in progress",
    run.finishedAt ? `took ${fmtDuration(run.finishedAt - run.createdAt)}` : "",
    run.stats?.spentCents ? `spent ${fmtCents(run.stats.spentCents)} on paid agents` : "",
    plan ? (plan.source === "llm" ? "Written by GPT" : "Written by Axolotl") : "",
  ].filter(Boolean);

  const stuck = report.partialBranches.length || (run.status === "failed" ? 1 : 0);
  const finished = Boolean(run.finishedAt);
  return (
    <header>
      <div className="text-[13.5px] text-muted">{meta.join(" · ")}</div>
      {finished && (
        <div
          className="mt-3 inline-flex items-center gap-2 rounded-full px-3 py-1 text-[14.5px] font-semibold"
          style={{
            color: stuck ? "var(--s-failed)" : "var(--s-passed)",
            background: `color-mix(in srgb, ${stuck ? "var(--s-failed)" : "var(--s-passed)"} 9%, var(--panel))`,
          }}
        >
          <StatusGlyph kind={stuck ? "alert" : "check"} />
          {stuck ? `${stuck} ${stuck === 1 ? "step needs" : "steps need"} you` : "Nothing needs you"}
        </div>
      )}
      <h1 className="mt-3 max-w-[860px] text-balance text-[28px] font-semibold leading-[1.2] tracking-[-0.02em] text-ink">{headline}</h1>
      {summary && (
        <div className="mt-2.5 max-w-[760px]">
          <p className={`text-[15px] leading-relaxed text-ink-2 ${long && !expanded ? "line-clamp-3" : ""}`}>{summary}</p>
          {long && (
            <button className="mt-1 text-[13.5px] text-muted underline-offset-2 hover:text-ink hover:underline" onClick={() => setExpanded((v) => !v)}>
              {expanded ? "Show less" : "Read more"}
            </button>
          )}
        </div>
      )}
      <BigNumbers report={report} onShowTimeline={onShowTimeline} />
      {report.partialBranches.length > 0 && <PartialNote report={report} />}
    </header>
  );
}

function Stat({ label, value, color, children }: { label: string; value: ReactNode; color?: string; children?: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[14px] text-muted">{label}</div>
      <div className="mt-2 text-[36px] font-semibold leading-none tracking-[-0.02em] tabular" style={{ color: color ?? "var(--ink)" }}>
        {value}
      </div>
      {children && <div className="mt-2.5 text-[13.5px] leading-relaxed text-muted">{children}</div>}
    </div>
  );
}

function failureSentence(hard: number, silent: number): string {
  if (!hard && !silent) return "No agent failed during this run.";
  if (!silent) return `${plural(hard, "agent", "agents")} crashed, timed out or stalled along the way.`;
  if (!hard) return `${plural(silent, "agent", "agents")} returned bad output, and verification caught it.`;
  return `${plural(hard + silent, "agent failure")} along the way: ${hard} crashed or stalled, ${silent} returned bad output.`;
}

function BigNumbers({ report, onShowTimeline }: { report: RunReport; onShowTimeline: () => void }) {
  const copy = useCopy();
  const stats = report.run.stats;
  const total = report.prioritized ? report.prioritized.issues.length : (stats?.issuesFound ?? 0);
  const sev = SEVERITIES.map((s) => ({ s, n: report.bySeverity[s] ?? 0 })).filter(({ n }) => n > 0);
  const hard = stats?.hardFailures ?? report.timeline.filter((t) => t.kind === "hard_failure").length;
  const silent = stats?.silentFailures ?? report.timeline.filter((t) => t.kind === "silent_failure").length;
  const recoveries = report.timeSaved.recoveries;
  const human = stats?.humanInterventions ?? 0;
  // A step where every agent failed needs someone to look at it, same as the run summary says.
  const stuck = report.partialBranches.length;
  const ts = report.timeSaved;
  const recall = report.recall;

  return (
    <div className="mt-8 grid grid-cols-1 gap-x-10 sm:grid-cols-3 gap-y-6 border-t border-line pt-6">
      <Stat label="Problems found" value={<CountUp value={total} />}>
        {sev.length > 0 && (
          <span className="flex flex-wrap gap-x-3 gap-y-0.5">
            {sev.map(({ s, n }) => (
              <span key={s} className="inline-flex items-center gap-1.5">
                <span className="inline-block h-[7px] w-[7px] rounded-full" style={{ background: SEVERITY_COLOR[s] }} />
                {n} {s}
              </span>
            ))}
          </span>
        )}
        {recall && (
          <span className="mt-1 block" title={recall.missing.length ? `Missed: ${recall.missing.map((m) => m.description).join("; ")}` : undefined}>
            Found{" "}
            <span className="font-medium" style={{ color: recall.found >= recall.expected ? "var(--s-passed)" : "var(--s-verifying)" }}>
              {recall.found} of {recall.expected}
            </span>{" "}
            planted issues on the demo site
            {report.run.config.client === "mock" ? ", using simulated agents." : "."}
          </span>
        )}
      </Stat>
      <Stat label={copy.recovered === "Failures recovered" ? "Failures recovered automatically" : copy.recovered} value={<CountUp value={recoveries} />} color={recoveries ? "var(--regrow)" : undefined}>
        {failureSentence(hard, silent)}{" "}
        {stuck ? `${plural(stuck, "step")} needed a person.` : human ? `${plural(human, "manual intervention")}.` : "Nobody had to step in."}
        {hard + silent > 0 && (
          <>
            {" "}
            <button className="underline underline-offset-2 hover:text-ink" onClick={onShowTimeline}>
              See what happened
            </button>
          </>
        )}
      </Stat>
      <Stat label="Hours saved (estimate)" value={<CountUp value={ts.totalHours} decimals={Number.isInteger(ts.totalHours) ? 0 : 1} suffix=" h" />}>
        Assumes {fmtHours(ts.manualAuditHours)} h for the same audit done by hand
        {ts.rerunsAvoided > 0 ? `, plus ${plural(ts.rerunsAvoided, "rerun")} nobody had to start in the morning` : ""}.
      </Stat>
    </div>
  );
}

function PartialNote({ report }: { report: RunReport }) {
  const lost = report.partialBranches;
  return (
    <div className="mt-6 flex gap-3 rounded-[10px] bg-[color-mix(in_srgb,var(--s-partial)_8%,var(--panel))] px-4 py-3 text-[14.5px] leading-relaxed text-ink-2">
      <span className="mt-[4px] text-[var(--s-partial)]">
        <StatusGlyph kind="alert" />
      </span>
      <p>
      <span className="font-medium text-ink">
        {lost.length === 1 ? "1 check didn't finish" : `${lost.length} checks didn't finish`}: {listJoin(lost.map((b) => stepLabel(b.label)))}.
      </span>{" "}
      Every agent Axolotl found failed on {lost.length === 1 ? "it" : "them"}, so {lost.length === 1 ? "its" : "their"} findings are missing. Everything else in this report is
      complete.
      </p>
    </div>
  );
}
