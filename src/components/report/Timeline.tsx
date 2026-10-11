"use client";
import { useState } from "react";
import { Segmented } from "@/components/ui/primitives";
import type { RunReport, TimelineEntry } from "@/lib/engine/report";
import { fmtClock } from "@/components/ui/tokens";
import { TIMELINE_COLOR, TIMELINE_LABEL, isInterruption, listJoin, plural } from "@/components/report/format";
import { stepLabel } from "@/components/report/planText";

type Mode = "incidents" | "all";

const INCIDENT: TimelineEntry["kind"][] = ["hard_failure", "silent_failure", "recovered", "exhausted"];

function detailOf(e: TimelineEntry): string {
  switch (e.kind) {
    case "recovered":
      return `${e.agent} took over and passed verification`;
    case "passed":
      return `${e.agent} passed verification`;
    case "exhausted":
      return "Its findings are missing from this report";
    case "hard_failure":
      if (isInterruption(e)) return "The run stopped here, and this step ran again when it resumed";
    // falls through
    case "silent_failure": {
      // Drop machine error codes ("AGENT_RUNTIME_ERROR: …"); keep the readable part.
      const text = e.detail.replace(/^[A-Z][A-Z0-9_]{2,}:\s*/, "").trim();
      return text ? `${e.agent}: ${text}` : e.agent;
    }
    default:
      return e.detail;
  }
}

export function Timeline({ report }: { report: RunReport }) {
  const [mode, setMode] = useState<Mode>("incidents");
  const all = report.timeline;
  const incidents = all.filter((e) => INCIDENT.includes(e.kind) && !isInterruption(e));
  const failed = incidents.filter((e) => e.kind === "hard_failure" || e.kind === "silent_failure").length;
  const recovered = incidents.filter((e) => e.kind === "recovered").length;
  const lost = incidents.filter((e) => e.kind === "exhausted").length;
  const effective: Mode = incidents.length ? mode : "all";
  const entries = effective === "incidents" ? incidents : all;
  const run = report.run;

  const sentence = incidents.length
    ? `${listJoin(
        [plural(failed, "agent failure"), recovered ? `${recovered} recovered by a backup agent` : "", lost ? `${plural(lost, "check")} given up` : ""].filter(Boolean),
      )}.`
    : all.some(isInterruption)
      ? "No agent failed. The run was interrupted and picked up where it left off."
      : "No agent failed. Every step passed on its first try.";

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <p className="text-[14px] leading-relaxed text-ink-2">
          {sentence}{" "}
          <span className="text-muted">
            Started {fmtClock(run.createdAt)}
            {run.finishedAt ? `, finished ${fmtClock(run.finishedAt)}` : ", still running"}.
          </span>
        </p>
        {incidents.length > 0 && (
          <Segmented<Mode>
            value={mode}
            onChange={setMode}
            options={[
              { value: "incidents", label: "Failures and recoveries" },
              { value: "all", label: "Every step" },
            ]}
          />
        )}
      </div>

      {entries.length === 0 ? (
        <div className="py-10 text-center text-[13px] text-muted">Nothing has happened yet.</div>
      ) : (
        <ol className="mt-6">
          {entries.map((e, idx) => (
            <Entry key={`${e.nodeId}-${e.at}-${e.kind}-${idx}`} e={e} last={idx === entries.length - 1} />
          ))}
        </ol>
      )}
    </div>
  );
}

function Entry({ e, last }: { e: TimelineEntry; last: boolean }) {
  const color = TIMELINE_COLOR[e.kind];
  const quiet = e.kind === "passed" || e.kind === "start" || isInterruption(e);
  return (
    <li className="grid grid-cols-[88px_20px_minmax(0,1fr)] gap-x-3">
      <time className="pt-[1px] text-right text-[12.5px] tabular text-muted">{fmtClock(e.at)}</time>
      <span className="relative flex justify-center">
        {!last && <span className="absolute bottom-0 top-[14px] w-px bg-line" />}
        <span
          className={`relative mt-[5px] inline-block rounded-full ${quiet ? "h-[7px] w-[7px]" : "h-[11px] w-[11px]"}`}
          style={quiet ? { background: "var(--line-strong)" } : { background: color, boxShadow: e.kind === "recovered" ? "0 0 0 3px var(--regrow-soft)" : undefined }}
        />
      </span>
      <div className={quiet ? "pb-3" : "pb-6"}>
        <div className={`leading-snug ${quiet ? "text-[13px] text-muted" : "text-[14px]"}`}>
          {!quiet && (
            <span className="font-medium" style={{ color }}>
              {TIMELINE_LABEL[e.kind]}
            </span>
          )}
          {!quiet && <span className="text-muted"> · </span>}
          <span className={quiet ? "" : "text-ink"}>{stepLabel(e.nodeLabel)}</span>
        </div>
        <div className={`mt-0.5 leading-relaxed ${quiet ? "text-[12.5px] text-faint" : "text-[13px] text-muted"}`}>{detailOf(e)}</div>
      </div>
    </li>
  );
}
