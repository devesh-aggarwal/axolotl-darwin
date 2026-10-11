import { fail, handle, ok } from "@/lib/api";
import { getRunRecord } from "@/lib/engine/runtime";

export const runtime = "nodejs";

/** Full node detail for the inspector: output plus every attempt. */
export const GET = handle(async (_req: Request, ctx: { params: Promise<{ id: string; nodeId: string }> }) => {
  const { id, nodeId } = await ctx.params;
  const rec = getRunRecord(id);
  if (!rec) return fail(404, "Run not found");
  // Route params arrive decoded already.
  const node = rec.nodes.find((n) => n.id === nodeId);
  if (!node) return fail(404, "Node not found");
  return ok({ node, attempts: rec.attempts.filter((a) => a.nodeId === nodeId) });
});
