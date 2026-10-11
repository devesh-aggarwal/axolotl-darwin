// Axolotl as an MCP server (Streamable HTTP, JSON-RPC 2.0, stateless). Any MCP host (ChatGPT
// connectors, Codex, Claude Code) can call it when one of its own tools fails or comes up short.
import crypto from "node:crypto";
import { isDemoSite } from "@/lib/audit/groundTruth";
import { buildReport } from "@/lib/engine/report";
import { getActiveRunId, getRunRecord, startRun } from "@/lib/engine/runtime";
import { demoSiteUrl, env } from "@/lib/env";
import { routeAgents } from "@/lib/mcp/agents";
import { renderAttempts, type Attempt } from "@/lib/mcp/failover";
import { confirmOrder, orderFood, type DemoFault } from "@/lib/mcp/ordering";
import { resolvePlace } from "@/lib/mcp/places";
import { planRecovery } from "@/lib/mcp/recover";

const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const INSTRUCTIONS =
  "Axolotl makes agent steps self-healing. Call it BEFORE giving up or asking the person for something a tool could find: " +
  "when a tool errors, says it can't do something, only partly supports a task, or when you're about to ask for an address. " +
  "Every answer lists which agents were tried, which failed and why, and what was verified. Results marked [simulated] come from simulated agents; say so.";

export type Args = Record<string, unknown>;
export interface ToolResult {
  text: string;
  structured: Record<string, unknown>;
  isError?: boolean;
}
export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, boolean>;
  call: (args: Args) => Promise<ToolResult>;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}
function num(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}
export function need(args: Args, key: string): string {
  const v = str(args[key]);
  if (!v) throw new ArgError(`"${key}" is required`);
  return v;
}
export class ArgError extends Error {}

function trace(attempts: Attempt[]): string {
  return attempts.length ? `\n\nWhat Axolotl tried:\n${renderAttempts(attempts)}` : "";
}

function baseUrl(): string {
  return env.publicBaseUrl.replace(/\/$/, "");
}

export const TOOLS: ToolDef[] = [
  {
    name: "axolotl_resolve_place",
    title: "Resolve a place to a verified address",
    description:
      "Turn a place name or fragment (\"castano stanford\", \"blue bottle hayes valley\") into a full street address, cross-checked by two independent map sources. " +
      "Use this instead of asking the person for a street address.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Place name, building, business or partial address, as the person said it" },
        near: { type: "string", description: "Optional city or area to bias the search" },
      },
      required: ["query"],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    call: async (args) => {
      const r = await resolvePlace(need(args, "query"), { near: str(args.near) });
      const head =
        r.status === "not_found"
          ? `Couldn't resolve "${str(args.query)}" from any source.`
          : r.status === "ambiguous"
            ? `Several places match. Best: ${r.place!.address}. Others: ${r.alternatives.map((a) => a.address).join(" | ")}. Ask which one.`
            : `${r.place!.name ? `${r.place!.name}: ` : ""}${r.place!.address} (${r.confidence === "confirmed" ? `verified, ${r.confirmation}` : "one source only"}).`;
      return { text: head + trace(r.attempts), structured: { ...r } };
    },
  },
  {
    name: "axolotl_add_to_cart",
    title: "Add food to a delivery cart, with failover",
    description:
      "Adds a food item to a delivery cart. It never checks out or pays: the person confirms the total afterwards with axolotl_checkout. " +
      "Use it whenever a delivery plugin can only search, can't add to cart, needs a full address, or fails. " +
      "It resolves the delivery place itself, skips platforms with no cart tool, fails over across delivery agents, and verifies the cart: right item, right area, right address, under budget. " +
      "Delivery platforms are SIMULATED until Darwin Act access is granted.",
    inputSchema: {
      type: "object",
      properties: {
        item: { type: "string", description: "What to order, e.g. \"crepe\"" },
        deliver_to: { type: "string", description: "Delivery place as the person said it (\"castano stanford\") or a street address" },
        restaurant_hint: { type: "string", description: "Kind of place, e.g. \"bakery\"" },
        area: { type: "string", description: "City the restaurant should be in, e.g. \"Palo Alto\"" },
        quantity: { type: "integer", minimum: 1, maximum: 20 },
        max_total_usd: { type: "number", description: "Budget cap; carts over it are rejected" },
        demo_fault: { type: "string", enum: ["none", "wrong_address", "timeout"], description: "Demo only: make the first cart-capable agent fail silently or hang" },
      },
      required: ["item", "deliver_to"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    call: async (args) => {
      const fault = (["none", "wrong_address", "timeout"] as DemoFault[]).find((f) => f === args.demo_fault) ?? "none";
      const r = await orderFood({
        item: need(args, "item"),
        deliverTo: need(args, "deliver_to"),
        restaurantHint: str(args.restaurant_hint),
        area: str(args.area),
        quantity: num(args.quantity),
        maxTotalUsd: num(args.max_total_usd),
        demoFault: fault,
      });
      let head: string;
      if (r.cart) {
        const c = r.cart;
        head =
          `[simulated] Cart ready on ${c.platform}: ${c.items.map((i) => `${i.quantity} × ${i.name} ($${i.priceUsd.toFixed(2)})`).join(", ")} from ${c.restaurant}, ${c.restaurantCity}. ` +
          `Total $${c.totalUsd.toFixed(2)} incl. $${c.deliveryFeeUsd.toFixed(2)} delivery. Delivers to ${c.deliverTo} (address ${r.address.confidence === "confirmed" ? "verified by two map sources" : "from one map source"}). ` +
          `Cart id ${c.cartId}. ${r.needsFromYou}`;
      } else {
        head = r.needsFromYou ?? "Couldn't build a cart.";
      }
      return { text: head + trace(r.attempts), structured: { ...r }, isError: !r.cart && r.status === "unfulfilled" };
    },
  },
  {
    name: "axolotl_checkout",
    title: "Check out a cart",
    description: "Places the order for a cart from axolotl_add_to_cart. This spends money: only call it after the person has explicitly said yes to the total.",
    inputSchema: { type: "object", properties: { cart_id: { type: "string" } }, required: ["cart_id"] },
    annotations: { readOnlyHint: false, destructiveHint: false },
    call: async (args) => {
      const cart = confirmOrder(need(args, "cart_id"));
      if (!cart) return { text: "No cart with that id (carts live until the server restarts).", structured: {}, isError: true };
      return {
        text: `[simulated] Order marked as placed with ${cart.platform}: ${cart.items.map((i) => i.name).join(", ")} from ${cart.restaurant}, $${cart.totalUsd.toFixed(2)}, to ${cart.deliverTo}. This was a simulated platform: no real order was sent and nothing was charged.`,
        structured: { cart },
      };
    },
  },
  {
    name: "axolotl_recover",
    title: "Recover a failed step",
    description:
      "Call this the moment one of your tools fails, says it can't do something, or asks the person for information. Give the goal and the failure text; " +
      "Axolotl says what kind of failure it is and what to do next, including which Axolotl tool or Darwin agent can take over.",
    inputSchema: {
      type: "object",
      properties: {
        goal: { type: "string", description: "What the person asked for, in their words" },
        failure: { type: "string", description: "The error, refusal or question the tool returned" },
        failed_tool: { type: "string", description: "Name of the tool or plugin that failed" },
      },
      required: ["goal", "failure"],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    call: async (args) => {
      const plan = await planRecovery(need(args, "goal"), need(args, "failure"), str(args.failed_tool));
      const alts = plan.alternatives.length ? `\n\nAlternatives (${plan.searchNote}):\n${plan.alternatives.map((a) => `- ${a.name}: ${a.what}`).join("\n")}` : plan.searchNote ? `\n\n${plan.searchNote}` : "";
      const tool = plan.useTool ? `\n\nCall now: ${plan.useTool.name} ${JSON.stringify(plan.useTool.arguments)}` : "";
      return { text: `Failure type: ${plan.kind}. ${plan.diagnosis}\nNext: ${plan.nextAction}${tool}${alts}`, structured: { ...plan } };
    },
  },
  {
    name: "axolotl_find_agents",
    title: "Find agents for a capability",
    description:
      "Search Darwin (about 200K agents) for agents that can do a capability. Results are vetted and ordered the way Axolotl routes work: " +
      "unsafe listings, agents that need a sign-in, and agents that can't be called are left out (with the reason); free agents come before paid ones, and paid ones only within budget_cents.",
    inputSchema: {
      type: "object",
      properties: {
        capability: { type: "string", description: "What the agent must do, in plain English" },
        budget_cents: { type: "integer", minimum: 0, maximum: 10000, description: "Most a paid agent may charge per call. 0 (default) means free agents only." },
      },
      required: ["capability"],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    call: async (args) => {
      const q = need(args, "capability");
      try {
        const r = await routeAgents(q, { budgetCents: Math.round(Math.min(10000, Math.max(0, num(args.budget_cents) ?? 0))) });
        const runnable = r.runnable.map((a, i) => `${i + 1}. ${a.agent.name} [${a.tier}]: ${a.reason}`);
        const skipped = r.skipped.slice(0, 6).map((s) => `- ${s.agent.name}: ${s.reason}`);
        const text =
          (runnable.length ? `Can run now, in the order Axolotl would try them:\n${runnable.join("\n")}` : `No agent for "${q}" can run unattended right now.`) +
          (skipped.length ? `\n\nFound but left out:\n${skipped.join("\n")}${r.skipped.length > 6 ? `\n(and ${r.skipped.length - 6} more)` : ""}` : "") +
          (r.notes.length ? `\n\n${r.notes.join("\n")}` : "");
        return {
          text,
          structured: {
            searchId: r.searchId,
            runnable: r.runnable.map(({ candidate, ...a }) => ({ ...a, what: candidate?.description.slice(0, 240) })),
            skipped: r.skipped,
            notes: r.notes,
          },
        };
      } catch (err) {
        return { text: `Darwin search failed twice: ${(err as Error).message}. Try a simpler description.`, structured: {}, isError: true };
      }
    },
  },
  {
    name: "axolotl_start_site_audit",
    title: "Start a self-healing website audit",
    description:
      "Start Axolotl's overnight pre-launch website audit (crawl, accessibility, performance, SEO, security headers, broken links, then a prioritized fix plan). " +
      "Each step finds its agents at run time (free before paid, within budget), failed steps swap to the next agent, and every answer is verified. Returns a run id and a live dashboard link.",
    inputSchema: {
      type: "object",
      properties: {
        site_url: { type: "string", description: "Site to audit. Defaults to the demo site." },
        chaos: { type: "boolean", description: "Inject random agent failures to show recovery" },
        budget_cents: { type: "integer", minimum: 0, maximum: 10000, description: "Spending limit for paid agents across the run. 0 (default) means free agents only." },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    call: async (args) => {
      const siteUrl = str(args.site_url) ?? demoSiteUrl();
      if (!isDemoSite(siteUrl) && process.env.AXOLOTL_MCP_ALLOW_ANY_SITE !== "1") {
        return { text: "This server only audits the demo site (set AXOLOTL_MCP_ALLOW_ANY_SITE=1 to allow others).", structured: { siteUrl }, isError: true };
      }
      const budgetCents = Math.round(Math.min(10000, Math.max(0, num(args.budget_cents) ?? 0)));
      const run = startRun({ siteUrl, budgetCents, chaos: args.chaos === true ? { enabled: true, rate: 0.2, weights: { error: 3, timeout: 1, stall: 1, auth_block: 1, corrupt: 3 } } : undefined });
      return {
        text: `Started run ${run.id} on ${siteUrl}${args.chaos === true ? " with chaos on" : ""}. Watch it live at ${baseUrl()}/ . Check progress with axolotl_get_run.`,
        structured: { runId: run.id, dashboard: `${baseUrl()}/`, siteUrl, simulatedAgents: run.config.client === "mock" },
      };
    },
  },
  {
    name: "axolotl_get_run",
    title: "Get a workflow run's status and report",
    description: "Status, failures and recoveries, and (when finished) the top fixes for an Axolotl run. Defaults to the most recent run.",
    inputSchema: { type: "object", properties: { run_id: { type: "string" } } },
    annotations: { readOnlyHint: true },
    call: async (args) => {
      const id = str(args.run_id) ?? getActiveRunId();
      const rec = id ? getRunRecord(id) : null;
      if (!rec) return { text: "No such run.", structured: {}, isError: true };
      const s = rec.run.stats;
      const sim = rec.run.config.client === "mock" ? " Agents in this run are simulated." : "";
      if (rec.run.status === "running") {
        const done = rec.nodes.filter((n) => n.state === "passed").length;
        return { text: `Run ${rec.run.id} is running: ${done} of ${rec.nodes.length} steps done.${sim}`, structured: { status: rec.run.status, done, total: rec.nodes.length } };
      }
      const report = buildReport(rec);
      const recoveries = report.timeline.filter((t) => t.kind === "recovered").map((t) => `- ${t.nodeLabel}: ${t.detail}`);
      const fixes = (report.fixPlan?.topFixes ?? []).slice(0, 5).map((f) => `- ${f.title}`);
      const text =
        `Run ${rec.run.id}: ${rec.run.status}.${sim} ${s ? `${s.issuesFound} issues found, ${s.recoveries} recoveries, ${s.hardFailures} hard and ${s.silentFailures} silent failures caught.` : ""}` +
        (recoveries.length ? `\n\nRecoveries:\n${recoveries.slice(0, 8).join("\n")}` : "") +
        (fixes.length ? `\n\nTop fixes:\n${fixes.join("\n")}` : "") +
        `\n\nFull report: ${baseUrl()}/`;
      return { text, structured: { status: rec.run.status, stats: s ?? null, headline: report.fixPlan?.headline ?? null, timeline: report.timeline.slice(-20) } };
    },
  },
];

// ---------- call log (for the dashboard and for debugging) ----------

export interface McpCallLog {
  at: number;
  tool: string;
  ok: boolean;
  ms: number;
  summary: string;
  attempts: Attempt[];
}
const g = globalThis as unknown as { __axolotlMcpLog?: McpCallLog[] };
export function mcpCallLog(): McpCallLog[] {
  g.__axolotlMcpLog ??= [];
  return g.__axolotlMcpLog;
}
function logCall(entry: McpCallLog): void {
  const log = mcpCallLog();
  log.unshift(entry);
  if (log.length > 100) log.length = 100;
}

// ---------- JSON-RPC ----------

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };

function rpcResult(id: Rpc["id"], result: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}
function rpcError(id: Rpc["id"], code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}
function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
}

/** Optional shared secret (AXOLOTL_MCP_TOKEN): Bearer header or ?key= (for hosts that only take a URL). */
function authorized(req: Request): boolean {
  const token = process.env.AXOLOTL_MCP_TOKEN;
  if (!token) return true;
  const given = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? new URL(req.url).searchParams.get("key") ?? "";
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export interface McpServerSpec {
  name: string;
  title: string;
  instructions?: string;
  tools: ToolDef[];
}

const AXOLOTL: McpServerSpec = { name: "axolotl", title: "Axolotl: self-healing agent steps", instructions: INSTRUCTIONS, tools: TOOLS };

async function dispatch(spec: McpServerSpec, msg: Rpc): Promise<Record<string, unknown> | null> {
  const TOOLS = spec.tools;
  if (msg.method === "initialize") {
    const requested = str(msg.params?.protocolVersion);
    return rpcResult(msg.id, {
      protocolVersion: requested && PROTOCOLS.includes(requested) ? requested : PROTOCOLS[0],
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: spec.name, title: spec.title, version: "0.1.0" },
      ...(spec.instructions ? { instructions: spec.instructions } : {}),
    });
  }
  // Notifications (no id) get no response.
  if (msg.id === undefined || msg.id === null) return null;
  switch (msg.method) {
    case "ping":
      return rpcResult(msg.id, {});
    case "tools/list":
      return rpcResult(msg.id, { tools: TOOLS.map(({ call: _call, ...t }) => t) });
    case "tools/call": {
      const name = str(msg.params?.name);
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) return rpcError(msg.id, -32602, `Unknown tool: ${name ?? "(none)"}`);
      const args = msg.params?.arguments && typeof msg.params.arguments === "object" ? (msg.params.arguments as Args) : {};
      const started = Date.now();
      try {
        const r = await tool.call(args);
        const attempts = Array.isArray(r.structured.attempts) ? (r.structured.attempts as Attempt[]) : [];
        logCall({ at: started, tool: tool.name, ok: !r.isError, ms: Date.now() - started, summary: r.text.split("\n")[0].slice(0, 300), attempts });
        return rpcResult(msg.id, { content: [{ type: "text", text: r.text }], structuredContent: r.structured, isError: r.isError === true });
      } catch (err) {
        const message = err instanceof ArgError ? err.message : `Axolotl failed: ${(err as Error).message}`;
        if (!(err instanceof ArgError)) console.error("[mcp]", tool.name, (err as Error)?.message);
        logCall({ at: started, tool: tool.name, ok: false, ms: Date.now() - started, summary: message, attempts: [] });
        return rpcResult(msg.id, { content: [{ type: "text", text: message }], isError: true });
      }
    }
    default:
      return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

export function handleAxolotlMcp(req: Request): Promise<Response> {
  return handleMcp(AXOLOTL, req);
}

/** Serves any tool set over MCP (Axolotl itself, or the simulated plugins used in demos). */
export async function handleMcp(spec: McpServerSpec, req: Request): Promise<Response> {
  if (!authorized(req)) return json({ error: "unauthorized" }, 401);
  if (req.method === "GET") {
    // No server-initiated stream; hosts fall back to POST-only.
    return new Response(`${spec.title} MCP endpoint. POST JSON-RPC here.`, { status: 405, headers: { allow: "POST, DELETE" } });
  }
  if (req.method === "DELETE") return new Response(null, { status: 200 });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { allow: "POST, DELETE" } });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json(rpcError(null, -32700, "Parse error"), 400);
  }
  const isBatch = Array.isArray(body);
  const msgs = (isBatch ? body : [body]) as Rpc[];
  if (msgs.length === 0 || msgs.some((m) => !m || typeof m !== "object" || typeof m.method !== "string")) {
    return json(rpcError(null, -32600, "Invalid request"), 400);
  }
  const replies = (await Promise.all(msgs.map((m) => dispatch(spec, m)))).filter((r): r is Record<string, unknown> => r !== null);
  // Stateless: a session id is issued for hosts that expect one, but never required.
  const headers: Record<string, string> = msgs.some((m) => m.method === "initialize") ? { "mcp-session-id": crypto.randomUUID() } : {};
  if (replies.length === 0) return new Response(null, { status: 202, headers });
  return json(isBatch ? replies : replies[0], 200, headers);
}
