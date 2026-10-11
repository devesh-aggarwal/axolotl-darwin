// Steps Axolotl runs itself: merge (partial-tolerant), prioritize (dedupe + rank), fix plan.
import { RULES } from "@/lib/audit/rules";
import type { RunLlmBudget } from "@/lib/llm/gateway";
import { buildFixPlan } from "@/lib/llm/fixplan";
import type {
  AuditOutput,
  FixPlanOutput,
  Issue,
  MergeOutput,
  NodeView,
  PrioritizedIssue,
  PrioritizedOutput,
  Severity,
} from "@/lib/types";

/** Issue as carried through merge, tagged with the agent that reported it. */
export type TaggedIssue = Issue & { reporter?: string };

export function runMerge(auditNodes: NodeView[]): MergeOutput {
  const issues: TaggedIssue[] = [];
  const partialBranches: MergeOutput["partialBranches"] = [];
  const coverage: MergeOutput["coverage"] = [];
  for (const n of auditNodes) {
    const out = n.output as AuditOutput | undefined;
    const passed = n.state === "passed" && Boolean(out);
    if (!passed) partialBranches.push({ nodeId: n.id, label: n.label });
    const found = passed ? out!.issues : [];
    for (const i of found) issues.push({ ...i, reporter: n.currentAgent?.name });
    coverage.push({ nodeId: n.id, label: n.label, passed, issueCount: found.length });
  }
  return { issues, partialBranches, coverage };
}

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const EFFORT_RANK = { small: 0, medium: 1, large: 2 } as const;

function normUrl(u: string): string {
  try {
    const url = new URL(u);
    url.hash = "";
    url.search = "";
    return url.toString().replace(/index\.html$/, "");
  } catch {
    return u;
  }
}

function dedupeKey(i: Issue): string {
  const scope = RULES[i.rule]?.scope ?? "page";
  const sel = (i.selector ?? "").trim().toLowerCase();
  return scope === "site" ? `${i.rule}` : `${i.rule}|${normUrl(i.pageUrl)}|${sel}`;
}

export function runPrioritize(merge: MergeOutput): PrioritizedOutput {
  const groups = new Map<string, { best: TaggedIssue; count: number; reporters: Set<string> }>();
  for (const raw of merge.issues as TaggedIssue[]) {
    const k = dedupeKey(raw);
    const g = groups.get(k);
    if (!g) {
      groups.set(k, { best: raw, count: 1, reporters: new Set(raw.reporter ? [raw.reporter] : []) });
      continue;
    }
    g.count++;
    if (raw.reporter) g.reporters.add(raw.reporter);
    if (SEVERITY_RANK[raw.severity] < SEVERITY_RANK[g.best.severity]) g.best = raw;
  }
  const ranked = [...groups.values()].sort((a, b) => {
    const s = SEVERITY_RANK[a.best.severity] - SEVERITY_RANK[b.best.severity];
    if (s) return s;
    const ea = EFFORT_RANK[RULES[a.best.rule]?.effort ?? "medium"];
    const eb = EFFORT_RANK[RULES[b.best.rule]?.effort ?? "medium"];
    return ea - eb || b.count - a.count || a.best.pageUrl.localeCompare(b.best.pageUrl);
  });
  const issues: PrioritizedIssue[] = ranked.map((g, idx) => {
    const { reporter: _reporter, ...issue } = g.best;
    return {
      ...issue,
      id: `ISS-${String(idx + 1).padStart(3, "0")}`,
      priority: idx + 1,
      effort: RULES[issue.rule]?.effort ?? "medium",
      duplicates: g.count,
      reportedBy: [...g.reporters],
    };
  });
  return { issues, dedupedFrom: merge.issues.length };
}

export async function runFixPlan(args: {
  prioritized: PrioritizedOutput;
  siteUrl: string;
  partialBranches: MergeOutput["partialBranches"];
  llmMode: "mock" | "live";
  budget?: RunLlmBudget;
}): Promise<FixPlanOutput> {
  return buildFixPlan(args);
}
