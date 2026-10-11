// Pure mapping from Darwin v3 payloads (docs/darwin/openapi-v3.json) to Axolotl types.
// Every read is tolerant: unknown or missing fields fall back to safe defaults.
import { AGENT_TEMPLATES } from "@/config/workflow";
import type { AgentCandidate, AgentEndpoint, Capability, DeclaredState, ListingTerms } from "@/lib/types";
import type { SearchResult, TaskPoll } from "@/lib/darwin/types";

export type Rec = Record<string, unknown>;

// ---------- tolerant readers ----------

export function asRecord(v: unknown): Rec | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : null;
}

export function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export function asRecords(v: unknown): Rec[] {
  return Array.isArray(v) ? v.map(asRecord).filter((r): r is Rec => r !== null) : [];
}

function asStrings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
}

function nonEmpty(v: unknown): string | undefined {
  const s = asString(v)?.trim();
  return s ? s : undefined;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// ---------- search ----------

const CAPABILITY_PATTERNS: [Capability, RegExp][] = [
  ["links", /\b(broken|dead)\s+links?\b|\blink\s*check/i],
  ["security", /\bsecurity\b|\bssl\b|\btls\b|\bhsts\b|\bcsp\b/i],
  ["accessibility", /\baccessib|\bwcag\b|\ba11y\b/i],
  ["performance", /\bperformance\b|\blighthouse\b|\bpage\s*speed\b|\bcore web vitals\b/i],
  ["seo", /\bseo\b|\bsearch engine optimi[sz]ation\b|\bmeta descriptions?\b/i],
  ["crawl", /\bcrawl|\bspider\b|\bsitemap\b|\blist (?:its |the |all )?pages\b/i],
];

/** Capability a query is looking for: exact workflow query first, then keywords. */
export function inferCapability(query: string): Capability | null {
  const q = query.trim().toLowerCase();
  const template = AGENT_TEMPLATES.find((t) => t.query?.toLowerCase() === q);
  if (template?.capability) return template.capability;
  return CAPABILITY_PATTERNS.find(([, re]) => re.test(q))?.[0] ?? null;
}

const ID_PREFIX_PROVIDERS: [string, string][] = [
  ["mcp-agent:", "MCP server"],
  ["protocol-agent:", "Protocol agent"],
  ["a2a", "A2A agent"],
];

const RUNTIME_PROVIDERS: Record<string, string> = {
  REMOTE_MCP: "MCP server",
  LOCAL_STDIO: "Local MCP (stdio)",
  A2A_JSONRPC: "A2A agent",
  HTTP_JSON: "HTTP API",
  OPENAPI_HTTP: "HTTP API",
  BOUNDED_FETCH: "Fetch",
  BROWSER: "Browser",
  X402_PAYMENT: "x402",
  COMMERCE: "Commerce",
};

const PROTOCOL_PROVIDERS: Record<string, string> = { MCP: "MCP server", A2A: "A2A agent", WEBMCP: "WebMCP" };

/**
 * The v3 agent record has no provider/publisher field, so this is a display label
 * derived from the agentId prefix, then the indexed runtime kind, then the protocol.
 */
export function deriveProvider(agent: Rec): string {
  const agentId = (asString(agent.agentId) ?? "").toLowerCase();
  const byPrefix = ID_PREFIX_PROVIDERS.find(([prefix]) => agentId.startsWith(prefix));
  if (byPrefix) return byPrefix[1];
  const runtime = asRecord(asRecord(agent.executionRequirements)?.runtime);
  const byRuntime = RUNTIME_PROVIDERS[asString(runtime?.kind) ?? ""];
  if (byRuntime) return byRuntime;
  const protocol = asString(asRecords(agent.connectionMethods)[0]?.protocol) ?? "";
  return PROTOCOL_PROVIDERS[protocol] ?? "Darwin listing";
}

export interface AgentMappingContext {
  capability: Capability;
  searchId: string;
  index: number;
}

/**
 * MCP endpoint Darwin has verified for this agent, if any. Darwin's docs: endpointUrl null or
 * endpointStatus "not_published" means no verified route, and WebMCP runs only in a browser.
 */
export function verifiedMcpEndpoint(agent: Rec): AgentEndpoint | undefined {
  for (const m of asRecords(agent.connectionMethods)) {
    const url = nonEmpty(m.endpointUrl);
    if (m.protocol !== "MCP" || m.environment !== "remote_client" || m.endpointStatus !== "verified" || !url) continue;
    if (!/^https:\/\//i.test(url)) continue;
    return { protocol: "MCP", url, origin: "darwin" };
  }
  return undefined;
}

function declared(v: unknown): DeclaredState | undefined {
  if (v === "REQUIRED") return "required";
  if (v === "NOT_REQUIRED" || v === "NOT_APPLICABLE") return "not_required";
  if (v === "UNKNOWN") return "unknown";
  return undefined;
}

/**
 * What the listing declares about sign-in, payment and runtime, from Darwin's executionRequirements.
 * Many records leave it null; the trust check then reads those as "not declared", not as safe.
 */
export function listingTerms(agent: Rec): ListingTerms | undefined {
  const er = asRecord(agent.executionRequirements);
  if (!er) return undefined;
  const auth = asRecord(er.providerAuthentication);
  const payment = asRecord(er.payment);
  const runtime = asRecord(er.runtime);
  const creds = asRecord(er.operationCredentials);
  const terms: ListingTerms = {
    auth: declared(auth?.state),
    authMechanisms: asStrings(auth?.mechanisms).filter((m) => m !== "UNSPECIFIED"),
    payment: declared(payment?.state),
    paymentTerms: nonEmpty(payment?.termsDigest),
    runtime: nonEmpty(runtime?.kind),
    secretInputs: creds?.state === "REQUIRED" ? asStrings(creds.sensitiveInputNames) : [],
    evidence: nonEmpty(auth?.evidence),
  };
  return terms;
}

/** Returns null for records without the identifiers Act needs. */
export function mapAgent(agent: Rec, ctx: AgentMappingContext): AgentCandidate | null {
  const agentId = nonEmpty(agent.agentId);
  const capabilityId = nonEmpty(agent.capabilityId);
  if (!agentId || !capabilityId) return null;
  const rank = typeof agent.rank === "number" && Number.isFinite(agent.rank) ? agent.rank : ctx.index + 1;
  return {
    agentId,
    capabilityId,
    name: nonEmpty(agent.name) ?? agentId,
    source: "darwin",
    provider: deriveProvider(agent),
    capability: ctx.capability,
    description: asString(agent.description) ?? "",
    readiness: nonEmpty(agent.readiness) ?? "unavailable",
    canStartThread: agent.canStartThread === true,
    reasons: asStrings(agent.reasons),
    uncertainties: asStrings(agent.uncertainties),
    requiredSetup: agent.requiredSetup ?? null,
    connectionPrompt: asString(agent.connectionPrompt),
    providerCheck: asString(agent.providerCheck),
    rank,
    searchId: ctx.searchId,
    // The spec only reports whether an input schema exists (providerContract.inputSchema
    // is a status enum); the schema itself is never returned.
    argumentSchema: null,
    endpoint: verifiedMcpEndpoint(agent),
    terms: listingTerms(agent),
  };
}

/** Plain-language note for the UI: no-match reason, clarifying question, or assessment. */
export function searchNote(status: string, response: Rec): string | undefined {
  const explanation = nonEmpty(asRecord(response.assessment)?.explanation);
  const noMatch = nonEmpty(response.noMatchReason);
  const question = nonEmpty(response.question);
  if (status === "no_match") return noMatch ?? explanation;
  if (status === "needs_input") {
    const parts = [explanation, question && `Darwin asks: ${question}`].filter(Boolean);
    return parts.length ? parts.join(" ") : undefined;
  }
  return explanation ?? noMatch ?? nonEmpty(response.overview);
}

export interface SearchMappingContext {
  query: string;
  capability: Capability;
  maxResults: number;
}

/** Maps an AdaptiveSearchResponse. Returns null when the payload lacks a searchId. */
export function mapSearchResponse(body: unknown, ctx: SearchMappingContext): SearchResult | null {
  const root = asRecord(body);
  const searchId = nonEmpty(root?.searchId);
  if (!root || !searchId) return null;
  const status = nonEmpty(root.status) ?? "completed";
  const response = asRecord(root.response) ?? {};
  const agents = asRecords(response.agents)
    .map((a, index) => mapAgent(a, { capability: ctx.capability, searchId, index }))
    .filter((a): a is AgentCandidate => a !== null)
    .slice(0, ctx.maxResults);
  return {
    searchId,
    status,
    query: ctx.query,
    agents,
    note: searchNote(status, response),
    searchToken: nonEmpty(root.searchToken),
  };
}

// ---------- Act thread state ----------

/** Thread state accumulated across incremental Get Act request reads. */
export interface ThreadState {
  threadId: string;
  actRequestId?: string;
  requestStatus?: string;
  /** Thread-level errorCode from the Act request receipt. */
  errorCode?: string;
  messages: Map<string, Rec>;
  errors: Map<string, Rec>;
  actions: Map<string, Rec>;
  requests: Map<string, Rec>;
  cursor?: string;
  hasMore: boolean;
  archived: boolean;
  needsAttention: boolean;
}

export function newThreadState(threadId: string, actRequestId?: string): ThreadState {
  return {
    threadId,
    actRequestId,
    messages: new Map(),
    errors: new Map(),
    actions: new Map(),
    requests: new Map(),
    hasMore: false,
    archived: false,
    needsAttention: false,
  };
}

function upsert(target: Map<string, Rec>, items: Rec[], key: (r: Rec) => string | undefined): void {
  for (const item of items) {
    const k = key(item) ?? `anon:${target.size}`;
    target.set(k, item);
  }
}

export interface MergeOptions {
  /**
   * Start a new read: actions and requests are current state (not paged by the cursor),
   * so the first page of each read replaces them. Messages and errors accumulate.
   */
  replaceCurrent?: boolean;
}

/** Merges one ActV3 thread receipt (`threads[]` entry) into the accumulated state. */
export function mergeThread(state: ThreadState, thread: Rec, requestStatus?: string, opts: MergeOptions = {}): ThreadState {
  if (requestStatus) state.requestStatus = requestStatus;
  const errorCode = nonEmpty(thread.errorCode);
  if (errorCode) state.errorCode = errorCode;
  const s = asRecord(thread.state);
  if (!s) return state;
  if (opts.replaceCurrent && Array.isArray(s.actions)) state.actions.clear();
  if (opts.replaceCurrent && Array.isArray(s.requests)) state.requests.clear();
  upsert(state.messages, asRecords(s.messages), (m) => asString(m.message));
  upsert(state.errors, asRecords(s.errors), (e) => [asString(e.event), asString(e.code)].filter(Boolean).join(":") || undefined);
  upsert(state.actions, asRecords(s.actions), (a) => asString(a.action));
  upsert(state.requests, asRecords(s.requests), (r) => asString(r.request));
  const cursor = nonEmpty(s.cursor);
  if (cursor) state.cursor = cursor;
  state.hasMore = s.hasMore === true;
  state.archived = s.archived === true;
  state.needsAttention = s.needsAttention === true;
  return state;
}

/** Picks the thread for `threadId` from an ActV3 response body (falls back to the only thread). */
export function pickThread(body: unknown, threadId: string): Rec | null {
  const threads = asRecords(asRecord(body)?.threads);
  return threads.find((t) => asString(t.threadId) === threadId) ?? (threads.length === 1 ? threads[0] : null);
}

const SECRET_KEY = /token|secret|password|passwd|api[-_]?key|authorization|credential|cookie/i;

/** Deep copy without secret-looking keys. Darwin's public projections omit secrets already. */
export function stripSecrets(v: unknown, depth = 0): unknown {
  if (depth > 12) return null;
  if (Array.isArray(v)) return v.map((x) => stripSecrets(x, depth + 1));
  const rec = asRecord(v);
  if (!rec) return v;
  const out: Rec = {};
  for (const [k, val] of Object.entries(rec)) {
    if (!SECRET_KEY.test(k)) out[k] = stripSecrets(val, depth + 1);
  }
  return out;
}

export function threadSnapshot(state: ThreadState): Rec {
  return stripSecrets({
    actRequestId: state.actRequestId,
    requestStatus: state.requestStatus,
    threadId: state.threadId,
    errorCode: state.errorCode,
    messages: [...state.messages.values()],
    actions: [...state.actions.values()],
    requests: [...state.requests.values()],
    errors: [...state.errors.values()],
    cursor: state.cursor,
    hasMore: state.hasMore,
    archived: state.archived,
    needsAttention: state.needsAttention,
  }) as Rec;
}

// ---------- result extraction ----------

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isStructured(v: unknown): boolean {
  return v !== null && typeof v === "object";
}

/** End index (exclusive) of the balanced JSON value starting at `start`, string-aware. */
function balancedEnd(text: string, start: number): number {
  const stack: string[] = [];
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === "\"") inString = false;
      continue;
    }
    if (c === "\"") inString = true;
    else if (c === "{" || c === "[") stack.push(c === "{" ? "}" : "]");
    else if (c === "}" || c === "]") {
      if (stack.pop() !== c) return -1;
      if (stack.length === 0) return i + 1;
    }
  }
  return -1;
}

const MAX_SCAN_CANDIDATES = 200;

/**
 * JSON object/array in free text: the first fenced code block that parses, then the
 * whole text, then the longest balanced {...} or [...] that parses. Longest, so prose
 * like "[1]" or "[]" before the payload (or a list of markdown links) doesn't win.
 */
export function extractJson(text: string): unknown {
  for (const m of text.matchAll(/```[a-zA-Z0-9_-]*[ \t]*\r?\n?([\s\S]*?)```/g)) {
    const parsed = tryJson(m[1].trim());
    if (isStructured(parsed)) return parsed;
  }
  const whole = tryJson(text.trim());
  if (isStructured(whole)) return whole;
  let best: unknown;
  let bestLength = 0;
  let attempts = 0;
  for (let i = 0; i < text.length && attempts < MAX_SCAN_CANDIDATES; i++) {
    if (text[i] !== "{" && text[i] !== "[") continue;
    attempts++;
    const end = balancedEnd(text, i);
    if (end < 0) continue;
    const parsed = tryJson(text.slice(i, end));
    if (!isStructured(parsed)) continue;
    if (end - i > bestLength) {
      best = parsed;
      bestLength = end - i;
    }
    i = end - 1; // values nested inside this one are shorter
  }
  return best;
}

function messageText(message: Rec): string {
  return asRecords(message.content)
    .filter((c) => c.type === "text")
    .map((c) => asString(c.text) ?? "")
    .join("\n")
    .trim();
}

/**
 * Output of a result message: `data` (JSON inside a string `data` is parsed), else JSON
 * in the text, else the text, else the content parts.
 */
export function resultOutput(message: Rec): unknown {
  const data = message.data;
  if (typeof data === "string") {
    const parsed = extractJson(data);
    if (parsed !== undefined) return parsed;
  } else if (data !== undefined && data !== null) {
    return data;
  }
  const text = messageText(message);
  if (text) return extractJson(text) ?? text;
  if (typeof data === "string" && data.trim()) return data;
  return asRecords(message.content);
}

function latest(messages: Rec[]): Rec | undefined {
  let best: Rec | undefined;
  let bestAt = -Infinity;
  for (const m of messages) {
    const at = Date.parse(asString(m.createdAt) ?? "");
    const t = Number.isFinite(at) ? at : bestAt;
    if (t >= bestAt) {
      best = m;
      bestAt = t;
    }
  }
  return best;
}

// ---------- thread state → TaskPoll ----------

const FAILED_ACTION = new Set(["failed", "cancelled", "withdrawn"]);
const AUTH_REQUESTS = new Set(["authentication_request", "authentication_required"]);

function pendingRequests(state: ThreadState, types: Set<string>): Rec[] {
  return [...state.requests.values()].filter((r) => r.status === "pending" && types.has(asString(r.type) ?? ""));
}

function authMessage(r: Rec): string {
  const what = asString(r.authenticationType);
  const target = asString(r.resource) ?? asString(r.targetAgent) ?? "the provider";
  const scopes = asStrings(r.scopes);
  const scopeText = scopes.length ? ` (scopes: ${scopes.join(", ")})` : "";
  return `Agent needs ${what ? `${what} ` : ""}authentication for ${target}${scopeText}. ` +
    "Connect the account in Darwin; unattended runs can't continue.";
}

function paymentMessage(r: Rec): string {
  const payee = asString(asRecord(r.payee)?.name) ?? "the provider";
  const amount = asString(r.amountMinor) ?? "?";
  const currency = asString(r.currency) ?? "";
  return `Agent requests a payment of ${amount} ${currency} (minor units) to ${payee}. Axolotl never authorizes payments.`;
}

function approvalMessage(r: Rec): string {
  if (r.type === "action_request") {
    const cap = asString(r.capability) ?? "a capability";
    return `Darwin is waiting for confirmation of action request ${asString(r.request) ?? ""} (${cap}). Axolotl does not auto-confirm actions.`;
  }
  const reason = nonEmpty(r.reason);
  return `Agent asks for approval${reason ? `: ${truncate(reason, 300)}` : "."}`;
}

function blockedPoll(state: ThreadState, cursor: string): TaskPoll | null {
  const auth = pendingRequests(state, AUTH_REQUESTS)[0];
  if (auth) return { status: "blocked", cursor, kind: "authentication", message: authMessage(auth) };
  const payment = pendingRequests(state, new Set(["payment_request"]))[0];
  if (payment) return { status: "blocked", cursor, kind: "payment", message: paymentMessage(payment) };
  const approval = pendingRequests(state, new Set(["approval_request", "action_request"]))[0];
  if (approval) return { status: "blocked", cursor, kind: "approval", message: approvalMessage(approval) };
  return null;
}

function failurePoll(state: ThreadState, cursor: string): TaskPoll | null {
  const fatal = [...state.errors.values()].filter((e) => e.retryable !== true);
  const err = fatal[fatal.length - 1];
  if (err) {
    const code = asString(err.code) ?? "THREAD_ERROR";
    const action = asString(err.action);
    const message = `Darwin reported ${code} on thread event ${asString(err.event) ?? "?"}${action ? ` (action ${action})` : ""}.`;
    return { status: "error", cursor, code, message, retryable: false };
  }
  const failed = [...state.actions.values()].find((a) => FAILED_ACTION.has(asString(a.status) ?? ""));
  if (failed) {
    const status = asString(failed.status) ?? "failed";
    const cap = asString(failed.capability) ?? "capability";
    return {
      status: "error",
      cursor,
      code: `ACTION_${status.toUpperCase()}`,
      message: `Darwin action ${asString(failed.action) ?? ""} (${cap}) ended with status ${status}.`,
      retryable: false,
    };
  }
  return null;
}

function terminalPoll(state: ThreadState, cursor: string): TaskPoll | null {
  const undelivered = [...state.messages.values()].find((m) => m.from === "you" && m.status === "failed");
  if (undelivered) {
    return { status: "error", cursor, code: "MESSAGE_DELIVERY_FAILED", message: "Darwin could not deliver the instruction to the agent.", retryable: true };
  }
  if (state.archived) {
    return { status: "error", cursor, code: "THREAD_ARCHIVED", message: "The Darwin thread was archived before the agent returned a result.", retryable: false };
  }
  if (state.requestStatus === "failed") {
    return { status: "error", cursor, code: "ACT_REQUEST_FAILED", message: "The Darwin Act request failed.", retryable: false };
  }
  return null;
}

function progressText(state: ThreadState): string {
  const actions = [...state.actions.values()];
  const action = actions[actions.length - 1];
  if (action) return `action ${asString(action.status) ?? "pending"}`;
  const reply = latest([...state.messages.values()].filter((m) => m.from === "agent"));
  if (reply) return `agent replied: ${truncate(messageText(reply), 160)}`;
  return "waiting for the agent";
}

/**
 * Maps accumulated thread state to a TaskPoll. Precedence: thread errorCode, pending
 * authentication / payment / approval, non-retryable errors and failed actions, an agent
 * result, then undelivered/archived/failed request, else running.
 */
export function mapThreadState(state: ThreadState): TaskPoll {
  const cursor = state.cursor ?? "";
  if (state.errorCode) {
    return { status: "error", cursor, code: state.errorCode, message: `Darwin thread error: ${state.errorCode}.`, retryable: false };
  }
  const gate = blockedPoll(state, cursor) ?? failurePoll(state, cursor);
  if (gate) return gate;
  const result = latest([...state.messages.values()].filter((m) => m.type === "result" && m.from === "agent"));
  if (result) return { status: "completed", cursor, output: resultOutput(result), raw: threadSnapshot(state) };
  return terminalPoll(state, cursor) ?? { status: "running", cursor, progress: progressText(state) };
}
