import { handle, ok } from "@/lib/api";
import { getAllStats, getScoreHistory, resetStats } from "@/lib/engine/stats";
import { publish } from "@/lib/events";
import { resetTrust } from "@/lib/trust/store";

export const runtime = "nodejs";

export const GET = handle(async () => ok({ stats: getAllStats(), history: getScoreHistory(40) }));

export const DELETE = handle(async () => {
  resetStats();
  resetTrust();
  publish({ type: "stats_updated", at: Date.now() });
  return ok({ ok: true });
});
