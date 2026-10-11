// Minimal MCP server (Streamable HTTP, JSON-RPC 2.0) for Axolotl's local test agents. Each agent
// exposes one tool, does real work with Axolotl's analyzers, and answers in its own format.
// Used by the /test-agents route and by tests (handler called directly, no network).
import crypto from "node:crypto";
import { runCapability } from "@/lib/audit";
import { renderAudit, renderCrawl, type AnswerStyle } from "@/lib/testAgents/formats";
import type { AgentNodeInput, AuditOutput, Capability, CrawlOutput } from "@/lib/types";

export interface TestAgent {
  id: string;
  name: string;
  capability: Capability;
  tool: string;
  description: string;
  style: AnswerStyle;
  inputSchema: Record<string, unknown>;
}

const urlProp = (description: string) => ({ type: "string", description });

export const TEST_AGENTS: TestAgent[] = [
  {
    id: "site-mapper",
    name: "Site Mapper",
    capability: "crawl",
    tool: "map_site",
    description: "Crawl a website and list its pages as Markdown links.",
    style: "markdown-links",
    inputSchema: { type: "object", properties: { url: urlProp("Site to crawl"), limit: { type: "integer", minimum: 1, maximum: 50 } }, required: ["url"] },
  },
  {
    id: "axe-runner",
    name: "Axe Runner",
    capability: "accessibility",
    tool: "run_axe",
    description: "Run an axe-core accessibility scan on one web page and return the raw axe results.",
    style: "axe",
    inputSchema: { type: "object", properties: { url: urlProp("Page to scan") }, required: ["url"] },
  },
  {
    id: "speed-check",
    name: "Speed Check",
    capability: "performance",
    tool: "lighthouse_audit",
    description: "Lighthouse performance audit of one web page; returns the Lighthouse report JSON.",
    style: "lighthouse",
    inputSchema: { type: "object", properties: { url: urlProp("Page to audit"), formFactor: { type: "string", enum: ["mobile", "desktop"] } }, required: ["url"] },
  },
  {
    id: "seo-notes",
    name: "SEO Notes",
    capability: "seo",
    tool: "seo_review",
    description: "Review a website's on-page SEO and write up the problems in Markdown.",
    style: "markdown",
    inputSchema: {
      type: "object",
      properties: { site_url: urlProp("Site root"), pages: { type: "array", items: { type: "string" } } },
      required: ["site_url"],
    },
  },
  {
    id: "header-scan",
    name: "Header Scan",
    capability: "security",
    tool: "scan_headers",
    description: "Check a website's security headers and forms, and explain the problems in plain English.",
    style: "prose",
    inputSchema: { type: "object", properties: { target: urlProp("Site to scan"), pages: { type: "array", items: { type: "string" } } }, required: ["target"] },
  },
  {
    id: "link-checker",
    name: "Link Checker",
    capability: "links",
    tool: "check_links",
    description: "Find broken links on a website; returns a Markdown table.",
    style: "table",
    inputSchema: { type: "object", properties: { website: urlProp("Site root"), pages: { type: "array", items: { type: "string" } } }, required: ["website"] },
  },
];

export function getTestAgent(id: string): TestAgent | undefined {
  return TEST_AGENTS.find((a) => a.id === id);
}

/** Test behavior, chosen with ?mode= on the endpoint URL. */
export type TestMode = "ok" | "auth" | "error" | "slow" | "refuse";

const PROTOCOL = "2025-06-18";
const sessions = new Set<string>();

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };

function rpcResult(id: Rpc["id"], result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function rpcError(id: Rpc["id"], code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/** tools/call answers as an SSE stream, like many hosted MCP servers; everything else as plain JSON. */
function sse(body: unknown): Response {
  const progress = { jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: "t", progress: 1, total: 2 } };
  const text = `event: message\ndata: ${JSON.stringify(progress)}\n\nevent: message\ndata: ${JSON.stringify(body)}\n\n`;
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function inputFor(agent: TestAgent, args: Record<string, unknown>): AgentNodeInput {
  const url = str(args.url) ?? str(args.site_url) ?? str(args.target) ?? str(args.website) ?? "";
  const pages = Array.isArray(args.pages) ? args.pages.filter((p): p is string => typeof p === "string") : [];
  if (agent.capability === "crawl") return { siteUrl: url, maxPages: typeof args.limit === "number" ? args.limit : 10 };
  if (agent.capability === "accessibility" || agent.capability === "performance") return { siteUrl: url, pageUrl: url };
  return { siteUrl: url, pages: pages.length ? pages : [url] };
}

export interface McpServerOptions {
  /** Sites the test agents may fetch. The route allows only the demo site, so it can't be used as a proxy. */
  allowSite?: (url: string) => boolean;
}

async function callTool(agent: TestAgent, args: Record<string, unknown>, mode: TestMode, opts: McpServerOptions): Promise<Record<string, unknown>> {
  if (mode === "error") return { isError: true, content: [{ type: "text", text: "Upstream scanner crashed (exit code 137)." }] };
  if (mode === "refuse") return { content: [{ type: "text", text: "I'm sorry, I was unable to access that website." }] };
  if (mode === "slow") await new Promise((r) => setTimeout(r, 30_000));
  const input = inputFor(agent, args);
  if (!input.siteUrl) return { isError: true, content: [{ type: "text", text: "Missing URL argument." }] };
  const urls = [input.siteUrl, ..."pageUrl" in input ? [input.pageUrl] : [], ..."pages" in input ? input.pages : []];
  if (opts.allowSite && !urls.every(opts.allowSite)) {
    return { isError: true, content: [{ type: "text", text: "This test agent only audits the local demo site." }] };
  }
  const out = await runCapability(agent.capability, input);
  const rendered = agent.capability === "crawl" ? renderCrawl(out as CrawlOutput, agent.style) : renderAudit(out as AuditOutput, agent.style, input.siteUrl);
  const text = typeof rendered === "string" ? rendered : JSON.stringify(rendered);
  return { content: [{ type: "text", text }] };
}

/** Handles one MCP request for a test agent. */
export async function handleMcpRequest(req: Request, agentId: string, opts: McpServerOptions = {}): Promise<Response> {
  const agent = getTestAgent(agentId);
  if (!agent) return json({ error: "Unknown test agent" }, 404);
  const mode = (new URL(req.url).searchParams.get("mode") ?? "ok") as TestMode;
  if (mode === "auth") {
    return json({ error: "unauthorized" }, 401, { "www-authenticate": 'Bearer resource_metadata="https://example.invalid/.well-known/oauth-protected-resource"' });
  }
  if (req.method === "DELETE") {
    sessions.delete(req.headers.get("mcp-session-id") ?? "");
    return new Response(null, { status: 200 });
  }
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { allow: "POST, DELETE" } });

  let msg: Rpc;
  try {
    msg = (await req.json()) as Rpc;
  } catch {
    return json(rpcError(null, -32700, "Parse error"), 400);
  }
  if (!msg || typeof msg !== "object" || typeof msg.method !== "string") return json(rpcError(null, -32600, "Invalid request"), 400);

  if (msg.method === "initialize") {
    const session = crypto.randomUUID();
    sessions.add(session);
    if (sessions.size > 500) sessions.delete(sessions.values().next().value as string);
    const requested = str(msg.params?.protocolVersion);
    return json(
      rpcResult(msg.id, { protocolVersion: requested ?? PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: agent.name, version: "1.0.0" } }),
      200,
      { "mcp-session-id": session },
    );
  }
  // Notifications get no response body.
  if (msg.id === undefined || msg.id === null) return new Response(null, { status: 202 });

  const session = req.headers.get("mcp-session-id");
  if (!session || !sessions.has(session)) return json(rpcError(msg.id, -32000, "Bad or missing session"), 404);

  switch (msg.method) {
    case "ping":
      return json(rpcResult(msg.id, {}));
    case "tools/list":
      return json(rpcResult(msg.id, { tools: [{ name: agent.tool, description: agent.description, inputSchema: agent.inputSchema }] }));
    case "tools/call": {
      const name = str(msg.params?.name);
      if (name !== agent.tool) return json(rpcError(msg.id, -32602, `Unknown tool: ${name ?? "(none)"}`));
      const args = msg.params?.arguments && typeof msg.params.arguments === "object" ? (msg.params.arguments as Record<string, unknown>) : {};
      try {
        return sse(rpcResult(msg.id, await callTool(agent, args, mode, opts)));
      } catch (err) {
        return sse(rpcResult(msg.id, { isError: true, content: [{ type: "text", text: `Tool failed: ${(err as Error).message}` }] }));
      }
    }
    default:
      return json(rpcError(msg.id, -32601, `Method not found: ${msg.method}`));
  }
}
