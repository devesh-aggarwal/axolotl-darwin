// RealDarwinClient: public Darwin Search plus Act v3 (pilot preview, allowlisted credentials).
// Coded against docs/darwin/openapi-v3.json; see docs/darwin/API-NOTES.md.
import { env } from "@/lib/env";
import type { AgentRef, Capability } from "@/lib/types";
import {
  TransportError,
  type DarwinClient,
  type HealthResult,
  type SearchOptions,
  type SearchResult,
  type StartTaskParams,
  type TaskHandle,
  type TaskPoll,
} from "@/lib/darwin/types";
import {
  asRecord,
  asRecords,
  asString,
  inferCapability,
  mapSearchResponse,
  mapThreadState,
  mergeThread,
  newThreadState,
  pickThread,
  type ThreadState,
} from "@/lib/darwin/normalize";

export interface RealDarwinClientOptions {
  apiBase?: string;
  /** OAuth access token with a live `human:actions` grant (Act; also used for Search when set). */
  accessToken?: string;
  /** Application API key, sent as `x-api-key` for Search when no access token is set. */
  apiKey?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

export interface RealSearchOptions extends SearchOptions {
  /** Continue a previous Search response (AdaptiveSearchRequest.previousResponseId). */
  previousResponseId?: string;
  /** Don't retry anonymously when the credential is rejected (one request per search, for capped scripts). */
  noAnonymousRetry?: boolean;
}

/** Non-transport Darwin failure (bad request, access denied, thread error, missing config). */
export class DarwinApiError extends Error {
  readonly code: string;
  readonly status: number | null;
  readonly retryable: boolean;
  constructor(code: string, message: string, status: number | null = null, retryable = false) {
    super(message);
    this.name = "DarwinApiError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

/** Transient failure (network, timeout, 5xx, 429). The engine retries once with the same key. */
export class DarwinTransportError extends TransportError {
  readonly code: string;
  readonly status: number | null;
  readonly retryAfterSeconds: number | null;
  constructor(code: string, message: string, status: number | null = null, retryAfterSeconds: number | null = null) {
    super(message);
    this.code = code;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_MESSAGE_CHARS = 32_000;
const MAX_POLL_PAGES = 5;
const MAX_SEARCH_TOKENS = 200;
const MAX_THREADS = 500;
const PENDING_ACTION = new Set(["awaiting_confirmation", "queued", "running", "waiting", "reconciling"]);

const SECRET_PATTERNS: RegExp[] = [
  /Bearer\s+[^\s"',;]+/gi,
  /eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g,
  /\bsk-[\w-]{10,}/g,
  /((?:api[-_]?key|token|secret|password|authorization)["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi,
];

function clampInt(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(Number.isFinite(v) ? v : min)));
}

/** Darwin's Error schema is { code, message }; a nested { error: {...} } is tolerated. */
function errorBody(body: unknown): { code?: string; message?: string } {
  const root = asRecord(body);
  const inner = asRecord(root?.error) ?? root;
  return { code: asString(inner?.code) ?? asString(root?.code), message: asString(inner?.message) ?? asString(root?.message) };
}

function remember<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value as K);
}

type Method = "GET" | "POST";

export class RealDarwinClient implements DarwinClient {
  readonly kind = "real" as const;
  private readonly apiBase: string;
  private readonly accessToken: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  /** Anonymous Search tokens by searchId. In memory only; never logged. */
  private readonly searchTokens = new Map<string, string>();
  private readonly threads = new Map<string, ThreadState>();

  constructor(opts: RealDarwinClientOptions = {}) {
    this.apiBase = (opts.apiBase ?? env.darwinApiBase).replace(/\/+$/, "");
    this.accessToken = opts.accessToken ?? env.darwinAccessToken;
    this.apiKey = opts.apiKey ?? env.darwinApiKey;
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    this.now = opts.now ?? Date.now;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** True when an Act credential is configured (it may still lack pilot access). */
  get actConfigured(): boolean {
    return this.accessToken.length > 0;
  }

  /** Search token for a searchId, for server-side Act handoffs only. */
  searchTokenFor(searchId: string): string | undefined {
    return this.searchTokens.get(searchId);
  }

  // ---------- Search ----------

  async search(query: string, opts: RealSearchOptions = {}): Promise<SearchResult> {
    const q = query.trim();
    if (!q) throw new DarwinApiError("SEARCH_QUERY_EMPTY", "Darwin Search needs a non-empty query.");
    const maxResults = clampInt(opts.maxResults ?? 8, 1, 20);
    // The live API rejects unknown keys, so send only spec'd fields.
    const body: Record<string, unknown> = { query: q.slice(0, 20_000), maxResults };
    if (opts.previousResponseId) body.previousResponseId = opts.previousResponseId;
    const res = await this.searchRequest(body, Boolean(opts.previousResponseId), opts.noAnonymousRetry === true);
    const capability: Capability = opts.capability ?? inferCapability(q) ?? "crawl";
    const result = mapSearchResponse(res, { query: q, capability, maxResults });
    if (!result) throw new DarwinApiError("DARWIN_BAD_RESPONSE", "Darwin Search returned a response without a searchId.");
    if (result.searchToken) remember(this.searchTokens, result.searchId, result.searchToken, MAX_SEARCH_TOKENS);
    return result;
  }

  // ---------- Act ----------

  async startTask(params: StartTaskParams): Promise<TaskHandle> {
    this.requireAct();
    if (!params.instruction.trim()) throw new DarwinApiError("INSTRUCTION_EMPTY", "Act needs a non-empty message for the agent.");
    if (params.instruction.length > MAX_MESSAGE_CHARS) {
      throw new DarwinApiError("INSTRUCTION_TOO_LONG", `Act messages are limited to ${MAX_MESSAGE_CHARS} characters.`);
    }
    const target: Record<string, unknown> = { agentId: params.agent.agentId };
    if (params.agent.capabilityId) target.capabilityId = params.agent.capabilityId;
    // Sending `arguments` (even {}) asks for a tool execution; omitting them keeps the thread text-only.
    if (params.arguments && Object.keys(params.arguments).length > 0) target.arguments = params.arguments;
    const body = { targets: [target], message: params.instruction };
    const headers = { ...this.actHeaders(), "Idempotency-Key": params.idempotencyKey };
    const res = await this.request("POST", "/v3/act", "start", headers, body);
    return this.handleFromStart(res, params.agent);
  }

  async pollTask(handle: TaskHandle, cursor?: string): Promise<TaskPoll> {
    const fallbackCursor = cursor ?? "";
    if (!this.actConfigured) return this.errorPoll(fallbackCursor, this.notConfigured());
    if (!handle.actRequestId) {
      return this.errorPoll(fallbackCursor, new DarwinApiError("ACT_REQUEST_ID_MISSING", "Task handle has no Darwin actRequestId."));
    }
    const state = this.threadState(handle.threadId, handle.actRequestId);
    try {
      await this.readThread(state, handle.actRequestId, cursor || state.cursor);
    } catch (err) {
      if (err instanceof DarwinApiError) return this.errorPoll(state.cursor ?? fallbackCursor, err);
      throw err;
    }
    return mapThreadState(state);
  }

  async cancelTask(handle: TaskHandle): Promise<void> {
    const state = this.threads.get(handle.threadId);
    this.threads.delete(handle.threadId);
    if (!this.actConfigured || !state) return;
    const pending = [...state.actions.values()].filter(
      (a) => PENDING_ACTION.has(asString(a.status) ?? "") && a.cancellationRequested !== true,
    );
    for (const action of pending) {
      const operationId = asString(action.action);
      if (!operationId) continue;
      const body = { threadId: handle.threadId, message: { type: "cancellation_request", operationId } };
      const headers = { ...this.actHeaders(), "Idempotency-Key": `cancel:${handle.threadId}:${operationId}` };
      try {
        await this.request("POST", "/v3/act", "cancel", headers, body);
      } catch {
        // Best effort: the engine has already given up on this attempt.
      }
    }
  }

  /** Readiness is per route and only checked by Act at thread start, so this reports configuration. */
  async healthCheck(): Promise<HealthResult> {
    const checkedAt = this.now();
    if (!this.actConfigured) {
      return { status: "unverified", ready: false, detail: "Darwin Act credentials not configured; readiness can't be checked anonymously.", checkedAt };
    }
    return { status: "unverified", ready: true, detail: "Act credentials present; route readiness is checked when a thread starts.", checkedAt };
  }

  // ---------- internals: Act ----------

  private requireAct(): void {
    if (!this.actConfigured) throw this.notConfigured();
  }

  private notConfigured(): DarwinApiError {
    return new DarwinApiError(
      "ACT_NOT_CONFIGURED",
      "Darwin Act is not configured: set DARWIN_ACCESS_TOKEN to an allowlisted OAuth token with human:actions. Search works without it.",
    );
  }

  private handleFromStart(body: unknown, agent: AgentRef): TaskHandle {
    const root = asRecord(body);
    const actRequestId = asString(root?.actRequestId);
    if (!root || root.type !== "request" || !actRequestId) {
      throw new DarwinApiError("DARWIN_BAD_RESPONSE", "Darwin Act did not return an Act request receipt.");
    }
    const threads = asRecords(root.threads);
    const thread = threads.find((t) => t.agentId === agent.agentId) ?? threads[0];
    if (!thread) throw new DarwinApiError("ACT_NO_THREAD", "Darwin Act returned no thread for the target agent.");
    const errorCode = asString(thread.errorCode);
    if (errorCode) {
      throw new DarwinApiError(errorCode, `Darwin could not start a thread with "${agent.name}" (${errorCode}).`);
    }
    const threadId = asString(thread.threadId);
    if (!threadId) throw new DarwinApiError("ACT_NO_THREAD", "Darwin Act returned a thread receipt without a threadId.");
    mergeThread(this.threadState(threadId, actRequestId), thread, asString(root.status));
    return { taskId: actRequestId, threadId, actRequestId, startedAt: this.now() };
  }

  private threadState(threadId: string, actRequestId: string): ThreadState {
    const existing = this.threads.get(threadId);
    if (existing) return existing;
    const state = newThreadState(threadId, actRequestId);
    remember(this.threads, threadId, state, MAX_THREADS);
    return state;
  }

  /** Reads pages of thread state while Darwin reports more. */
  private async readThread(state: ThreadState, actRequestId: string, cursor: string | undefined): Promise<void> {
    let pageCursor = cursor;
    for (let page = 0; page < MAX_POLL_PAGES; page++) {
      const qs = new URLSearchParams({ includeThreadState: "true", threadId: state.threadId, limit: "100" });
      if (pageCursor) qs.set("cursor", pageCursor);
      const path = `/v3/act/requests/${encodeURIComponent(actRequestId)}?${qs.toString()}`;
      const res = await this.request("GET", path, "poll", this.actHeaders());
      const thread = pickThread(res, state.threadId);
      if (!thread) throw new DarwinApiError("ACT_THREAD_MISSING", "Darwin's Act request no longer lists this thread.");
      mergeThread(state, thread, asString(asRecord(res)?.status), { replaceCurrent: page === 0 });
      if (!state.hasMore || !state.cursor || state.cursor === pageCursor) return;
      pageCursor = state.cursor;
    }
  }

  private errorPoll(cursor: string, err: DarwinApiError): TaskPoll {
    return { status: "error", cursor, code: err.code, message: err.message, retryable: err.retryable };
  }

  // ---------- internals: HTTP ----------

  private async searchRequest(body: Record<string, unknown>, continuation: boolean, noRetry = false): Promise<unknown> {
    const headers = this.searchHeaders();
    try {
      return await this.request("POST", "/v3/search", "search", headers, body);
    } catch (err) {
      // Search is public: a rejected credential (401) or one missing a scope (403) should not
      // block discovery. A 403 on a continuation is about ownership, which anonymity can't fix.
      const rejected = err instanceof DarwinApiError && (err.status === 401 || (err.status === 403 && !continuation));
      if (rejected && !noRetry && Object.keys(headers).length > 0) {
        return this.request("POST", "/v3/search", "search", {}, body);
      }
      throw err;
    }
  }

  private searchHeaders(): Record<string, string> {
    if (this.accessToken) return { Authorization: `Bearer ${this.accessToken}` };
    if (this.apiKey) return { "x-api-key": this.apiKey };
    return {};
  }

  private actHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.accessToken}` };
  }

  private async request(method: Method, path: string, op: string, headers: Record<string, string>, body?: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const label = `${method} ${path.split("?")[0]}`;
    try {
      const res = await this.fetchImpl(`${this.apiBase}${path}`, {
        method,
        headers: { Accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const text = await res.text();
      const parsed = text ? this.parseJson(text) : undefined;
      if (!res.ok) throw this.httpError(res.status, parsed, res.headers, op, label);
      if (parsed === undefined) throw new DarwinTransportError("DARWIN_BAD_RESPONSE", `Darwin returned a non-JSON body for ${label}.`, res.status);
      return parsed;
    } catch (err) {
      if (err instanceof DarwinApiError || err instanceof TransportError) throw err;
      if (controller.signal.aborted) {
        throw new DarwinTransportError("DARWIN_TIMEOUT", `Darwin did not respond within ${Math.round(this.timeoutMs / 1000)}s (${label}).`);
      }
      const detail = err instanceof Error ? err.message : String(err);
      throw new DarwinTransportError("DARWIN_NETWORK", `Darwin request failed (${label}): ${this.redact(detail)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private parseJson(text: string): unknown {
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  }

  private httpError(status: number, body: unknown, headers: Headers, op: string, label: string): Error {
    const parsed = errorBody(body);
    const code = parsed.code ? this.redact(parsed.code).slice(0, 120) : undefined;
    const detail = parsed.message ? `: ${this.redact(parsed.message).slice(0, 300)}` : "";
    if (status === 429) {
      const retryAfter = Number(headers.get("retry-after"));
      const seconds = Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : null;
      const wait = seconds !== null ? `Retry-After ${seconds}s` : "no Retry-After header; back off before retrying";
      return new DarwinTransportError(code ?? "RATE_LIMITED", `Darwin rate limit hit on ${label} (429; ${wait}).`, status, seconds);
    }
    if (status >= 500 || status === 408) {
      return new DarwinTransportError(code ?? "DARWIN_UNAVAILABLE", `Darwin is unavailable (${label} returned ${status}${code ? ` ${code}` : ""}).`, status);
    }
    if (code === "ACT_PREVIEW_ACCESS_REQUIRED") {
      return new DarwinApiError(
        code,
        "Darwin Act is a pilot preview and this credential is not on Darwin's Act allowlist (ACT_PREVIEW_ACCESS_REQUIRED). Search still works; request Act pilot access or run with the mock client.",
        status,
      );
    }
    if (status === 401) {
      const advice = op === "search" ? "Darwin Search required authentication" : "Darwin rejected the credential. Refresh DARWIN_ACCESS_TOKEN";
      return new DarwinApiError(code ?? "DARWIN_UNAUTHORIZED", `${advice} (401${code ? ` ${code}` : ""})${detail}`, status);
    }
    const fallback = status === 403 ? "DARWIN_FORBIDDEN" : status === 404 ? "DARWIN_NOT_FOUND" : status === 409 ? "DARWIN_CONFLICT" : "DARWIN_BAD_REQUEST";
    const what = op === "search" ? "Darwin Search" : "Darwin Act";
    return new DarwinApiError(code ?? fallback, `${what} rejected the request (${status}${code ? ` ${code}` : ""})${detail}`, status);
  }

  /** Strips configured credentials, search tokens and token-shaped strings from text. */
  private redact(text: string): string {
    let out = text;
    for (const secret of [this.accessToken, this.apiKey, ...this.searchTokens.values()]) {
      if (secret && secret.length >= 6) out = out.split(secret).join("[redacted]");
    }
    for (const re of SECRET_PATTERNS) {
      out = out.replace(re, (match, prefix?: string) => (typeof prefix === "string" ? `${prefix}[redacted]` : "[redacted]"));
    }
    return out;
  }
}
