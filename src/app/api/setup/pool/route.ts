// Setup step 2: save the primary + backups the user picked and approved, then health-check them.
import { AGENT_TEMPLATES } from "@/config/workflow";
import { body, fail, handle, ok } from "@/lib/api";
import { actConfigured, getDarwinClient } from "@/lib/engine/clients";
import type { McpDirectClient } from "@/lib/darwin/mcp";
import { getPool, healthCheckPool, savePool } from "@/lib/engine/pools";
import { getListing, trustFor } from "@/lib/trust/store";
import type { AgentEndpoint, AgentKind, AgentPool, AgentSource, Capability, PoolMember } from "@/lib/types";

export const runtime = "nodejs";

export const GET = handle(async (req: Request) => {
  const url = new URL(req.url);
  const client: AgentSource = url.searchParams.get("client") === "darwin" ? "darwin" : "mock";
  const template = AGENT_TEMPLATES.find((t) => t.id === url.searchParams.get("templateId"));
  if (!template) return fail(400, "Unknown agent templateId");
  return ok({ pool: getPool(template.id, client) });
});

interface SaveBody {
  templateId: string;
  client: AgentSource;
  members: Partial<PoolMember>[];
}

const ENDPOINT_ORIGINS: AgentEndpoint["origin"][] = ["darwin", "manual", "local-test"];

function endpointOf(v: unknown): AgentEndpoint | undefined {
  if (!v || typeof v !== "object") return undefined;
  const e = v as Partial<AgentEndpoint>;
  if (e.protocol !== "MCP" || typeof e.url !== "string" || !e.url.trim() || e.url.length > 2000) return undefined;
  // Same rules as the direct client: no private networks, no calls into this app's own API.
  if ((getDarwinClient("direct") as McpDirectClient).endpointProblem(e.url.trim())) return undefined;
  return {
    protocol: "MCP",
    url: e.url.trim(),
    toolName: typeof e.toolName === "string" ? e.toolName.slice(0, 200) : undefined,
    origin: ENDPOINT_ORIGINS.includes(e.origin as AgentEndpoint["origin"]) ? (e.origin as AgentEndpoint["origin"]) : "manual",
  };
}

/**
 * How a Darwin pool member runs: through Act when it's configured, otherwise directly at the
 * agent's own endpoint when one is known. Simulated pools only hold simulated agents.
 */
function kindFor(client: AgentSource, m: Partial<PoolMember>, endpoint: AgentEndpoint | undefined): AgentKind {
  if (client === "mock") return "mock";
  if (endpoint && (m.source === "direct" || !actConfigured())) return "direct";
  return "darwin";
}

export const POST = handle(async (req: Request) => {
  const b = (await body<SaveBody>(req)) ?? {};
  // Builtin steps (merge, prioritize, fix plan) have no agent pool.
  const template = AGENT_TEMPLATES.find((t) => t.id === b.templateId);
  if (!template) return fail(400, "Unknown agent templateId");
  const client: AgentSource = b.client === "darwin" ? "darwin" : "mock";
  const raw = Array.isArray(b.members) ? b.members.slice(0, 5) : [];
  const members: PoolMember[] = raw
    .filter((m) => m && typeof m === "object" && typeof m.agentId === "string" && typeof m.capabilityId === "string")
    .map((m, i) => {
      const endpoint = client === "darwin" ? endpointOf(m.endpoint) : undefined;
      const member: PoolMember = {
        agentId: String(m.agentId),
        capabilityId: String(m.capabilityId),
        name: String(m.name ?? m.agentId).slice(0, 120),
        provider: m.provider ? String(m.provider).slice(0, 120) : undefined,
        source: kindFor(client, m, endpoint),
        role: i === 0 ? "primary" : "backup",
        approved: m.approved !== false,
        ready: false,
        healthStatus: "unverified",
        lastHealthCheck: null,
        searchId: typeof m.searchId === "string" ? m.searchId : undefined,
        argumentSchema: (m.argumentSchema as Record<string, unknown> | null | undefined) ?? null,
      };
      if (member.source === "direct") member.endpoint = endpoint;
      return member;
    });
  if (!members.length) return fail(400, "Pick at least a primary agent");
  // An agent whose trust check found it unsafe (it tries to steer the caller or take secrets) never joins a pool.
  for (const m of members) {
    const listing = getListing(m.agentId, template.capability as Capability);
    if (listing && trustFor(listing).verdict === "avoid") return fail(422, `${m.name} failed its safety check, so it can't join a pool`);
  }
  const pool: AgentPool = { templateId: template.id, capability: template.capability as Capability, client, members, updatedAt: Date.now() };
  savePool(pool);
  return ok({ pool: await healthCheckPool(pool) });
});
