import { handle, ok } from "@/lib/api";
import { getAllStats, getScoreHistory, resetStats } from "@/lib/engine/stats";
import { publish } from "@/lib/events";
import { TEST_AGENTS } from "@/lib/testAgents/mcpServer";
import { resetTrust } from "@/lib/trust/store";

export const runtime = "nodejs";

// Direct agents are keyed "direct:<endpoint hash>:<tool>"; Axolotl's own test agents get flagged so the
// rankings don't pass them off as outside agents.
const TEST_TOOLS = new Set(TEST_AGENTS.map((a) => a.tool));
const isTestAgent = (agentId: string) => agentId.startsWith("direct:") && TEST_TOOLS.has(agentId.slice(agentId.lastIndexOf(":") + 1));

export const GET = handle(async () =>
  ok({ stats: getAllStats().map((s) => (isTestAgent(s.agentId) ? { ...s, testAgent: true } : s)), history: getScoreHistory(40) }),
);

export const DELETE = handle(async () => {
  resetStats();
  resetTrust();
  publish({ type: "stats_updated", at: Date.now() });
  return ok({ ok: true });
});
