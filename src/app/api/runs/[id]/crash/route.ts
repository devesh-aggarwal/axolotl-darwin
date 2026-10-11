import { fail, handle, ok } from "@/lib/api";
import { crashRun } from "@/lib/engine/runtime";

export const runtime = "nodejs";

/** Simulates the worker process dying mid-run (for the crash-resume demo). */
export const POST = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  return crashRun(id) ? ok({ ok: true }) : fail(409, "Run is not running");
});
