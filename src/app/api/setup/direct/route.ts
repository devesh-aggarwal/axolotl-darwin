// Setup: add an agent by its own MCP address (a provider's documented endpoint, or a local test agent).
// Connects once, lists the tools, and returns a candidate the user can pick as primary or backup.
import crypto from "node:crypto";
import { getTemplate, type NodeTemplate } from "@/config/workflow";
import { body, fail, handle, ok } from "@/lib/api";
import { McpError } from "@/lib/darwin/mcp";
import { getDarwinClient } from "@/lib/engine/clients";
import type { McpDirectClient } from "@/lib/darwin/mcp";
import { TransportError } from "@/lib/darwin/types";
import { env } from "@/lib/env";
import { TEST_AGENTS } from "@/lib/testAgents/mcpServer";
import { withTrust } from "@/lib/trust/store";
import type { AgentCandidate, AgentEndpoint, Capability } from "@/lib/types";

export const runtime = "nodejs";

function agentTemplate(templateId: string | null | undefined): NodeTemplate | null {
  try {
    const t = getTemplate(String(templateId ?? ""));
    return t.kind === "agent" && t.capability ? t : null;
  } catch {
    return null;
  }
}

function isLocalTestAgent(url: string, origin: string): boolean {
  try {
    const u = new URL(url);
    return u.origin === origin && /^\/test-agents\/[\w-]+\/mcp\/?$/.test(u.pathname);
  } catch {
    return false;
  }
}

/** The local test agent for a step, so setup can offer it without Darwin. */
export const GET = handle(async (req: Request) => {
  const template = agentTemplate(new URL(req.url).searchParams.get("templateId"));
  if (!template) return fail(400, "Unknown agent templateId");
  const agent = TEST_AGENTS.find((a) => a.capability === template.capability);
  const origin = new URL(env.publicBaseUrl).origin;
  return ok({ testAgent: agent ? { name: agent.name, url: `${origin}/test-agents/${agent.id}/mcp` } : null });
});

export const POST = handle(async (req: Request) => {
  const b = await body<{ templateId: string; url: string; toolName?: string }>(req);
  const template = agentTemplate(b.templateId);
  if (!template) return fail(400, "Unknown agent templateId");
  const url = typeof b.url === "string" ? b.url.trim().slice(0, 2000) : "";
  if (!url) return fail(400, "Enter the agent's MCP address");
  const client = getDarwinClient("direct") as McpDirectClient;
  let described;
  try {
    described = await client.describeEndpoint(url);
  } catch (err) {
    const msg = err instanceof McpError || err instanceof TransportError ? err.message : "Couldn't connect to that address.";
    return fail(422, msg);
  }
  const capability = template.capability as Capability;
  const tool = (typeof b.toolName === "string" && described.tools.find((t) => t.name === b.toolName)) || client.suggestTool(described.tools, capability);
  if (!tool) {
    return ok({
      candidate: null,
      tools: described.tools.map((t) => ({ name: t.name, description: t.description })),
      note: described.tools.length ? "This agent offers several tools. Pick the one for this step." : "This agent offers no tools.",
    });
  }
  const origin = new URL(env.publicBaseUrl).origin;
  const local = isLocalTestAgent(url, origin);
  const endpoint: AgentEndpoint = { protocol: "MCP", url, toolName: tool.name, origin: local ? "local-test" : "manual" };
  const id = crypto.createHash("sha256").update(url).digest("hex").slice(0, 12);
  const candidate: AgentCandidate = {
    agentId: `direct:${id}:${tool.name}`,
    capabilityId: tool.name,
    name: described.serverName || tool.name,
    source: "direct",
    provider: local ? "Local test agent" : new URL(url).host,
    capability,
    description: tool.description,
    readiness: "ready",
    canStartThread: true,
    reasons: [`Connected and found the tool "${tool.name}".`],
    uncertainties: local ? ["Runs on this machine, for testing without Darwin. Not a Darwin agent."] : [],
    requiredSetup: null,
    rank: 1,
    argumentSchema: tool.inputSchema,
    endpoint,
  };
  // Every tool's description is part of what the agent tells a caller, so all of them are checked.
  const [checked] = withTrust([candidate], described.tools.map((t) => t.description));
  return ok({ candidate: checked, tools: described.tools.map((t) => ({ name: t.name, description: t.description })) });
});
