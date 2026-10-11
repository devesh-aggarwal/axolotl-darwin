import { body, fail, handle, ok } from "@/lib/api";
import { injectFault } from "@/lib/engine/runtime";
import type { FaultMode } from "@/lib/types";

export const runtime = "nodejs";

const FAULTS: Record<string, FaultMode> = { kill: "error", error: "error", timeout: "timeout", stall: "stall", corrupt: "corrupt", auth: "auth_block", auth_block: "auth_block" };

export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string; nodeId: string }> }) => {
  const { id, nodeId } = await ctx.params;
  const fault = (await body<{ fault: string }>(req))?.fault;
  const mode = Object.hasOwn(FAULTS, String(fault)) ? FAULTS[String(fault)] : undefined;
  if (!mode) return fail(400, "fault must be one of kill, timeout, stall, corrupt, auth");
  // Route params arrive decoded already.
  const res = injectFault(id, nodeId, mode);
  return res.ok ? ok({ ok: true }) : fail(409, res.reason);
});
