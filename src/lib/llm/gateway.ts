// The ONLY module allowed to call OpenAI. Every call passes hard budget caps that are
// checked and incremented synchronously before any await, so parallel callers and
// retry loops in calling code cannot spend past a cap.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getDb } from "@/lib/db";
import { env } from "@/lib/env";

export type LlmPurpose = "judge" | "adapter" | "fixplan" | "translate" | "test";

export type LlmUnavailableReason =
  | "disabled"
  | "no_key"
  | "budget_process"
  | "budget_day"
  | "budget_run"
  | "http"
  | "timeout"
  | "parse";

export class LlmUnavailableError extends Error {
  readonly reason: LlmUnavailableReason;
  readonly status?: number;
  constructor(reason: LlmUnavailableReason, message: string, status?: number) {
    super(sanitizeSecrets(message));
    this.name = "LlmUnavailableError";
    this.reason = reason;
    this.status = status;
  }
}

export interface RunLlmBudget {
  limit: number;
  used: number;
}

export interface CallLlmOptions {
  purpose: LlmPurpose;
  system: string;
  user: string;
  schemaName: string;
  schema: Record<string, unknown>;
  maxOutputTokens?: number;
  runBudget?: RunLlmBudget;
  cache?: boolean;
  /** Caller's shape check. Failing data is a "parse" error and is never cached. */
  validate?: (data: unknown) => boolean;
}

export interface LlmCallResult<T> {
  data: T;
  cached: boolean;
  usage?: { input: number; output: number };
}

export interface LlmUsage {
  model: string;
  keyPresent: boolean;
  disabled: boolean;
  processCalls: number;
  dayCalls: number;
  day: string;
  callsLastMinute: number;
  inFlight: number;
  queued: number;
  limits: {
    perProcess: number;
    perDay: number;
    perMinute: number;
    concurrency: number;
    maxOutputTokens: number;
    timeoutMs: number;
  };
  inputTokens: number;
  outputTokens: number;
  dayInputTokens: number;
  dayOutputTokens: number;
  cacheHits: number;
  lastError?: string;
}

const OPENAI_URL = "https://api.openai.com/v1/responses";
const ROLLING_WINDOW_MS = 60_000;
const USAGE_FILE = "llm-usage.json";
const USAGE_DAYS_KEPT = 30;
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** The usage-file lock is held for a few ms; one older than this was left by a crashed process. */
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 2_000;

/** Absolute ceilings that no env value can raise. */
const HARD_CEILING = {
  perProcess: 200,
  perDay: 1_000,
  perMinute: 20,
  concurrency: 3,
  maxOutputTokens: 4_000,
  timeoutMs: 120_000,
};
const MIN_OUTPUT_TOKENS = 16;

type Limits = typeof HARD_CEILING;
type FetchImpl = (input: string, init: RequestInit) => Promise<Response>;

interface DayUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

interface GatewayState {
  processCalls: number;
  callTimes: number[];
  inFlight: number;
  waiters: (() => void)[];
  inputTokens: number;
  outputTokens: number;
  cacheHits: number;
  lastError?: string;
  pending: Map<string, Promise<LlmCallResult<unknown>>>;
  fetchImpl: FetchImpl | null;
  limitOverrides: Partial<Limits>;
}

// Kept on globalThis so hot reloads and duplicate module instances share one budget.
const g = globalThis as unknown as { __axolotlLlm?: GatewayState };

function state(): GatewayState {
  if (!g.__axolotlLlm) {
    g.__axolotlLlm = {
      processCalls: 0,
      callTimes: [],
      inFlight: 0,
      waiters: [],
      inputTokens: 0,
      outputTokens: 0,
      cacheHits: 0,
      pending: new Map(),
      fetchImpl: null,
      limitOverrides: {},
    };
  }
  return g.__axolotlLlm;
}

// ---------- secrets ----------

/** Removes API keys and bearer tokens from any text before it is logged, stored or thrown. */
export function sanitizeSecrets(text: string): string {
  let out = text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/sk-[A-Za-z0-9_-]+/g, "[redacted-key]");
  const key = env.openaiApiKey;
  if (key && key.length >= 8) out = out.split(key).join("[redacted-key]");
  return out;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// ---------- limits ----------

function boundedEnv(value: number, ceiling: number): number {
  return Number.isFinite(value) ? Math.min(Math.floor(value), ceiling) : 0;
}

function limits(): Limits {
  const o = state().limitOverrides;
  const base: Limits = {
    perProcess: boundedEnv(env.llmMaxCallsPerProcess, HARD_CEILING.perProcess),
    perDay: boundedEnv(env.llmMaxCallsPerDay, HARD_CEILING.perDay),
    perMinute: HARD_CEILING.perMinute,
    concurrency: HARD_CEILING.concurrency,
    maxOutputTokens: Math.max(MIN_OUTPUT_TOKENS, boundedEnv(env.llmMaxOutputTokens, HARD_CEILING.maxOutputTokens)),
    timeoutMs: Math.max(1_000, boundedEnv(env.llmTimeoutMs, HARD_CEILING.timeoutMs)),
  };
  // Overrides can only tighten a limit, never loosen it. Non-numeric overrides are ignored, so
  // no limit can become NaN (a NaN output cap would serialize as null, i.e. uncapped).
  const tighten = (k: keyof Limits) => {
    const v = o[k];
    return typeof v === "number" && Number.isFinite(v) ? Math.min(base[k], Math.floor(v)) : base[k];
  };
  return {
    perProcess: tighten("perProcess"),
    perDay: tighten("perDay"),
    perMinute: tighten("perMinute"),
    concurrency: Math.max(1, tighten("concurrency")),
    maxOutputTokens: tighten("maxOutputTokens"),
    timeoutMs: Math.max(1, tighten("timeoutMs")),
  };
}

function isDisabled(): boolean {
  const v = (process.env.AXOLOTL_LLM_DISABLED || "").toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

// ---------- persisted per-day counter ----------

function localDay(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function usageFilePath(): string {
  return path.resolve(process.cwd(), env.dataDir, USAGE_FILE);
}

type UsageFile = Record<string, DayUsage>;

/** Throws when the file exists but cannot be read: the daily cap fails closed. */
function readUsageFile(): UsageFile {
  let raw: string;
  try {
    raw = fs.readFileSync(usageFilePath(), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new LlmUnavailableError("budget_day", `Cannot read ${USAGE_FILE}; live LLM calls are blocked until it is readable.`);
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as UsageFile;
  } catch {
    throw new LlmUnavailableError(
      "budget_day",
      `${USAGE_FILE} is corrupt; live LLM calls are blocked until it is fixed or removed.`,
    );
  }
}

/** Throws when the day's entry exists but its call count is unusable, so a damaged entry fails closed. */
function dayEntry(file: UsageFile, day: string): DayUsage {
  const e = file[day] as unknown;
  if (e === undefined) return { calls: 0, inputTokens: 0, outputTokens: 0 };
  const calls = e && typeof e === "object" ? Number((e as DayUsage).calls) : NaN;
  if (!Number.isFinite(calls) || calls < 0) {
    throw new LlmUnavailableError("budget_day", `${USAGE_FILE} has an unreadable entry for ${day}; live LLM calls are blocked.`);
  }
  const r = e as Partial<DayUsage>;
  return { calls, inputTokens: Number(r.inputTokens) || 0, outputTokens: Number(r.outputTokens) || 0 };
}

function writeUsageFile(file: UsageFile): void {
  const days = Object.keys(file).filter((d) => DAY_KEY_RE.test(d)).sort().slice(-USAGE_DAYS_KEPT);
  const pruned: UsageFile = {};
  for (const d of days) pruned[d] = file[d];
  const target = usageFilePath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(pruned, null, 2));
  fs.renameSync(tmp, target);
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function breakStaleLock(lock: string): void {
  try {
    if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.unlinkSync(lock);
  } catch {
    // Already released by its holder.
  }
}

/**
 * Cross-process mutex around a read-modify-write of the usage file. Other processes (the
 * server, scripts) share the daily cap, and without it concurrent writers lose updates.
 * Synchronous on purpose: the caller's check-and-increment must not yield. Fails closed.
 */
function withUsageLock<T>(fn: () => T): T {
  const lock = `${usageFilePath()}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  let fd: number | null = null;
  while (fd === null) {
    try {
      fs.mkdirSync(path.dirname(lock), { recursive: true });
      fd = fs.openSync(lock, "wx");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new LlmUnavailableError("budget_day", `Cannot lock ${USAGE_FILE}; live LLM calls are blocked.`);
      }
      breakStaleLock(lock);
      if (Date.now() > deadline) {
        throw new LlmUnavailableError("budget_day", `${USAGE_FILE} is locked by another process; live LLM calls are blocked.`);
      }
      sleepSync(2 + Math.floor(Math.random() * 4));
    }
  }
  try {
    return fn();
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // The descriptor is released with the process anyway; the unlink below is what matters.
    }
    try {
      fs.unlinkSync(lock);
    } catch {
      // Removed as stale by another process; nothing to release.
    }
  }
}

function addDayTokens(input: number, output: number): void {
  try {
    withUsageLock(() => {
      const file = readUsageFile();
      const day = localDay();
      const e = dayEntry(file, day);
      file[day] = { ...e, inputTokens: e.inputTokens + input, outputTokens: e.outputTokens + output };
      writeUsageFile(file);
    });
  } catch {
    // Token totals are informational; the call count was already persisted.
  }
}

// ---------- reservation (synchronous check-and-increment) ----------

function pruneCallTimes(s: GatewayState, now: number): void {
  while (s.callTimes.length && now - s.callTimes[0] >= ROLLING_WINDOW_MS) s.callTimes.shift();
}

/** Checks every cap in order and, only if all pass, increments every counter. Never awaits. */
function reserveCall(runBudget: RunLlmBudget | undefined): void {
  const s = state();
  const lim = limits();
  const now = Date.now();
  if (isDisabled()) throw new LlmUnavailableError("disabled", "Live LLM calls are disabled (AXOLOTL_LLM_DISABLED).");
  if (!env.openaiApiKey) throw new LlmUnavailableError("no_key", "No OpenAI API key is configured.");
  // Written as !(used < limit) so a NaN limit blocks instead of allowing unlimited calls.
  if (!(s.processCalls < lim.perProcess)) {
    throw new LlmUnavailableError("budget_process", `Per-process LLM cap reached (${s.processCalls}/${lim.perProcess} calls).`);
  }
  pruneCallTimes(s, now);
  if (!(s.callTimes.length < lim.perMinute)) {
    throw new LlmUnavailableError("budget_process", `LLM rate guard: at most ${lim.perMinute} calls per minute.`);
  }
  withUsageLock(() => {
    const file = readUsageFile();
    const day = localDay(new Date(now));
    const today = dayEntry(file, day);
    if (!(today.calls < lim.perDay)) {
      throw new LlmUnavailableError("budget_day", `Daily LLM cap reached (${today.calls}/${lim.perDay} calls on ${day}).`);
    }
    if (runBudget && !(runBudget.used < runBudget.limit)) {
      throw new LlmUnavailableError("budget_run", `Run LLM budget used up (${runBudget.used}/${runBudget.limit} calls).`);
    }
    // Persist the day counter first: if it cannot be written, nothing is sent.
    file[day] = { ...today, calls: today.calls + 1 };
    try {
      writeUsageFile(file);
    } catch {
      throw new LlmUnavailableError("budget_day", `Cannot persist ${USAGE_FILE}; live LLM calls are blocked.`);
    }
  });
  s.processCalls += 1;
  s.callTimes.push(now);
  if (runBudget) runBudget.used += 1;
}

// ---------- concurrency slots ----------

function acquireSlot(): Promise<void> {
  const s = state();
  if (s.inFlight < limits().concurrency) {
    s.inFlight += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => s.waiters.push(resolve));
}

function releaseSlot(): void {
  const s = state();
  const next = s.waiters.shift();
  if (next) next(); // hand the slot over directly
  else s.inFlight = Math.max(0, s.inFlight - 1);
}

// ---------- cache ----------

function cacheKey(opts: CallLlmOptions): string {
  const parts = [env.openaiModel, opts.purpose, opts.schemaName, JSON.stringify(opts.schema), opts.system, opts.user];
  return crypto.createHash("sha256").update(parts.join("|")).digest("hex");
}

interface CachedEntry {
  data: unknown;
  usage?: { input: number; output: number };
}

function readCache(hash: string, validate?: (data: unknown) => boolean): CachedEntry | null {
  try {
    const row = getDb().prepare("SELECT response_json FROM llm_cache WHERE hash = ?").get(hash) as
      | { response_json: string }
      | undefined;
    if (!row) return null;
    const parsed = JSON.parse(row.response_json) as CachedEntry;
    if (!parsed || !("data" in parsed)) return null;
    return !validate || validate(parsed.data) ? parsed : null;
  } catch {
    return null;
  }
}

function writeCache(hash: string, purpose: LlmPurpose, entry: CachedEntry): void {
  try {
    getDb()
      .prepare("INSERT OR REPLACE INTO llm_cache (hash, purpose, response_json, created_at) VALUES (?, ?, ?, ?)")
      .run(hash, purpose, JSON.stringify(entry), Date.now());
  } catch {
    // A cache write failure only costs a future call; the caps still apply.
  }
}

// ---------- request / response ----------

function buildBody(opts: CallLlmOptions): Record<string, unknown> {
  const cap = limits().maxOutputTokens;
  // A non-finite request (NaN) would serialize as null and lift the cap entirely.
  const m = opts.maxOutputTokens;
  const requested = typeof m === "number" && Number.isFinite(m) ? Math.floor(m) : cap;
  return {
    model: env.openaiModel,
    instructions: opts.system,
    input: opts.user,
    max_output_tokens: Math.max(MIN_OUTPUT_TOKENS, Math.min(requested, cap)),
    reasoning: { effort: "low" },
    text: { format: { type: "json_schema", name: opts.schemaName, strict: true, schema: opts.schema } },
  };
}

interface ResponsesContent {
  type?: string;
  text?: string;
  refusal?: string;
}
interface ResponsesBody {
  status?: string;
  output_text?: unknown;
  output?: { type?: string; content?: ResponsesContent[] }[];
  usage?: { input_tokens?: number; output_tokens?: number };
  incomplete_details?: { reason?: string } | null;
  error?: { message?: string } | null;
}

function httpErrorMessage(status: number, bodyText: string): string {
  let detail = "";
  try {
    const parsed = JSON.parse(bodyText) as { error?: { message?: unknown } } | null;
    if (typeof parsed?.error?.message === "string") detail = parsed.error.message;
  } catch {
    detail = bodyText;
  }
  detail = clip(sanitizeSecrets(detail.replace(/\s+/g, " ").trim()), 200);
  return `OpenAI HTTP ${status}${detail ? `: ${detail}` : ""}`;
}

function extractText(body: ResponsesBody): string {
  if (typeof body.output_text === "string" && body.output_text.trim()) return body.output_text;
  const texts: string[] = [];
  for (const item of Array.isArray(body.output) ? body.output : []) {
    if (item?.type !== "message") continue;
    for (const c of Array.isArray(item.content) ? item.content : []) {
      if (c?.type === "output_text" && typeof c.text === "string") texts.push(c.text);
      if (c?.type === "refusal") throw new LlmUnavailableError("parse", `Model refused: ${clip(String(c.refusal ?? ""), 160)}`);
    }
  }
  return texts.join("");
}

function parseResponseBody<T>(bodyText: string): { data: T; usage?: { input: number; output: number } } {
  let body: ResponsesBody;
  try {
    body = JSON.parse(bodyText) as ResponsesBody;
  } catch {
    throw new LlmUnavailableError("parse", "OpenAI response was not valid JSON.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new LlmUnavailableError("parse", "OpenAI response was not a JSON object.");
  }
  if (body.status === "incomplete") {
    const why = body.incomplete_details?.reason ?? "unknown reason";
    throw new LlmUnavailableError("parse", `OpenAI response incomplete (${why}); the JSON output was cut off.`);
  }
  if (body.status === "failed") {
    throw new LlmUnavailableError("http", `OpenAI response failed: ${clip(String(body.error?.message ?? "no detail"), 200)}`);
  }
  const text = extractText(body);
  if (!text.trim()) throw new LlmUnavailableError("parse", "OpenAI response contained no output text.");
  let data: T;
  try {
    data = JSON.parse(text) as T;
  } catch {
    throw new LlmUnavailableError("parse", "Model output was not valid JSON.");
  }
  const u = body.usage;
  const usage = u ? { input: Number(u.input_tokens) || 0, output: Number(u.output_tokens) || 0 } : undefined;
  return { data, usage };
}

/** Exactly one network request. No retries, ever. */
async function sendOnce<T>(opts: CallLlmOptions): Promise<{ data: T; usage?: { input: number; output: number } }> {
  const doFetch: FetchImpl = state().fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  const controller = new AbortController();
  const timeoutMs = limits().timeoutMs;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await doFetch(OPENAI_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.openaiApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(buildBody(opts)),
      signal: controller.signal,
    });
    const bodyText = await res.text();
    if (!res.ok) throw new LlmUnavailableError("http", httpErrorMessage(res.status, bodyText), res.status);
    return parseResponseBody<T>(bodyText);
  } catch (err) {
    if (err instanceof LlmUnavailableError) throw err;
    if (controller.signal.aborted) throw new LlmUnavailableError("timeout", `OpenAI request timed out after ${timeoutMs} ms.`);
    const msg = err instanceof Error ? err.message : String(err);
    throw new LlmUnavailableError("http", `OpenAI request failed: ${clip(msg, 160)}`);
  } finally {
    clearTimeout(timer);
  }
}

async function runReserved<T>(opts: CallLlmOptions, hash: string, useCache: boolean): Promise<LlmCallResult<T>> {
  const s = state();
  await acquireSlot();
  try {
    const { data, usage } = await sendOnce<T>(opts);
    if (usage) {
      s.inputTokens += usage.input;
      s.outputTokens += usage.output;
      addDayTokens(usage.input, usage.output);
    }
    if (opts.validate && !opts.validate(data)) {
      throw new LlmUnavailableError("parse", `Model output did not match the expected ${opts.schemaName} shape.`);
    }
    if (useCache) writeCache(hash, opts.purpose, { data, usage });
    return { data, cached: false, usage };
  } catch (err) {
    s.lastError = err instanceof Error ? sanitizeSecrets(err.message) : "unknown error";
    throw err;
  } finally {
    releaseSlot();
  }
}

/**
 * One structured-output call to the OpenAI Responses API, guarded by every cap.
 * Throws LlmUnavailableError when a cap blocks the call or the single request fails.
 */
export function callLlmJson<T>(opts: CallLlmOptions): Promise<LlmCallResult<T>> {
  const s = state();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(opts.schemaName)) {
    return Promise.reject(new LlmUnavailableError("parse", `Invalid schema name "${clip(opts.schemaName, 40)}".`));
  }
  const useCache = opts.cache !== false;
  const hash = cacheKey(opts);
  if (useCache) {
    const hit = readCache(hash, opts.validate);
    if (hit) {
      s.cacheHits += 1;
      return Promise.resolve({ data: hit.data as T, cached: true, usage: hit.usage });
    }
    // An identical request already in flight is shared instead of sent twice.
    const inFlight = s.pending.get(hash);
    if (inFlight) {
      s.cacheHits += 1;
      return inFlight.then((r) => ({ ...(r as LlmCallResult<T>), cached: true }));
    }
  }
  try {
    reserveCall(opts.runBudget);
  } catch (err) {
    if (err instanceof LlmUnavailableError) s.lastError = err.message;
    return Promise.reject(err);
  }
  const p = runReserved<T>(opts, hash, useCache);
  if (useCache) {
    s.pending.set(hash, p as Promise<LlmCallResult<unknown>>);
    const clear = () => s.pending.delete(hash);
    p.then(clear, clear);
  }
  return p;
}

export function getLlmUsage(): LlmUsage {
  const s = state();
  const lim = limits();
  pruneCallTimes(s, Date.now());
  const day = localDay();
  let today: DayUsage = { calls: 0, inputTokens: 0, outputTokens: 0 };
  let fileError: string | undefined;
  try {
    today = dayEntry(readUsageFile(), day);
  } catch (err) {
    fileError = err instanceof Error ? err.message : String(err);
  }
  const lastError = fileError ?? s.lastError;
  return {
    model: env.openaiModel,
    keyPresent: Boolean(env.openaiApiKey),
    disabled: isDisabled(),
    processCalls: s.processCalls,
    dayCalls: today.calls,
    day,
    callsLastMinute: s.callTimes.length,
    inFlight: s.inFlight,
    queued: s.waiters.length,
    limits: { ...lim },
    inputTokens: s.inputTokens,
    outputTokens: s.outputTokens,
    dayInputTokens: today.inputTokens,
    dayOutputTokens: today.outputTokens,
    cacheHits: s.cacheHits,
    ...(lastError ? { lastError: sanitizeSecrets(lastError) } : {}),
  };
}

/** Human-readable reason a live LLM step was skipped (for fallback messages). */
export function describeUnavailable(err: LlmUnavailableError): string {
  switch (err.reason) {
    case "disabled":
      return "live LLM calls are disabled";
    case "no_key":
      return "no OpenAI key configured";
    case "budget_process":
      return "per-process LLM cap or rate guard reached";
    case "budget_day":
      return "daily LLM cap reached";
    case "budget_run":
      return "this run's LLM budget is used up";
    case "timeout":
      return "OpenAI request timed out";
    case "http":
      return err.status ? `OpenAI request failed (HTTP ${err.status})` : "OpenAI request failed";
    case "parse":
      return "unreadable model response";
  }
}

// ---------- test-only helpers ----------

/** TEST ONLY: replace the fetch used for OpenAI requests (null restores globalThis.fetch). */
export function __setLlmFetchForTests(fn: FetchImpl | null): void {
  state().fetchImpl = fn;
}

/** TEST ONLY: reset per-process counters, rolling window, token totals and cache-hit count. */
export function __resetLlmCountersForTests(): void {
  const s = state();
  s.processCalls = 0;
  s.callTimes = [];
  s.inputTokens = 0;
  s.outputTokens = 0;
  s.cacheHits = 0;
  s.lastError = undefined;
}

/** TEST ONLY: tighten limits (values above the configured limits are ignored). Pass {} to clear. */
export function __setLlmLimitsForTests(overrides: Partial<Limits>): void {
  state().limitOverrides = { ...overrides };
}
