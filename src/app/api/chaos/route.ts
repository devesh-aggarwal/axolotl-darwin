import { body, handle, ok } from "@/lib/api";
import { getChaos, setChaos } from "@/lib/engine/runtime";
import type { ChaosConfig } from "@/lib/types";

export const runtime = "nodejs";

export const GET = handle(async () => ok({ chaos: getChaos() }));

export const POST = handle(async (req: Request) => {
  return ok({ chaos: setChaos(await body<ChaosConfig>(req)) });
});
