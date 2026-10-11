// Run report (spec 6.7): prioritized fix plan, timeline of every failure and recovery,
// estimated human time saved.
import { DEFAULTS } from "@/config/workflow";
import { isDemoSite, measureRecall } from "@/lib/audit/groundTruth";
import { isInterruptedAttempt, type RunRecord } from "@/lib/engine/store";
import type { AttemptView, FixPlanOutput, MergeOutput, PrioritizedOutput, RunSummary } from "@/lib/types";

export interface TimelineEntry {
  at: number;
  nodeId: string;
  nodeLabel: string;
  kind: "start" | "hard_failure" | "silent_failure" | "recovered" | "passed" | "exhausted";
  agent: string;
  detail: string;
}

export interface RunReport {
  run: RunSummary;
  fixPlan: FixPlanOutput | null;
  prioritized: PrioritizedOutput | null;
  partialBranches: MergeOutput["partialBranches"];
  coverage: MergeOutput["coverage"];
  timeline: TimelineEntry[];
  recall: { found: number; expected: number; ratio: number; missing: { id: string; description: string }[] } | null;
  timeSaved: {
    manualAuditHours: number;
    recoveries: number;
    /** Each recovery is a morning rerun nobody had to do. */
    rerunsAvoided: number;
    totalHours: number;
  };
  bySeverity: Record<string, number>;
  byCategory: Record<string, number>;
}

const FAILURE_TEXT: Record<string, string> = {
  error: "The agent crashed",
  timeout: "The agent timed out",
  stall: "The agent stopped responding",
  auth_block: "The agent asked for a login during an unattended run",
  payment_block: "The agent asked for a payment during an unattended run",
  transport: "The connection to the agent dropped",
  killed: "The agent was stopped",
  verification: "The agent returned bad output",
};

/** Plain sentence for a failed attempt; the technical detail stays in the attempt record. */
function readableFailure(a: AttemptView): string {
  if (isInterruptedAttempt(a)) return "The run stopped while the agent was working; the step ran again on resume";
  const base = (a.failureType && FAILURE_TEXT[a.failureType]) || "The agent failed";
  if (a.failureType === "verification" && a.failureDetail) {
    const m = /Layer (\d) \(([^)]+)\)/.exec(a.failureDetail);
    const layer = m ? ({ 1: "format", 2: "sanity-rules", 3: "spot-check", 4: "review" } as Record<string, string>)[m[1]] : undefined;
    if (layer) return `${base}, caught by the ${layer.replace("-", " ")} check`;
  }
  return base;
}

export function buildReport(rec: RunRecord): RunReport {
  const byTemplate = (id: string) => rec.nodes.find((n) => n.templateId === id && !n.placeholder);
  const merge = byTemplate("merge")?.output as MergeOutput | undefined;
  const prioritized = (byTemplate("prioritize")?.output as PrioritizedOutput | undefined) ?? null;
  const fixPlan = (byTemplate("fixplan")?.output as FixPlanOutput | undefined) ?? null;
  const labels = new Map(rec.nodes.map((n) => [n.id, n.label]));

  const timeline: TimelineEntry[] = [];
  const byNode = new Map<string, AttemptView[]>();
  for (const a of rec.attempts) {
    const list = byNode.get(a.nodeId) ?? [];
    list.push(a);
    byNode.set(a.nodeId, list);
  }
  for (const [nodeId, attempts] of byNode) {
    const label = labels.get(nodeId) ?? nodeId;
    attempts.sort((x, y) => x.attemptNo - y.attemptNo);
    // Attempts cut off by a crash or cancel are not agent failures, so they don't make a pass a "recovery".
    let failures = 0;
    attempts.forEach((a) => {
      if (a.outcome === "hard_failure" || a.outcome === "silent_failure") {
        if (!isInterruptedAttempt(a)) failures++;
        timeline.push({
          at: a.finishedAt ?? a.startedAt,
          nodeId,
          nodeLabel: label,
          kind: a.outcome,
          agent: a.agent.name,
          detail: readableFailure(a),
        });
      } else if (a.outcome === "passed") {
        timeline.push({
          at: a.finishedAt ?? a.startedAt,
          nodeId,
          nodeLabel: label,
          kind: failures > 0 ? "recovered" : "passed",
          agent: a.agent.name,
          detail: failures > 0 ? `Recovered on attempt ${a.attemptNo} after ${failures} failure(s)` : "Passed all verification layers",
        });
      }
    });
    const node = rec.nodes.find((n) => n.id === nodeId);
    if (node?.state === "failed") {
      timeline.push({
        at: node.finishedAt ?? Date.now(),
        nodeId,
        nodeLabel: label,
        kind: "exhausted",
        agent: "—",
        detail: "Every pre-approved agent failed; branch marked partial",
      });
    }
  }
  timeline.sort((a, b) => a.at - b.at);

  const recoveries = rec.run.stats?.recoveries ?? timeline.filter((t) => t.kind === "recovered").length;
  const issues = prioritized?.issues ?? [];
  const bySeverity: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  for (const i of issues) {
    bySeverity[i.severity] = (bySeverity[i.severity] ?? 0) + 1;
    byCategory[i.category] = (byCategory[i.category] ?? 0) + 1;
  }

  let recall: RunReport["recall"] = null;
  if (prioritized && isDemoSite(rec.run.config.siteUrl)) {
    const r = measureRecall(rec.run.config.siteUrl, prioritized.issues);
    recall = { found: r.found, expected: r.expected, ratio: r.ratio, missing: r.missing.map((m) => ({ id: m.id, description: m.description })) };
  }

  const completed = rec.run.status === "completed" || rec.run.status === "partial";
  const manual = completed ? DEFAULTS.manualAuditHours : 0;
  // A recovered failure would otherwise have killed the run: someone reruns it in the morning (~1h each to notice, diagnose, restart).
  const rerunHours = recoveries * 1;
  return {
    run: rec.run,
    fixPlan,
    prioritized,
    partialBranches: merge?.partialBranches ?? [],
    coverage: merge?.coverage ?? [],
    timeline,
    recall,
    timeSaved: { manualAuditHours: manual, recoveries, rerunsAvoided: recoveries, totalHours: manual + rerunHours },
    bySeverity,
    byCategory,
  };
}
