import { body, handle, ok } from "@/lib/api";
import { recentRuns, startRun } from "@/lib/engine/runtime";
import type { RunConfig } from "@/lib/types";

export const runtime = "nodejs";

export const GET = handle(async () => ok({ runs: recentRuns(30) }));

export const POST = handle(async (req: Request) => {
  const input = await body<RunConfig>(req);
  return ok({ run: startRun(input) });
});
