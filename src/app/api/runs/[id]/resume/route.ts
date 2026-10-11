import { fail, handle, ok } from "@/lib/api";
import { resumeRun, RunNotFoundError } from "@/lib/engine/runtime";

export const runtime = "nodejs";

export const POST = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  try {
    return ok({ run: resumeRun(id) });
  } catch (err) {
    return fail(err instanceof RunNotFoundError ? 404 : 409, (err as Error).message);
  }
});
