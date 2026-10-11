import { AGENT_TEMPLATES } from "@/config/workflow";
import { body, fail, handle, ok } from "@/lib/api";
import { getPool, healthCheckPool } from "@/lib/engine/pools";
import type { AgentPool, AgentSource } from "@/lib/types";

export const runtime = "nodejs";

export const POST = handle(async (req: Request) => {
  const b = (await body<{ templateId?: string; client?: AgentSource }>(req)) ?? {};
  const client: AgentSource = b.client === "darwin" ? "darwin" : "mock";
  if (b.templateId && !AGENT_TEMPLATES.some((t) => t.id === b.templateId)) return fail(400, "Unknown agent templateId");
  const ids = b.templateId ? [b.templateId] : AGENT_TEMPLATES.map((t) => t.id);
  const pools: AgentPool[] = [];
  for (const id of ids) {
    const pool = getPool(id, client);
    if (pool) pools.push(await healthCheckPool(pool));
  }
  return ok({ pools });
});
