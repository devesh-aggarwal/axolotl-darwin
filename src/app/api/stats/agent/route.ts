// One agent's score on one step, with what it gets right and how it usually fails (Rankings agent panel).
import { fail, handle, ok } from "@/lib/api";
import { breakdownResults } from "@/lib/engine/resultBreakdown";
import { getAllStats, getResults } from "@/lib/engine/stats";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = handle(async (req: Request) => {
  const params = new URL(req.url).searchParams;
  const agentId = params.get("agentId");
  const capability = params.get("capability");
  if (!agentId || !capability) return fail(400, "agentId and capability are required");
  const stats = getAllStats().find((s) => s.agentId === agentId && s.capability === capability);
  if (!stats) return fail(404, "No results recorded for this agent on this step");
  return ok({ stats, breakdown: breakdownResults(stats.attempts, getResults(agentId, capability)) });
});
