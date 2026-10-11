import { fail, handle, ok } from "@/lib/api";
import { cancelRun } from "@/lib/engine/runtime";

export const runtime = "nodejs";

export const POST = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  return cancelRun(id) ? ok({ ok: true }) : fail(409, "Run is not running");
});
