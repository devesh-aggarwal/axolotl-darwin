import { fail, handle, ok } from "@/lib/api";
import { stripNode } from "@/lib/engine/store";
import { getRunRecord } from "@/lib/engine/runtime";

export const runtime = "nodejs";

export const GET = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const rec = getRunRecord(id);
  if (!rec) return fail(404, "Run not found");
  return ok({ run: rec.run, nodes: rec.nodes.map(stripNode), attempts: rec.attempts });
});
