import { body, handle, ok } from "@/lib/api";
import { resetPools } from "@/lib/engine/pools";
import type { AgentSource } from "@/lib/types";

export const runtime = "nodejs";

/** Back to the default pre-approved pools. */
export const POST = handle(async (req: Request) => {
  const b = (await body<{ client?: AgentSource }>(req)) ?? {};
  resetPools(b.client === "darwin" ? "darwin" : b.client === "mock" ? "mock" : undefined);
  return ok({ ok: true });
});
