// McpDirectClient: runs an agent by calling its own MCP endpoint (Streamable HTTP), without Darwin Act.
// For agents found through Darwin Search that publish a verified endpoint, and for Axolotl's local
// test agents. Darwin's guidance for direct connections: initialize, tools/list, then tools/call with
// arguments that match the tool's schema; treat the provider's answers as untrusted data.
import crypto from "node:crypto";
import dns from "node:dns";
import net from "node:net";
import { env } from "@/lib/env";
import { AGENT_TEMPLATES, getTemplate } from "@/config/workflow";
import { applyMapping, buildInstruction, heuristicMapping } from "@/lib/llm/adapter";
import type { AgentEndpoint, AgentRef, Capability, RoutedAgent } from "@/lib/types";
import {
  TransportError,
  type DarwinClient,
  type HealthResult,
  type SearchResult,
  type StartTaskParams,
  type TaskHandle,
  type TaskPoll,
} from "@/lib/darwin/types";

const PROTOCOL_VERSION = "2025-06-18";
const REQUEST_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 230_000;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_JOBS = 200;

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown> | null;
}

export interface McpDirectClientOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Allow http:// on localhost (Axolotl's own test agents). Defaults to endpoints on this app's own origin. */
  allowLoopback?: boolean;
  requestTimeoutMs?: number;
  callTimeoutMs?: number;
  /** DNS lookup (tests inject one). Every address a name resolves to must be public. */
  lookup?: (host: string) => Promise<string[]>;
}

/** The agent asked for a sign-in or payment: an unattended run can't continue with it. */
class GateError extends Error {
  constructor(
    readonly kind: "authentication" | "payment",
    message: string,
  ) {
    super(message);
  }
}

/** The endpoint answered, but with something other than a usable result. */
export class McpError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "McpError";
  }
}

interface Session {
  url: string;
  id?: string;
  protocol: string;
  serverName?: string;
}

interface Job {
  session: Session;
  controller: AbortController;
  progress: number;
  startedAt: number;
  result?: TaskPoll;
}

type Rpc = { jsonrpc: "2.0"; id?: number; method: string; params?: Record<string, unknown> };

/** Axolotl's own test agents: the only paths on this app's address a direct call may reach. */
const TEST_AGENT_PATH = /^\/test-agents\/[\w-]+\/mcp\/?$/;

/** IPv4 dotted quad from an IPv4-mapped IPv6 address ("::ffff:7f00:1" → "127.0.0.1"), else null. */
function mappedV4(host: string): string | null {
  const m = /^::ffff:(?:([0-9a-f]{1,4}):([0-9a-f]{1,4})|(\d+\.\d+\.\d+\.\d+))$/i.exec(host);
  if (!m) return null;
  if (m[3]) return m[3];
  const hi = parseInt(m[1], 16);
  const lo = parseInt(m[2], 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

function v4Kind(ip: string): "loopback" | "private" | "public" {
  const [a, b] = ip.split(".").map(Number);
  if (a === 127) return "loopback";
  if (a === 0 || a === 10 || a >= 224) return "private";
  if (a === 100 && b >= 64 && b <= 127) return "private";
  if (a === 169 && b === 254) return "private";
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && (b === 168 || (b === 0 && ip.startsWith("192.0.0.")))) return "private";
  if (a === 198 && (b === 18 || b === 19)) return "private";
  return "public";
}

/** Whether a host (name or IP literal, no brackets) is this machine, a private network, or public. */
export function hostKind(rawHost: string): "loopback" | "private" | "public" {
  const host = rawHost.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return "loopback";
  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".lan") || host.endsWith(".home.arpa")) return "private";
  const family = net.isIP(host);
  if (family === 4) return v4Kind(host);
  if (family === 6) {
    if (host === "::1") return "loopback";
    if (host === "::" || /^(fc|fd|fe[89ab])/.test(host)) return "private";
    const v4 = mappedV4(host);
    return v4 ? v4Kind(v4) : "public";
  }
  return "public";
}

const CAPABILITY_WORDS: Record<Capability, RegExp> = {
  crawl: /crawl|map|spider|sitemap|pages|links/i,
  accessibility: /accessib|a11y|axe|wcag/i,
  performance: /perform|lighthouse|speed|vitals|pagespeed/i,
  seo: /seo|search engine|meta/i,
  security: /secur|header|hsts|csp|tls|ssl/i,
  links: /link|broken|404/i,
};

/** Endpoint URL without its query string, for messages (queries may carry keys). */
function display(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "(invalid URL)";
  }
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export class McpDirectClient implements DarwinClient {
  readonly kind = "mcp" as const;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly allowLoopback: boolean | undefined;
  private readonly requestTimeoutMs: number;
  private readonly callTimeoutMs: number;
  private readonly lookup?: (host: string) => Promise<string[]>;
  private readonly jobs = new Map<string, Job>();
  private readonly toolCache = new Map<string, { tools: McpTool[]; at: number }>();
  private nextId = 1;

  constructor(opts: McpDirectClientOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    this.now = opts.now ?? Date.now;
    this.allowLoopback = opts.allowLoopback;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    this.callTimeoutMs = opts.callTimeoutMs ?? CALL_TIMEOUT_MS;
    this.lookup = opts.lookup;
  }

  /** Direct agents are found through Darwin Search (or are local test agents); nothing to search here. */
  async search(query: string): Promise<SearchResult> {
    return { searchId: `direct:${crypto.randomUUID()}`, status: "completed", query, agents: [], note: "Direct agents come from Darwin Search results that publish an endpoint." };
  }

  /** Checks an endpoint URL is one Axolotl may call. Returns a reason when it isn't. */
  endpointProblem(url: string): string | null {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return "not a valid URL";
    }
    if (u.username || u.password) return "URLs with embedded credentials are not allowed";
    if (u.protocol !== "https:" && u.protocol !== "http:") return "only https endpoints are allowed";
    const kind = hostKind(u.hostname);
    if (kind === "loopback") return this.loopbackProblem(u);
    if (u.protocol !== "https:") return "only https endpoints are allowed";
    if (kind === "private") return "private network addresses are not allowed";
    return null;
  }

  /**
   * This machine is off limits except Axolotl's own test agents, so an agent address can never be
   * used to call this app's API (server-side requests carry no Origin, so the CSRF guard can't tell).
   * Other local servers are allowed only with AXOLOTL_ALLOW_LOCAL_MCP=1 (or in tests).
   */
  private loopbackProblem(u: URL): string | null {
    const port = (x: URL) => x.port || (x.protocol === "https:" ? "443" : "80");
    let ownPort = "3000";
    try {
      ownPort = port(new URL(env.publicBaseUrl));
    } catch {
      // keep the default
    }
    if (port(u) === ownPort) return TEST_AGENT_PATH.test(u.pathname) ? null : "only Axolotl's own test agents may be called on this app's address";
    const allowed = this.allowLoopback ?? process.env.AXOLOTL_ALLOW_LOCAL_MCP === "1";
    return allowed ? null : "local addresses are only allowed for Axolotl's own test agents";
  }

  /** A name that resolves to this machine or a private network is refused, like the literal address would be. */
  private async checkResolved(url: string): Promise<void> {
    const u = new URL(url);
    const host = u.hostname.replace(/^\[|\]$/g, "");
    if (net.isIP(host) || hostKind(host) !== "public") return;
    let addresses: string[];
    try {
      addresses = this.lookup ? await this.lookup(host) : (await dns.promises.lookup(host, { all: true })).map((a) => a.address);
    } catch {
      throw new TransportError(`Couldn't resolve ${u.host}.`);
    }
    for (const address of addresses) {
      const kind = hostKind(address);
      if (kind === "private" || (kind === "loopback" && this.loopbackProblem(Object.assign(new URL(url), { hostname: "127.0.0.1" })))) {
        throw new McpError("ENDPOINT_REFUSED", `Won't call ${display(url)}: it resolves to a private or local address.`);
      }
    }
  }

  // ---------- DarwinClient ----------

  async startTask(params: StartTaskParams): Promise<TaskHandle> {
    const endpoint = endpointOf(params.agent);
    if (!endpoint) throw new McpError("NO_ENDPOINT", `${params.agent.name} has no MCP endpoint to call directly.`);
    const problem = this.endpointProblem(endpoint.url);
    if (problem) throw new McpError("ENDPOINT_REFUSED", `Won't call ${display(endpoint.url)}: ${problem}.`);

    // Connecting happens here, so a dropped connection surfaces as a transport error the engine retries.
    let session: Session;
    let tool: McpTool;
    try {
      session = await this.connect(endpoint.url);
      tool = this.pickTool(await this.listTools(session), endpoint, params.context.capability);
    } catch (err) {
      if (err instanceof GateError) return this.gatedHandle(err, params);
      throw err;
    }

    const args = params.arguments && Object.keys(params.arguments).length ? params.arguments : this.fallbackArguments(tool, params);
    const taskId = `mcp_${crypto.createHash("sha256").update(params.idempotencyKey).digest("hex").slice(0, 16)}`;
    const job: Job = { session, controller: new AbortController(), progress: 0, startedAt: this.now() };
    this.remember(taskId, job);
    void this.runCall(job, tool, args);
    return { taskId, threadId: taskId, startedAt: this.now() };
  }

  async pollTask(handle: TaskHandle): Promise<TaskPoll> {
    const job = this.jobs.get(handle.taskId);
    if (!job) return { status: "error", cursor: "", code: "TASK_UNKNOWN", message: "This direct call is no longer tracked (the server restarted?).", retryable: false };
    if (job.result) {
      // A finished job is reported once, then forgotten, so answers don't pile up in memory.
      this.jobs.delete(handle.taskId);
      return job.result;
    }
    // A tool call is one open request: while it's open the agent is working, so the cursor moves every
    // 30 s and the engine's stall check doesn't fire. A hung server is caught by the call timeout.
    const ticks = Math.floor((this.now() - job.startedAt) / 30_000);
    return { status: "running", cursor: `p${job.progress}:${ticks}`, progress: "waiting for the agent's answer" };
  }

  async cancelTask(handle: TaskHandle): Promise<void> {
    const job = this.jobs.get(handle.taskId);
    this.jobs.delete(handle.taskId);
    if (!job) return;
    job.controller.abort();
    await this.closeSession(job.session);
  }

  async healthCheck(agent: AgentRef): Promise<HealthResult> {
    const checkedAt = this.now();
    const endpoint = endpointOf(agent);
    if (!endpoint) return { status: "unavailable", ready: false, detail: "No MCP endpoint to connect to.", checkedAt };
    const problem = this.endpointProblem(endpoint.url);
    if (problem) return { status: "unavailable", ready: false, detail: `Endpoint refused: ${problem}.`, checkedAt };
    try {
      const session = await this.connect(endpoint.url);
      const tools = await this.listTools(session, true);
      void this.closeSession(session);
      const capability = (agent as Partial<RoutedAgent> & { capability?: Capability }).capability ?? capabilityFromId(agent.capabilityId);
      const tool = this.pickTool(tools, endpoint, capability);
      return { status: "ready", ready: true, detail: `Connected; tool "${tool.name}" answers.`, checkedAt };
    } catch (err) {
      if (err instanceof GateError) return { status: "not_ready", ready: false, detail: `${err.message} Unattended runs can't sign in.`, checkedAt };
      return { status: "unavailable", ready: false, detail: clip((err as Error).message, 200), checkedAt };
    }
  }

  /** Server name and tools an endpoint offers, for setup (picking the tool and reading its argument schema). */
  async describeEndpoint(url: string): Promise<{ serverName?: string; tools: McpTool[] }> {
    const problem = this.endpointProblem(url);
    if (problem) throw new McpError("ENDPOINT_REFUSED", `Won't call ${display(url)}: ${problem}.`);
    let session: Session;
    try {
      session = await this.connect(url);
    } catch (err) {
      if (err instanceof GateError) throw new McpError("NEEDS_SIGN_IN", `${err.message} Unattended runs can't sign in.`);
      throw err;
    }
    try {
      return { serverName: session.serverName, tools: await this.listTools(session, true) };
    } finally {
      void this.closeSession(session);
    }
  }

  /** The tool that fits a capability, or null when it isn't clear. */
  suggestTool(tools: McpTool[], capability: Capability): McpTool | null {
    if (tools.length === 1) return tools[0];
    return tools.find((t) => CAPABILITY_WORDS[capability].test(`${t.name} ${t.description}`)) ?? null;
  }

  // ---------- internals ----------

  private remember(taskId: string, job: Job): void {
    const replaced = this.jobs.get(taskId);
    if (replaced && replaced !== job) replaced.controller.abort();
    this.jobs.delete(taskId);
    this.jobs.set(taskId, job);
    while (this.jobs.size > MAX_JOBS) {
      const [oldId, old] = this.jobs.entries().next().value as [string, Job];
      old.controller.abort();
      this.jobs.delete(oldId);
    }
  }

  /** A sign-in or payment request at connect time: report it on the first poll, like Act does. */
  private gatedHandle(err: GateError, params: StartTaskParams): TaskHandle {
    const taskId = `mcp_gate_${crypto.randomUUID().slice(0, 8)}`;
    const job: Job = { session: { url: "", protocol: PROTOCOL_VERSION }, controller: new AbortController(), progress: 0, startedAt: this.now() };
    job.result = { status: "blocked", cursor: "", kind: err.kind, message: `${params.agent.name}: ${err.message}` };
    this.remember(taskId, job);
    return { taskId, threadId: taskId, startedAt: this.now() };
  }

  private async runCall(job: Job, tool: McpTool, args: Record<string, unknown>): Promise<void> {
    const timer = setTimeout(() => job.controller.abort(), this.callTimeoutMs);
    try {
      const result = await this.rpc(job.session, "tools/call", { name: tool.name, arguments: args }, {
        signal: job.controller.signal,
        onProgress: () => job.progress++,
      });
      job.result = this.toPoll(result, job);
    } catch (err) {
      if (job.controller.signal.aborted && !job.result) {
        job.result = { status: "error", cursor: `p${job.progress}`, code: "CALL_ABORTED", message: "The direct call was stopped.", retryable: false };
      } else if (err instanceof GateError) {
        job.result = { status: "blocked", cursor: `p${job.progress}`, kind: err.kind, message: err.message };
      } else {
        const code = err instanceof McpError ? err.code : err instanceof TransportError ? "TRANSPORT" : "CALL_FAILED";
        job.result = { status: "error", cursor: `p${job.progress}`, code, message: clip((err as Error).message, 300), retryable: false };
      }
    } finally {
      clearTimeout(timer);
      void this.closeSession(job.session);
    }
  }

  private toPoll(result: unknown, job: Job): TaskPoll {
    const r = (result && typeof result === "object" ? result : {}) as { content?: unknown; structuredContent?: unknown; isError?: unknown };
    const parts = Array.isArray(r.content) ? r.content : [];
    const text = parts
      .filter((p): p is { type: string; text: string } => !!p && typeof p === "object" && (p as { type?: unknown }).type === "text" && typeof (p as { text?: unknown }).text === "string")
      .map((p) => p.text)
      .join("\n")
      .trim();
    const cursor = `done${job.progress}`;
    if (r.isError === true) {
      return { status: "error", cursor, code: "TOOL_ERROR", message: `The agent reported an error: ${clip(text || "no details", 300)}`, retryable: false };
    }
    const output = r.structuredContent !== undefined && r.structuredContent !== null ? r.structuredContent : text;
    if (output === "" || output === undefined) {
      return { status: "error", cursor, code: "EMPTY_RESULT", message: "The agent's tool returned nothing.", retryable: false };
    }
    return { status: "completed", cursor, output, raw: { content: parts.slice(0, 20), structuredContent: r.structuredContent ?? null } };
  }

  private pickTool(tools: McpTool[], endpoint: AgentEndpoint, capability: Capability | undefined): McpTool {
    if (!tools.length) throw new McpError("NO_TOOLS", `${display(endpoint.url)} lists no tools.`);
    if (endpoint.toolName) {
      const named = tools.find((t) => t.name === endpoint.toolName);
      if (!named) throw new McpError("TOOL_MISSING", `Tool "${endpoint.toolName}" is no longer offered by ${display(endpoint.url)}.`);
      return named;
    }
    if (tools.length === 1) return tools[0];
    const re = capability ? CAPABILITY_WORDS[capability] : undefined;
    const match = re && tools.find((t) => re.test(`${t.name} ${t.description}`));
    if (match) return match;
    throw new McpError("TOOL_AMBIGUOUS", `${display(endpoint.url)} offers ${tools.length} tools and none clearly fits; pick one during setup.`);
  }

  /** Arguments from the tool's schema by property name, when the input adapter didn't map any. */
  private fallbackArguments(tool: McpTool, params: StartTaskParams): Record<string, unknown> {
    const mapping = heuristicMapping(tool.inputSchema, params.context.input);
    const template = AGENT_TEMPLATES.find((t) => t.capability === params.context.capability) ?? getTemplate("crawl");
    return applyMapping(mapping, tool.inputSchema, params.context.input, params.instruction || buildInstruction(template, params.context.input));
  }

  private async connect(url: string): Promise<Session> {
    await this.checkResolved(url);
    const session: Session = { url, protocol: PROTOCOL_VERSION };
    const init = (await this.rpc(session, "initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "axolotl", version: "0.1.0" },
    })) as { protocolVersion?: unknown; serverInfo?: { name?: unknown } } | undefined;
    if (typeof init?.protocolVersion === "string") session.protocol = init.protocolVersion;
    if (typeof init?.serverInfo?.name === "string") session.serverName = clip(init.serverInfo.name, 80);
    await this.notify(session, "notifications/initialized");
    return session;
  }

  private async listTools(session: Session, fresh = false): Promise<McpTool[]> {
    const cached = this.toolCache.get(session.url);
    if (!fresh && cached && this.now() - cached.at < 10 * 60_000) return cached.tools;
    const res = (await this.rpc(session, "tools/list", {})) as { tools?: unknown } | undefined;
    const tools = (Array.isArray(res?.tools) ? res.tools : [])
      .filter((t): t is Record<string, unknown> => !!t && typeof t === "object" && typeof (t as { name?: unknown }).name === "string")
      .slice(0, 100)
      .map((t) => ({
        name: String(t.name),
        description: typeof t.description === "string" ? clip(t.description, 500) : "",
        inputSchema: t.inputSchema && typeof t.inputSchema === "object" ? (t.inputSchema as Record<string, unknown>) : null,
      }));
    this.toolCache.set(session.url, { tools, at: this.now() });
    if (this.toolCache.size > 100) this.toolCache.delete(this.toolCache.keys().next().value as string);
    return tools;
  }

  private headers(session: Session): Record<string, string> {
    const h: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": session.protocol,
    };
    if (session.id) h["mcp-session-id"] = session.id;
    return h;
  }

  private async notify(session: Session, method: string): Promise<void> {
    const res = await this.send(session, { jsonrpc: "2.0", method }, AbortSignal.timeout(this.requestTimeoutMs));
    await res.body?.cancel().catch(() => undefined);
  }

  private async closeSession(session: Session): Promise<void> {
    if (!session.id || !session.url) return;
    try {
      const res = await this.fetchImpl(session.url, { method: "DELETE", headers: this.headers(session), redirect: "manual", signal: AbortSignal.timeout(5_000) });
      await res.body?.cancel().catch(() => undefined);
    } catch {
      // Best effort: the server expires idle sessions itself.
    }
  }

  private async send(session: Session, msg: Rpc, signal: AbortSignal): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchImpl(session.url, { method: "POST", headers: this.headers(session), body: JSON.stringify(msg), redirect: "manual", signal });
    } catch (err) {
      if (signal.aborted && (signal.reason as Error | undefined)?.name !== "TimeoutError") throw err;
      const why = signal.aborted ? `no answer within ${Math.round(this.requestTimeoutMs / 1000)}s` : (err as Error).message;
      throw new TransportError(`Couldn't reach ${display(session.url)} (${clip(why, 120)}).`);
    }
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel().catch(() => undefined);
      throw new GateError("authentication", `The agent at ${display(session.url)} needs a sign-in (HTTP ${res.status}).`);
    }
    if (res.status === 402) {
      await res.body?.cancel().catch(() => undefined);
      throw new GateError("payment", `The agent at ${display(session.url)} asks for payment (HTTP 402). Axolotl never pays.`);
    }
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => undefined);
      throw new McpError("REDIRECT", `${display(session.url)} redirected; Axolotl doesn't follow redirects from agent endpoints.`);
    }
    if (res.status === 429 || res.status >= 500) {
      await res.body?.cancel().catch(() => undefined);
      throw new TransportError(`${display(session.url)} answered HTTP ${res.status}.`);
    }
    return res;
  }

  private async rpc(
    session: Session,
    method: string,
    params: Record<string, unknown>,
    opts: { signal?: AbortSignal; onProgress?: () => void } = {},
  ): Promise<unknown> {
    const id = this.nextId++;
    const signal = opts.signal ?? AbortSignal.timeout(this.requestTimeoutMs);
    const res = await this.send(session, { jsonrpc: "2.0", id, method, params }, signal);
    if (method === "initialize") session.id = res.headers.get("mcp-session-id") ?? undefined;
    if (!res.ok) {
      const body = await readCapped(res).catch(() => "");
      throw new McpError("HTTP_" + res.status, `${display(session.url)} answered HTTP ${res.status} to ${method}${body ? `: ${clip(body.replace(/\s+/g, " "), 160)}` : ""}.`);
    }
    const type = (res.headers.get("content-type") ?? "").toLowerCase();
    let answer: { found: boolean; value?: unknown } = { found: false };
    const take = (m: unknown): boolean => {
      if (!m || typeof m !== "object") return false;
      const msg = m as { id?: unknown; method?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown } };
      if (msg.method === "notifications/progress") opts.onProgress?.();
      if (msg.id !== id) return false;
      if (msg.error) {
        throw new McpError(`RPC_${String(msg.error.code ?? "ERROR")}`, `${method} failed: ${clip(String(msg.error.message ?? "unknown error"), 200)}`);
      }
      answer = { found: true, value: msg.result };
      return true;
    };
    if (type.includes("text/event-stream")) await streamSse(res, take);
    else take(parseJson(await readCapped(res)));
    if (answer.found) return answer.value;
    throw new McpError("NO_RESPONSE", `${display(session.url)} sent no answer to ${method}.`);
  }
}

function endpointOf(agent: AgentRef): AgentEndpoint | undefined {
  const e = (agent as Partial<RoutedAgent>).endpoint;
  return e && e.protocol === "MCP" && typeof e.url === "string" ? e : undefined;
}

function capabilityFromId(capabilityId: string): Capability | undefined {
  return AGENT_TEMPLATES.map((t) => t.capability).find((c): c is Capability => !!c && capabilityId.toLowerCase().includes(c));
}

async function readCapped(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new McpError("TOO_LARGE", `The agent's answer is over ${MAX_BODY_BYTES / 1024 / 1024} MB.`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Reads an SSE body as it arrives, handing each JSON-RPC message to `onMessage`. Stops as soon as
 * `onMessage` returns true (the answer arrived), even if the server keeps the stream open.
 */
async function streamSse(res: Response, onMessage: (m: unknown) => boolean): Promise<void> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (value) {
        size += value.byteLength;
        if (size > MAX_BODY_BYTES) throw new McpError("TOO_LARGE", `The agent's answer is over ${MAX_BODY_BYTES / 1024 / 1024} MB.`);
        buffer += decoder.decode(value, { stream: true });
      }
      if (done) buffer += "\n\n";
      let cut: RegExpExecArray | null;
      while ((cut = /\r?\n\r?\n/.exec(buffer))) {
        const block = buffer.slice(0, cut.index);
        buffer = buffer.slice(cut.index + cut[0].length);
        for (const m of parseSse(block)) if (onMessage(m)) return;
      }
      if (done) return;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** JSON-RPC messages from an SSE body: each event's data lines joined. */
export function parseSse(text: string): unknown[] {
  const out: unknown[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) continue;
    const parsed = parseJson(data);
    if (Array.isArray(parsed)) out.push(...parsed);
    else if (parsed !== undefined) out.push(parsed);
  }
  return out;
}
