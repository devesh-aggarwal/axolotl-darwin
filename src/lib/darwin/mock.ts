// MockDarwinClient: the catalog agents with seeded, configurable behavior. Each attempt's fate is
// planned at start from rngFor(seed, nodeInstanceId, agentId, attemptNo) (or the forced fault) and
// played out over wall-clock time as the engine polls. Outputs come from the local audit toolkit
// (the "perfect agent"), degraded by the agent's recall and voice, and optionally corrupted.
import { load, type CheerioAPI } from "cheerio";
import type { AnyNode, Element } from "domhandler";
import { DEFAULTS } from "@/config/workflow";
import {
  buildIssue,
  fetchPage,
  hrefFromLinkSelector,
  normalizeUrl,
  resolveHttpUrl,
  runCapability,
  sameOrigin,
  siteRootUrl,
  urlsInText,
} from "@/lib/audit";
import { getMockAgent, mockAgentsFor, type MockAgentProfile } from "@/lib/darwin/mockCatalog";
import {
  TransportError,
  type DarwinClient,
  type HealthResult,
  type SearchOptions,
  type SearchResult,
  type StartTaskParams,
  type TaskContext,
  type TaskHandle,
  type TaskPoll,
} from "@/lib/darwin/types";
import { hashString, pickWeighted, randomId, rngFor, sampleLatency } from "@/lib/rng";
import {
  CAPABILITIES,
  SEVERITIES,
  type AgentCandidate,
  type AgentNodeInput,
  type AgentRef,
  type AuditCategory,
  type AuditOutput,
  type Capability,
  type CorruptionKind,
  type CrawlOutput,
  type FaultMode,
  type Issue,
  type Severity,
} from "@/lib/types";

/** One progress tick (cursor step) every 350 ms at timeScale 1. */
const TICK_MS = 350;
/** Clean attempts always finish inside the engine's attempt timeout. */
const MAX_LATENCY_MS = Math.round(DEFAULTS.attemptTimeoutMs * 0.8);
/** Fractions of the attempt latency at which blocks, stalls and provider outages show up. */
const BLOCK_AT = 0.35;
const STALL_AT = 0.3;
const UNAVAILABLE_AT = 0.2;
/** Share of sampled auth blocks that are payment requests instead. */
const PAYMENT_SHARE = 0.2;
const SEARCH_DELAY_MIN_MS = 100;
const SEARCH_DELAY_SPREAD_MS = 200;
const HEALTH_PROBE_MS = 120;
const CLEAN_CACHE_TTL_MS = 120_000;
const CLEAN_CACHE_MAX = 300;
/** Past this many tasks, finished ones older than FINISHED_TTL_MS and any older than TASK_TTL_MS are dropped. */
const TASK_PRUNE_THRESHOLD = 2_000;
const FINISHED_TTL_MS = 5 * 60_000;
const TASK_TTL_MS = 30 * 60_000;
const PAGE_SCOPE = new Set<Capability>(["accessibility", "performance"]);

// ---------- attempt planning ----------

export type MockOutcome = "success" | "error" | "timeout" | "stall" | "auth_block" | "bad_output";
export type MockErrorCode = "AGENT_RUNTIME_ERROR" | "UPSTREAM_5XX" | "TOOL_CRASHED";

interface PlanTiming {
  /** True when the outcome came from context.forcedFault or the agent being down, not from sampling. */
  forced: boolean;
  /** Scaled task latency. */
  latencyMs: number;
  /** Scaled ms after start when the outcome shows: completion and errors at latency, blocks at 35%, a stall's last tick at 30%. */
  eventMs: number;
}

export type MockAttemptPlan = PlanTiming &
  (
    | { outcome: "success" }
    | { outcome: "bad_output"; corruption: CorruptionKind }
    | { outcome: "error"; error: { code: MockErrorCode; message: string } }
    | { outcome: "auth_block"; block: { kind: "authentication" | "payment"; message: string } }
    | { outcome: "timeout" }
    | { outcome: "stall" }
  );

const FORCED_OUTCOME: Record<FaultMode, MockOutcome> = {
  error: "error",
  timeout: "timeout",
  stall: "stall",
  auth_block: "auth_block",
  corrupt: "bad_output",
};

const ERRORS: { code: MockErrorCode; message: (target: string) => string }[] = [
  { code: "AGENT_RUNTIME_ERROR", message: (t) => `Agent runtime exited with code 137 (out of memory) while processing ${t}` },
  { code: "AGENT_RUNTIME_ERROR", message: () => "Unhandled exception in audit step: TypeError: Cannot read properties of undefined (reading 'querySelectorAll')" },
  { code: "UPSTREAM_5XX", message: () => "Provider API returned 502 Bad Gateway after 3 internal retries" },
  { code: "UPSTREAM_5XX", message: () => "Upstream scanning service returned 503 Service Unavailable" },
  { code: "TOOL_CRASHED", message: (t) => `Headless browser crashed (target closed) while navigating to ${t}` },
  { code: "TOOL_CRASHED", message: () => "Tool fetch_page crashed: socket hang up" },
];

const AUTH_PROMPTS: Record<Capability, string> = {
  crawl: "Agent requested OAuth access to Search Console",
  accessibility: "Agent requested sign-in to its provider dashboard to export the WCAG report",
  performance: "Agent requested OAuth access to the site's analytics property",
  seo: "Agent requested OAuth access to Search Console",
  security: "Agent requested DNS provider credentials to verify domain ownership",
  links: "Agent requested OAuth access to Search Console",
};
const PAYMENT_PROMPT = "Agent requested a $4.00 payment for a full scan";

/** Decides how one attempt will go. Pure: the same agent and context always give the same plan. */
export function planMockAttempt(agent: MockAgentProfile, context: TaskContext): MockAttemptPlan {
  const rand = rngFor(context.seed, context.nodeInstanceId, agent.agentId, context.attemptNo);
  // Every draw happens in a fixed order, so a forced fault never shifts the other samples.
  const latencyMs = Math.min(MAX_LATENCY_MS, sampleLatency(rand, agent.meanLatencyMs, agent.jitter)) * timeScaleOf(context);
  const failed = rand() < agent.baseFailureRate;
  const failure = pickWeighted(rand, agent.failureWeights);
  const corruption = pickWeighted(rand, agent.corruptionWeights);
  const errorRoll = rand();
  const paymentRoll = rand();

  if (!agent.healthy) {
    const error = { code: "UPSTREAM_5XX" as const, message: "Provider route unavailable (upstream returned 503)" };
    return { outcome: "error", error, forced: true, latencyMs, eventMs: latencyMs * UNAVAILABLE_AT };
  }
  const forcedOutcome = forcedOutcomeOf(context.forcedFault);
  const outcome = forcedOutcome ?? (failed ? failure : "success");
  const timing = { forced: forcedOutcome !== undefined, latencyMs };
  switch (outcome) {
    case "success":
      return { outcome, ...timing, eventMs: latencyMs };
    case "bad_output":
      return { outcome, corruption, ...timing, eventMs: latencyMs };
    case "error": {
      const pick = ERRORS[Math.min(ERRORS.length - 1, Math.floor(errorRoll * ERRORS.length))];
      return { outcome, error: { code: pick.code, message: pick.message(describeTarget(context.input)) }, ...timing, eventMs: latencyMs };
    }
    case "auth_block": {
      const payment = !timing.forced && paymentRoll < PAYMENT_SHARE;
      const block = payment
        ? { kind: "payment" as const, message: PAYMENT_PROMPT }
        : { kind: "authentication" as const, message: AUTH_PROMPTS[context.capability] ?? AUTH_PROMPTS.crawl };
      return { outcome, block, ...timing, eventMs: latencyMs * BLOCK_AT };
    }
    case "stall":
      return { outcome, ...timing, eventMs: latencyMs * STALL_AT };
    case "timeout":
      return { outcome, ...timing, eventMs: Number.POSITIVE_INFINITY };
  }
}

function forcedOutcomeOf(fault: FaultMode | undefined): MockOutcome | undefined {
  return fault !== undefined && Object.hasOwn(FORCED_OUTCOME, fault) ? FORCED_OUTCOME[fault] : undefined;
}

function timeScaleOf(context: TaskContext): number {
  const s = context.timeScale;
  return Number.isFinite(s) && s > 0 ? s : 1;
}

// ---------- tasks ----------

type TaskResult = { ok: true; output: unknown; raw: unknown } | { ok: false; message: string };

interface MockTask {
  handle: TaskHandle;
  agent: MockAgentProfile;
  context: TaskContext;
  plan: MockAttemptPlan;
  tickMs: number;
  result?: TaskResult;
  /** ms after start when the output finished computing. */
  readyMs?: number;
  cancelledMs?: number;
}

export class MockDarwinClient implements DarwinClient {
  readonly kind = "mock" as const;
  /** By idempotency key. */
  private readonly tasks = new Map<string, MockTask>();
  private readonly byTaskId = new Map<string, MockTask>();
  private readonly cleanOutputs = new Map<string, { at: number; promise: Promise<CrawlOutput | AuditOutput> }>();
  private searches = 0;

  async search(query: string, opts: SearchOptions = {}): Promise<SearchResult> {
    this.searches += 1;
    await delay(SEARCH_DELAY_MIN_MS + (hashString(`${query}|${this.searches}`) % (SEARCH_DELAY_SPREAD_MS + 1)));
    const searchId = randomId("msrch");
    const capability = opts.capability && CAPABILITIES.includes(opts.capability) ? opts.capability : inferCapability(query);
    if (!capability) {
      const note = "No mock agents match this request. Name a capability: crawl, accessibility, performance, SEO, security or broken links.";
      return { searchId, status: "completed", query, agents: [], note };
    }
    const limit = opts.maxResults && opts.maxResults > 0 ? Math.max(1, Math.floor(opts.maxResults)) : Number.POSITIVE_INFINITY;
    const agents = [...mockAgentsFor(capability)]
      .sort((a, b) => a.darwinRank - b.darwinRank)
      .slice(0, limit)
      .map((agent) => toCandidate(agent, searchId));
    return { searchId, status: "completed", query, agents, note: `${agents.length} simulated ${capability} agents, in Darwin rank order.` };
  }

  async startTask(params: StartTaskParams): Promise<TaskHandle> {
    const existing = this.tasks.get(params.idempotencyKey);
    if (existing) return existing.handle;
    const agent = getMockAgent(params.agent.agentId);
    if (!agent) throw new Error(`Mock agent ${clip(params.agent.agentId, 80)} is not in the catalog`);
    this.prune();
    const task = this.createTask(params, agent);
    this.tasks.set(params.idempotencyKey, task);
    this.byTaskId.set(task.handle.taskId, task);
    // Decided once per key: the task exists server-side, only the response was lost, so a retry succeeds.
    const { seed, nodeInstanceId, attemptNo } = params.context;
    if (rngFor(seed, nodeInstanceId, agent.agentId, attemptNo, "transport")() < agent.transportGlitchRate) {
      throw new TransportError("mock transport glitch: connection reset");
    }
    return task.handle;
  }

  async pollTask(handle: TaskHandle, cursor?: string): Promise<TaskPoll> {
    const task = this.byTaskId.get(handle.taskId);
    if (!task) {
      return { status: "error", cursor: cursor ?? "c0", code: "TASK_NOT_FOUND", message: `No mock task ${clip(handle.taskId, 80)}`, retryable: false };
    }
    if (task.cancelledMs !== undefined) {
      return { status: "error", cursor: cursorAt(task, task.cancelledMs), code: "CANCELLED", message: "Task was cancelled before it finished.", retryable: false };
    }
    return pollAt(task, Date.now() - task.handle.startedAt);
  }

  async cancelTask(handle: TaskHandle): Promise<void> {
    const task = this.byTaskId.get(handle.taskId);
    if (!task || task.cancelledMs !== undefined) return;
    const elapsed = Date.now() - task.handle.startedAt;
    if (!isFinished(task, elapsed)) task.cancelledMs = elapsed;
  }

  async healthCheck(agent: AgentRef): Promise<HealthResult> {
    const started = Date.now();
    await delay(HEALTH_PROBE_MS);
    const checkedAt = Date.now();
    const profile = getMockAgent(agent.agentId);
    if (!profile) return { status: "not_ready", ready: false, detail: "Unknown agent: not in the mock catalog", checkedAt };
    if (!profile.healthy) return { status: "not_ready", ready: false, detail: "Provider route unavailable (probe returned 503)", checkedAt };
    return { status: "ready", ready: true, detail: `Probe thread answered in ${checkedAt - started} ms`, checkedAt };
  }

  private createTask(params: StartTaskParams, agent: MockAgentProfile): MockTask {
    const handle: TaskHandle = { taskId: randomId("mtask"), threadId: randomId("mthr"), startedAt: Date.now() };
    const plan = planMockAttempt(agent, params.context);
    const tickMs = Math.max(1, TICK_MS * timeScaleOf(params.context));
    const task: MockTask = { handle, agent, context: params.context, plan, tickMs };
    if (plan.outcome === "success" || plan.outcome === "bad_output") this.produce(task);
    return task;
  }

  /** Computes the output in the background so polls never wait on fetches. */
  private produce(task: MockTask): void {
    const settle = (result: TaskResult) => {
      task.result = result;
      task.readyMs = Date.now() - task.handle.startedAt;
    };
    this.buildOutput(task).then(
      ({ output, raw }) => settle({ ok: true, output, raw }),
      (err: unknown) => settle({ ok: false, message: redact(`Agent failed while auditing: ${errorMessage(err)}`) }),
    );
  }

  private async buildOutput(task: MockTask): Promise<{ output: unknown; raw: unknown }> {
    const { agent, context, plan, handle } = task;
    const clean = await this.cleanOutput(context.capability, context.input);
    const rand = rngFor(context.seed, context.nodeInstanceId, agent.agentId, context.attemptNo, "output");
    const voice = voiceOf(agent);
    const degraded = degradeOutput(context.capability, structuredClone(clean), agent, voice, rand);
    const output =
      plan.outcome === "bad_output"
        ? await corruptOutput(plan.corruption, degraded, corruptionContextFor(context, clean, voice), rand)
        : degraded;
    const raw = { threadId: handle.threadId, agentId: agent.agentId, capabilityId: agent.capabilityId, type: "result", data: output };
    return { output, raw };
  }

  /** The "perfect agent" output, shared by concurrent and repeated identical inputs. */
  private cleanOutput(capability: Capability, input: AgentNodeInput): Promise<CrawlOutput | AuditOutput> {
    const key = `${capability}|${stableKey(input)}`;
    const now = Date.now();
    const hit = this.cleanOutputs.get(key);
    if (hit && now - hit.at < CLEAN_CACHE_TTL_MS) return hit.promise;
    const entry = { at: now, promise: runCapability(capability, input) };
    this.cleanOutputs.delete(key);
    this.cleanOutputs.set(key, entry);
    entry.promise.catch(() => {
      if (this.cleanOutputs.get(key) === entry) this.cleanOutputs.delete(key);
    });
    while (this.cleanOutputs.size > CLEAN_CACHE_MAX) {
      const oldest = this.cleanOutputs.keys().next().value;
      if (oldest === undefined) break;
      this.cleanOutputs.delete(oldest);
    }
    return entry.promise;
  }

  private prune(): void {
    if (this.tasks.size < TASK_PRUNE_THRESHOLD) return;
    const now = Date.now();
    for (const [key, task] of this.tasks) {
      const age = now - task.handle.startedAt;
      const done = task.cancelledMs !== undefined || isFinished(task, age);
      if (age < TASK_TTL_MS && !(done && age > FINISHED_TTL_MS)) continue;
      this.tasks.delete(key);
      this.byTaskId.delete(task.handle.taskId);
    }
  }
}

function pollAt(task: MockTask, elapsed: number): TaskPoll {
  const { plan } = task;
  switch (plan.outcome) {
    case "timeout":
      return running(task, elapsed);
    case "stall":
      return running(task, Math.min(elapsed, plan.eventMs));
    case "auth_block":
      if (elapsed < plan.eventMs) return running(task, elapsed);
      return { status: "blocked", cursor: cursorAt(task, plan.eventMs), kind: plan.block.kind, message: plan.block.message };
    case "error":
      if (elapsed < plan.eventMs) return running(task, elapsed);
      return { status: "error", cursor: cursorAt(task, plan.eventMs), code: plan.error.code, message: plan.error.message, retryable: false };
    case "success":
    case "bad_output": {
      const { result } = task;
      if (elapsed < plan.eventMs || !result) return running(task, elapsed);
      const cursor = cursorAt(task, Math.max(plan.eventMs, task.readyMs ?? 0));
      if (!result.ok) return { status: "error", cursor, code: "AGENT_RUNTIME_ERROR", message: result.message, retryable: false };
      const oracle = plan.outcome === "bad_output" ? { corrupted: true, corruption: plan.corruption } : { corrupted: false };
      return { status: "completed", cursor, output: result.output, raw: result.raw, oracle };
    }
  }
}

function isFinished(task: MockTask, elapsed: number): boolean {
  const { plan } = task;
  if (plan.outcome === "timeout" || plan.outcome === "stall") return false;
  if (plan.outcome === "success" || plan.outcome === "bad_output") return elapsed >= plan.eventMs && task.result !== undefined;
  return elapsed >= plan.eventMs;
}

function running(task: MockTask, elapsed: number): TaskPoll {
  return { status: "running", cursor: cursorAt(task, elapsed), progress: progressText(task, elapsed) };
}

function cursorAt(task: MockTask, elapsedMs: number): string {
  return `c${Math.floor(Math.max(0, elapsedMs) / task.tickMs)}`;
}

function progressText(task: MockTask, elapsed: number): string {
  const { context, plan } = task;
  const share = elapsed / plan.latencyMs;
  if (share < 0.12) return "Starting agent thread";
  if (share < 0.4) return `Loading ${describeTarget(context.input)}`;
  if (share < 0.8) return context.capability === "crawl" ? "Following same-site links" : `Checking ${context.capability} rules`;
  if (share < 1 || plan.outcome !== "timeout") return "Compiling report";
  return "Waiting for the headless browser to respond";
}

// ---------- search ----------

const CAPABILITY_KEYWORDS: Record<Capability, RegExp[]> = {
  crawl: [/\bcrawl/, /\bspider/, /\blist (?:its|the|all) pages\b/, /\bdiscover (?:the )?pages\b/, /\bmap (?:a|the) (?:web)?site\b/],
  accessibility: [/accessib/, /\bwcag\b/, /\ba11y\b/, /screen ?reader/, /\bcontrast\b/, /\balt text\b/],
  performance: [/perform/, /\bspeed\b/, /lighthouse/, /web vitals/, /page ?load/, /\blcp\b/, /\bcls\b/, /page weight/],
  seo: [/\bseo\b/, /search engine/, /meta description/, /\branking/, /indexab/],
  security: [/secur/, /\bheaders?\b/, /\bssl\b/, /\btls\b/, /\bhsts\b/, /\bcsp\b/],
  links: [/\blinks?\b/, /\b404s?\b/, /dead ?links?/, /\bbroken\b/],
};

/** The capability whose keywords the query hits most often (first in CAPABILITIES on ties). */
export function inferCapability(query: string): Capability | undefined {
  const q = query.toLowerCase();
  let best: Capability | undefined;
  let bestScore = 0;
  for (const capability of CAPABILITIES) {
    const score = CAPABILITY_KEYWORDS[capability].filter((re) => re.test(q)).length;
    if (score > bestScore) {
      best = capability;
      bestScore = score;
    }
  }
  return best;
}

function toCandidate(agent: MockAgentProfile, searchId: string): AgentCandidate {
  return {
    agentId: agent.agentId,
    capabilityId: agent.capabilityId,
    name: agent.name,
    source: "mock",
    provider: agent.provider,
    capability: agent.capability,
    description: agent.description,
    readiness: agent.healthy ? "ready" : "unavailable",
    canStartThread: agent.healthy,
    reasons: [...agent.reasons],
    uncertainties: [...agent.uncertainties],
    requiredSetup: null,
    connectionPrompt:
      agent.providerNote ??
      (agent.healthy
        ? "Simulated agent: runs locally against the target site. No connection setup needed."
        : "Provider route is unavailable right now. Re-run the readiness check later."),
    providerCheck: agent.healthy ? "passed" : "failed",
    rank: agent.darwinRank,
    searchId,
    argumentSchema: null,
    terms: agent.terms,
  };
}

// ---------- degradation: recall, severity noise, voice ----------

/** House style an agent writes findings in. */
export type MockVoice = "plain" | "terse" | "tagged" | "narrative";
type Voice = MockVoice;
const VOICES: Voice[] = ["plain", "terse", "tagged", "narrative"];

const WCAG_REFS: Record<string, string> = {
  "image-alt": "WCAG 1.1.1",
  "color-contrast": "WCAG 1.4.3",
  label: "WCAG 1.3.1",
  "button-name": "WCAG 4.1.2",
  "html-has-lang": "WCAG 3.1.1",
};

const IMPACT: Record<AuditCategory, string> = {
  accessibility: "This affects people using assistive technology.",
  performance: "This slows the page down for every visitor.",
  seo: "Search results may show or rank the page poorly because of this.",
  security: "This weakens the site's protection against common browser attacks.",
  links: "Visitors who follow it hit a dead end.",
};

function voiceOf(agent: MockAgentProfile): Voice {
  return VOICES[hashString(agent.agentId) % VOICES.length];
}

/** Rewords an issue in the agent's house style. URLs, selectors, numbers and the rule stay intact. */
function applyVoice(issue: Issue, voice: Voice): Issue {
  switch (voice) {
    case "terse":
      return { ...issue, description: issue.description.replace(/\.$/, "") };
    case "tagged": {
      const tag = Object.hasOwn(WCAG_REFS, issue.rule) ? WCAG_REFS[issue.rule] : issue.rule;
      return { ...issue, description: `[${tag}] ${issue.description}` };
    }
    case "narrative": {
      const impact = Object.hasOwn(IMPACT, issue.category) ? ` ${IMPACT[issue.category]}` : "";
      return { ...issue, description: `${issue.description}${impact}`, evidence: `Evidence: ${issue.evidence}` };
    }
    default:
      return issue;
  }
}

function summaryFor(voice: Voice, agent: MockAgentProfile, issues: Issue[], pages: number): string {
  const n = issues.length;
  const what = `${agent.capability} issue${n === 1 ? "" : "s"}`;
  const where = `${pages} page${pages === 1 ? "" : "s"}`;
  switch (voice) {
    case "terse":
      return `${n} finding${n === 1 ? "" : "s"}`;
    case "tagged":
      return `${agent.name}: ${n} ${what} on ${where}.`;
    case "narrative":
      return n === 0 ? `Checked ${where}; no ${agent.capability} problems stood out.` : `Checked ${where} and found ${n} ${what}. Highest severity: ${highestSeverity(issues)}.`;
    default:
      return `${n} ${what} across ${where}.`;
  }
}

function highestSeverity(issues: Issue[]): Severity {
  return SEVERITIES.find((s) => issues.some((i) => i.severity === s)) ?? "low";
}

function shiftSeverity(issue: Issue, rand: () => number): Issue {
  const i = SEVERITIES.indexOf(issue.severity);
  if (i < 0) return issue;
  const moreSevere = i === SEVERITIES.length - 1 || (i > 0 && rand() < 0.5);
  return { ...issue, severity: SEVERITIES[moreSevere ? i - 1 : i + 1] };
}

function degradeOutput(
  capability: Capability,
  clean: CrawlOutput | AuditOutput,
  agent: MockAgentProfile,
  voice: Voice,
  rand: () => number,
): CrawlOutput | AuditOutput {
  if (capability === "crawl" || isCrawlOutput(clean)) return degradeCrawl(clean as CrawlOutput, rand);
  const audit = clean;
  const kept = audit.issues.filter(() => rand() < agent.recall);
  if (kept.length === 0 && audit.issues.length > 0) kept.push(audit.issues[Math.floor(rand() * audit.issues.length)]);
  const issues = kept.map((issue) => applyVoice(rand() < agent.severityNoise ? shiftSeverity(issue, rand) : issue, voice));
  return { issues, pagesChecked: audit.pagesChecked, summary: summaryFor(voice, agent, issues, audit.pagesChecked.length) };
}

/** Crawl output keeps every page (recall does not apply); some agents list them in another order, home first. */
function degradeCrawl(clean: CrawlOutput, rand: () => number): CrawlOutput {
  const [home, ...rest] = clean.pages;
  if (!home || rand() < 0.5) return clean;
  return { pages: [home, ...shuffle(rest, rand)] };
}

// ---------- corruption ----------

export interface CorruptionContext {
  capability: Capability;
  /** Site root URL. */
  siteUrl: string;
  /** Page-scope audits: the audited page. */
  pageUrl?: string;
  /** Absolute pages in the node's scope. */
  pages: string[];
  /** Pages known to exist; invented pages avoid these. */
  knownPages: string[];
  /** The perfect output for the same input, so fabricated claims never restate a true finding. */
  clean?: CrawlOutput | AuditOutput;
  /** House style applied to invented findings so they blend in with real ones. */
  style?: (issue: Issue) => Issue;
}

/**
 * Turns an agent output into plausible garbage of the given kind. Every kind is catchable:
 * schema (layer 1), pages that were never crawled / empty or refusal reports / page cap (layer 2),
 * and fabricated claims that a re-fetch refutes (layer 3) or that name pages the site lacks (layer 2).
 */
export async function corruptOutput(
  kind: CorruptionKind,
  output: CrawlOutput | AuditOutput,
  ctx: CorruptionContext,
  rand: () => number,
): Promise<unknown> {
  if (isCrawlOutput(output)) return corruptCrawl(kind, output, ctx, rand);
  switch (kind) {
    case "hallucinated_pages":
      return hallucinateAudit(output, ctx, rand);
    case "empty":
      return { issues: [], pagesChecked: [], summary: "No issues found. The site looks great!" };
    case "refusal":
      return { issues: [], pagesChecked: [], summary: pick(REFUSALS, rand)(ctx.siteUrl) };
    case "schema":
      return breakAuditSchema(output, rand);
    case "fabricated":
      return fabricateAudit(output, ctx, rand);
  }
}

export function corruptionContextFor(context: TaskContext, clean: CrawlOutput | AuditOutput, voice: Voice = "plain"): CorruptionContext {
  const input = context.input as unknown as Record<string, unknown>;
  const pageUrl = typeof input.pageUrl === "string" && input.pageUrl.trim() ? normalizeUrl(input.pageUrl) : undefined;
  const siteRaw = typeof input.siteUrl === "string" && input.siteUrl.trim() ? input.siteUrl : (pageUrl ?? "");
  const siteUrl = siteRootUrl(siteRaw);
  const inputPages = Array.isArray(input.pages) ? input.pages.filter((p): p is string => typeof p === "string").map((p) => normalizeUrl(p)) : [];
  const outputPages = isCrawlOutput(clean) ? clean.pages.map((p) => normalizeUrl(p.url)) : clean.pagesChecked.map((p) => normalizeUrl(p));
  let pages: string[];
  if (context.capability === "crawl") pages = outputPages;
  else if (PAGE_SCOPE.has(context.capability) && pageUrl) pages = [pageUrl];
  else pages = inputPages.length > 0 ? inputPages : outputPages.length > 0 ? outputPages : [siteUrl];
  const knownPages = unique([...(context.knownPages ?? []).map((p) => normalizeUrl(p)), ...pages, ...outputPages, siteUrl]);
  return { capability: context.capability, siteUrl, pageUrl, pages, knownPages, clean, style: (issue) => applyVoice(issue, voice) };
}

const REFUSALS: ((siteUrl: string) => string)[] = [
  () => "I'm sorry, but I can't access external websites or run live audits. I can explain how to run this audit yourself if that helps.",
  (site) => `As an AI language model, I don't have real-time web access, so I can't check ${site} directly.`,
  () => "Sorry, I cannot complete this request: fetching third-party URLs is outside the actions I'm allowed to take.",
];

const FAKE_PAGES: { path: string; title: string }[] = [
  { path: "careers.html", title: "Careers" },
  { path: "checkout/", title: "Checkout" },
  { path: "admin/login", title: "Admin login" },
  { path: "pricing-enterprise.html", title: "Enterprise pricing" },
  { path: "legal/terms.html", title: "Terms of service" },
  { path: "partners.html", title: "Partners" },
];

const PLAUSIBLE_PAGES: { path: string; title: string }[] = [
  { path: "features.html", title: "Features" },
  { path: "faq.html", title: "FAQ" },
  { path: "changelog.html", title: "Changelog" },
];

function inventPages(ctx: CorruptionContext, rand: () => number, count: number, pool = FAKE_PAGES): { url: string; title: string }[] {
  const known = new Set(ctx.knownPages.map(pageKey));
  const free = pool.map((f) => ({ url: normalizeUrl(f.path, ctx.siteUrl), title: f.title })).filter((f) => !known.has(pageKey(f.url)));
  const picked = shuffle(free, rand).slice(0, count);
  return picked.length > 0 ? picked : [{ url: normalizeUrl(`archive/${hashString(ctx.siteUrl).toString(36)}.html`, ctx.siteUrl), title: "Archive" }];
}

function corruptCrawl(kind: CorruptionKind, output: CrawlOutput, ctx: CorruptionContext, rand: () => number): unknown {
  switch (kind) {
    case "hallucinated_pages": {
      const brand = siteBrand(output);
      const fakes = inventPages(ctx, rand, 2 + Math.floor(rand() * 2)).map((f) => ({ url: f.url, title: brand ? `${f.title} — ${brand}` : f.title, status: 200 }));
      return { pages: [...output.pages, ...fakes] };
    }
    case "empty":
      return { pages: [] };
    case "refusal":
      return { pages: [], summary: pick(REFUSALS, rand)(ctx.siteUrl) };
    case "schema":
      return breakCrawlSchema(output, rand);
    case "fabricated": {
      // Titles shifted by one page plus a page the site links nowhere: only a re-fetch shows it.
      const pages = output.pages.map((p, i, all) => ({ ...p, title: all[(i + 1) % all.length].title }));
      const brand = siteBrand(output);
      const extra = inventPages(ctx, rand, 1, PLAUSIBLE_PAGES).map((f) => ({ url: f.url, title: brand ? `${f.title} — ${brand}` : f.title, status: 200 }));
      return { pages: [...pages, ...extra] };
    }
  }
}

/** "Tidepool — notes that organize themselves" ⇒ "Tidepool". */
function siteBrand(output: CrawlOutput): string {
  const title = output.pages[0]?.title ?? "";
  const head = title.split(/\s[—–|·-]\s/)[0].trim();
  return head.length > 0 && head.length <= 40 ? head : "";
}

function breakCrawlSchema(output: CrawlOutput, rand: () => number): unknown {
  switch (pick(["url_strings", "status_text", "renamed_fields", "relative_urls"] as const, rand)) {
    case "url_strings":
      return { pages: output.pages.map((p) => p.url) };
    case "status_text":
      return { pages: output.pages.map((p) => ({ ...p, status: `${p.status} OK` })) };
    case "renamed_fields":
      return { urls: output.pages.map((p) => ({ href: p.url, title: p.title, code: p.status })), total: output.pages.length };
    case "relative_urls":
      return { pages: output.pages.map((p) => ({ ...p, url: pathOf(p.url) })) };
  }
}

const SEVERITY_LABELS: Record<Severity, string> = { critical: "blocker", high: "urgent", medium: "warning", low: "info" };

function breakAuditSchema(output: AuditOutput, rand: () => number): unknown {
  const { issues, pagesChecked } = output;
  const variants: ("issues_object" | "severity_labels" | "missing_recommendation" | "relative_urls")[] = ["issues_object"];
  if (issues.length > 0) variants.push("severity_labels", "missing_recommendation");
  if (issues.length > 0 || pagesChecked.length > 0) variants.push("relative_urls");
  switch (pick(variants, rand)) {
    case "severity_labels":
      return { ...output, issues: issues.map((i) => ({ ...i, severity: SEVERITY_LABELS[i.severity] ?? "urgent" })) };
    case "missing_recommendation":
      return { ...output, issues: issues.map(({ recommendation, ...rest }) => ({ ...rest, fix: recommendation })) };
    case "relative_urls":
      return { ...output, issues: issues.map((i) => ({ ...i, pageUrl: pathOf(i.pageUrl) })), pagesChecked: pagesChecked.map(pathOf) };
    case "issues_object": {
      const grouped: Record<string, Issue[]> = {};
      for (const issue of issues) (grouped[issue.rule] ??= []).push(issue);
      return { ...output, issues: grouped, total: issues.length };
    }
  }
}

/** Every finding moves to a page the site does not have; with no findings, two are invented there. */
function hallucinateAudit(output: AuditOutput, ctx: CorruptionContext, rand: () => number): AuditOutput {
  const fakes = inventPages(ctx, rand, 3).map((f) => f.url);
  const style = ctx.style ?? ((issue: Issue) => issue);
  const issues =
    output.issues.length > 0
      ? output.issues.map((issue, i) => repoint(issue, fakes[i % fakes.length]))
      : inventedIssues(ctx.capability as AuditCategory, fakes, ctx).map(style);
  return { ...output, issues, pagesChecked: unique([...output.pagesChecked, ...issues.map((i) => i.pageUrl)]) };
}

function repoint(issue: Issue, pageUrl: string): Issue {
  return { ...issue, pageUrl, description: issue.description.replace(/\bPage \/\S*/, `Page ${pathOf(pageUrl)}`) };
}

function inventedIssues(category: AuditCategory, fakes: string[], ctx: CorruptionContext): Issue[] {
  const [a, b] = [fakes[0], fakes[1 % fakes.length]];
  const host = hostOf(ctx.siteUrl);
  const abs = (path: string, base: string) => resolveHttpUrl(path, base) ?? path;
  switch (category) {
    case "accessibility":
      return [
        buildIssue("image-alt", { pageUrl: a, selector: "#careers-hero", description: "Image img/careers-hero.jpg has no alt attribute.", evidence: "<img id=\"careers-hero\" src=\"img/careers-hero.jpg\">" }),
        buildIssue("label", {
          pageUrl: b,
          selector: "#card-number",
          description: "Form field <input type=\"text\" name=\"card-number\"> has no associated label.",
          evidence: "<input id=\"card-number\" type=\"text\" name=\"card-number\" placeholder=\"Card number\">",
        }),
      ];
    case "performance":
      return [
        buildIssue("oversized-image", {
          pageUrl: a,
          selector: "#checkout-banner",
          description: "Image img/checkout-banner.png is 2.4 MB, above the 500 KB budget.",
          evidence: `${abs("img/checkout-banner.png", a)} is 2516582 bytes (2.4 MB); threshold 512000 bytes (500 KB).`,
        }),
        buildIssue("render-blocking-script", {
          pageUrl: b,
          selector: "script[src=\"js/checkout.js\"]",
          description: "Script js/checkout.js loads synchronously in <head> and blocks the first render.",
          evidence: "<script src=\"js/checkout.js\"></script> in <head> without async or defer",
        }),
      ];
    case "seo":
      return [
        buildIssue("document-title", { pageUrl: a, description: `Page ${pathOf(a)} has no <title> element.`, evidence: "No <title> element in the document." }),
        buildIssue("meta-description", { pageUrl: b, description: `Page ${pathOf(b)} has no meta description.`, evidence: "No <meta name=\"description\"> in <head>." }),
      ];
    case "security":
      return [
        buildIssue("insecure-form-action", {
          pageUrl: a,
          selector: "#login-form",
          description: `Form submits to http://${host}/admin/session over plain HTTP.`,
          evidence: `<form id="login-form" action="http://${host}/admin/session" method="post">`,
        }),
        buildIssue("missing-csp", { pageUrl: b, description: "The response has no Content-Security-Policy header.", evidence: `GET ${b} returned 200 with no Content-Security-Policy header.` }),
      ];
    case "links":
      return [
        buildIssue("broken-link", { pageUrl: a, severity: "medium", selector: "a[href=\"jobs/apply.html\"]", description: "Internal link to jobs/apply.html returns 404.", evidence: `${abs("jobs/apply.html", a)} returned HTTP 404` }),
        buildIssue("broken-link", { pageUrl: b, severity: "medium", selector: "a[href=\"cart/\"]", description: "Internal link to cart/ returns 404.", evidence: `${abs("cart/", b)} returned HTTP 404` }),
      ];
  }
}

/**
 * Replaces most real findings with false claims about elements that do not have the problem
 * (alt text that exists, a title that is there, a link that works), so a spot-check refutes them.
 * When no such claim can be made, the claims name pages the site does not have.
 */
async function fabricateAudit(output: AuditOutput, ctx: CorruptionContext, rand: () => number): Promise<AuditOutput> {
  const category = ctx.capability as AuditCategory;
  const keep = shuffle(output.issues, rand).slice(0, Math.floor(output.issues.length / 4));
  const wanted = Math.max(2, output.issues.length - keep.length);
  const claims = await falseClaims(category, ctx);
  const taken = new Set(keep.map(issueKey));
  const fabricated: Issue[] = [];
  for (const claim of [...shuffle(claims.likely, rand), ...claims.fallback]) {
    if (fabricated.length >= wanted) break;
    if (taken.has(issueKey(claim))) continue;
    taken.add(issueKey(claim));
    fabricated.push(ctx.style ? ctx.style(claim) : claim);
  }
  if (fabricated.length === 0) {
    // Nothing on the real pages can be misstated: claim findings on pages the site does not have.
    const style = ctx.style ?? ((issue: Issue) => issue);
    fabricated.push(...inventedIssues(category, inventPages(ctx, rand, 2).map((f) => f.url), ctx).map(style));
  }
  // False claims outnumber kept real findings 3:1 even when few could be made, so a sample finds one.
  const issues = shuffle([...keep.slice(0, Math.floor(fabricated.length / 3)), ...fabricated], rand);
  const summary = output.summary?.replace(/\b\d+(?= (?:[a-z]+ )?(?:issue|finding))/, String(issues.length));
  return { ...output, issues, ...(summary !== undefined ? { summary } : {}) };
}

function issueKey(issue: Issue): string {
  return `${issue.rule}|${normalizeUrl(issue.pageUrl)}|${issue.selector ?? ""}`;
}

interface Doc {
  url: string;
  $: CheerioAPI;
  base: string;
  headers: Record<string, string>;
}

async function loadDocs(urls: string[]): Promise<Doc[]> {
  const loaded = await Promise.all(
    unique(urls.map((u) => normalizeUrl(u))).map(async (url): Promise<Doc | null> => {
      try {
        const page = await fetchPage(url);
        if (page.status === null || page.status >= 400 || !page.html) return null;
        const $ = load(page.html);
        const baseHref = $("base[href]").attr("href");
        return { url, $, base: (baseHref && resolveHttpUrl(baseHref, page.finalUrl)) || page.finalUrl, headers: page.headers };
      } catch {
        return null;
      }
    }),
  );
  return loaded.filter((d): d is Doc => d !== null);
}

/** False claims for the node's pages: `likely` from the real markup, `fallback` about elements that are not there. */
async function falseClaims(category: AuditCategory, ctx: CorruptionContext): Promise<{ likely: Issue[]; fallback: Issue[] }> {
  const docs = await loadDocs(category === "security" ? [ctx.siteUrl, ...ctx.pages] : ctx.pages);
  const first = ctx.pageUrl ?? ctx.pages[0] ?? ctx.siteUrl;
  const firstDoc = docs.find((d) => d.url === normalizeUrl(first));
  switch (category) {
    case "accessibility":
      return {
        likely: docs.flatMap((d) => [...altClaims(d), ...langClaims(d), ...labelClaims(d), ...buttonClaims(d)]),
        fallback: ghostClaims(firstDoc, first, [
          ["image-alt", "#promo-banner", "Image img/promo-banner.jpg has no alt attribute.", "<img id=\"promo-banner\" src=\"img/promo-banner.jpg\">"],
          ["button-name", "#chat-launcher", "Button has no text, aria-label or title, so screen readers cannot announce what it does.", "<button id=\"chat-launcher\" type=\"button\">"],
        ]),
      };
    case "performance":
      return {
        likely: docs.flatMap((d) => [...unsizedClaims(d), ...blockingClaims(d)]),
        fallback: ghostClaims(firstDoc, first, [
          ["unsized-image", "#promo-banner", "Image img/promo-banner.jpg has no width or height attribute, so it shifts the layout when it loads.", "<img id=\"promo-banner\" src=\"img/promo-banner.jpg\">"],
          ["render-blocking-script", "script[src=\"js/vendor.bundle.js\"]", "Script js/vendor.bundle.js loads synchronously in <head> and blocks the first render.", "<script src=\"js/vendor.bundle.js\"></script> in <head> without async or defer"],
        ]),
      };
    case "seo":
      return { likely: docs.flatMap(seoClaims), fallback: firstDoc ? [] : unreachableSeoClaims(first) };
    case "security": {
      const root = docs.find((d) => d.url === normalizeUrl(ctx.siteUrl));
      const pages = new Set(ctx.pages.map((p) => normalizeUrl(p)));
      const pageDocs = docs.filter((d) => pages.has(d.url));
      return {
        likely: [...(root ? headerClaims(root) : []), ...pageDocs.flatMap(formClaims)],
        fallback: unique(ctx.pages.map((p) => normalizeUrl(p))).flatMap((p) => ghostFormClaims(docs.find((d) => d.url === p), p, ctx.siteUrl)),
      };
    }
    case "links": {
      const broken = brokenTargets(ctx.clean);
      return {
        likely: docs.flatMap((d) => workingLinkClaims(d, broken)),
        fallback: ghostClaims(firstDoc, first, [
          ["broken-link", "a[href=\"press/kit-2019.html\"]", "Internal link to press/kit-2019.html returns 404.", `${resolveHttpUrl("press/kit-2019.html", first) ?? first} returned HTTP 404`],
          ["broken-link", "a[href=\"support/\"]", "Internal link to support/ returns 404.", `${resolveHttpUrl("support/", first) ?? first} returned HTTP 404`],
        ]),
      };
    }
  }
}

const attr = (el: Element, name: string): string | undefined => el.attribs[name];
const filled = (value: string | undefined): boolean => (value ?? "").trim() !== "";
const SIMPLE_ID = /^[A-Za-z][\w-]*$/;
const NON_LABELABLE = ["hidden", "submit", "button", "reset", "image"];
const SKIPPED_HREF = /^(mailto:|tel:|javascript:|data:|sms:|#)/i;

/** `#id`, else `tag[attr="value"]`, as long as every element it matches passes `ok` (so the claim is false). */
function claimSelector(doc: Doc, el: Element, byAttr: string, ok: (el: Element) => boolean): string | null {
  const id = attr(el, "id") ?? "";
  const value = attr(el, byAttr);
  const selector = SIMPLE_ID.test(id) ? `#${id}` : value ? `${el.tagName.toLowerCase()}[${byAttr}="${cssString(value)}"]` : null;
  if (!selector) return null;
  try {
    const matched = doc.$(selector).toArray();
    return matched.length > 0 && matched.every((node) => isElementNode(node) && ok(node)) ? selector : null;
  } catch {
    return null;
  }
}

function altClaims(doc: Doc): Issue[] {
  const hasAlt = (el: Element) => attr(el, "alt") !== undefined;
  return doc.$("img[alt]")
    .toArray()
    .flatMap((el) => {
      const selector = claimSelector(doc, el, "src", hasAlt);
      if (!selector) return [];
      const description = `Image ${attr(el, "src") ?? "(no src)"} has no alt attribute.`;
      return [buildIssue("image-alt", { pageUrl: doc.url, selector, description, evidence: openTag(el, ["alt"]) })];
    });
}

function langClaims(doc: Doc): Issue[] {
  const html = doc.$("html").get(0);
  if (!html || !filled(attr(html, "lang"))) return [];
  return [buildIssue("html-has-lang", { pageUrl: doc.url, selector: "html", description: "The <html> element has no lang attribute.", evidence: openTag(html, ["lang"]) })];
}

function labelClaims(doc: Doc): Issue[] {
  const labelled = new Set(doc.$("label[for]").toArray().map((l) => attr(l, "for")));
  const isLabelled = (el: Element) => labelled.has(attr(el, "id"));
  return doc.$("input[id], select[id], textarea[id]")
    .toArray()
    .filter((el) => !(el.tagName.toLowerCase() === "input" && NON_LABELABLE.includes((attr(el, "type") ?? "text").toLowerCase())))
    .flatMap((el) => {
      const selector = isLabelled(el) ? claimSelector(doc, el, "name", isLabelled) : null;
      if (!selector) return [];
      const description = `Form field ${describeField(el)} has no associated label.`;
      return [buildIssue("label", { pageUrl: doc.url, selector, description, evidence: openTag(el) })];
    });
}

function buttonClaims(doc: Doc): Issue[] {
  const named = (el: Element) => doc.$(el).text().trim() !== "";
  return doc.$("button")
    .toArray()
    .flatMap((el) => {
      const selector = named(el) ? claimSelector(doc, el, "name", named) : null;
      if (!selector) return [];
      const description = "Button has no text, aria-label or title, so screen readers cannot announce what it does.";
      return [buildIssue("button-name", { pageUrl: doc.url, selector, description, evidence: openTag(el) })];
    });
}

function unsizedClaims(doc: Doc): Issue[] {
  const sized = (el: Element) => attr(el, "width") !== undefined && attr(el, "height") !== undefined;
  return doc.$("img[src]")
    .toArray()
    .flatMap((el) => {
      const selector = sized(el) ? claimSelector(doc, el, "src", sized) : null;
      if (!selector) return [];
      const description = `Image ${attr(el, "src")} has no width or height attribute, so it shifts the layout when it loads.`;
      return [buildIssue("unsized-image", { pageUrl: doc.url, selector, description, evidence: openTag(el, ["width", "height"]) })];
    });
}

function blockingClaims(doc: Doc): Issue[] {
  const nonBlocking = (el: Element) => !isBlockingScript(doc, el);
  return doc.$("script[src]")
    .toArray()
    .flatMap((el) => {
      const selector = nonBlocking(el) ? claimSelector(doc, el, "src", nonBlocking) : null;
      if (!selector) return [];
      const src = attr(el, "src");
      const description = `Script ${src} loads synchronously in <head> and blocks the first render.`;
      return [buildIssue("render-blocking-script", { pageUrl: doc.url, selector, description, evidence: `${openTag(el, ["async", "defer"])}</script> in <head> without async or defer` })];
    });
}

function isBlockingScript(doc: Doc, el: Element): boolean {
  if (doc.$(el).parents("head").length === 0) return false;
  if (attr(el, "async") !== undefined || attr(el, "defer") !== undefined) return false;
  const type = (attr(el, "type") ?? "").trim().toLowerCase();
  return ["", "text/javascript", "application/javascript"].includes(type);
}

function seoClaims(doc: Doc): Issue[] {
  const { $, url } = doc;
  const claims: Issue[] = [];
  const path = pathOf(url);
  const title = $("title")
    .toArray()
    .find((t) => $(t).parents("svg").length === 0);
  if (title && $(title).text().trim() !== "") {
    claims.push(buildIssue("document-title", { pageUrl: url, description: `Page ${path} has no <title> element.`, evidence: "No <title> element in the document." }));
  }
  const meta = $("meta")
    .toArray()
    .find((m) => (attr(m, "name") ?? "").trim().toLowerCase() === "description");
  if (meta && filled(attr(meta, "content"))) {
    claims.push(buildIssue("meta-description", { pageUrl: url, description: `Page ${path} has no meta description.`, evidence: "No <meta name=\"description\"> in <head>." }));
  }
  const h1s = $("h1").toArray();
  if (h1s.length === 1) {
    const text = $(h1s[0]).text().replace(/\s+/g, " ").trim();
    claims.push(buildIssue("multiple-h1", { pageUrl: url, selector: "h1", description: `Page ${path} has 2 <h1> elements.`, evidence: `2 <h1> elements: "${text}", "${text}"` }));
  }
  return claims;
}

function unreachableSeoClaims(pageUrl: string): Issue[] {
  const path = pathOf(pageUrl);
  return [
    buildIssue("document-title", { pageUrl, description: `Page ${path} has no <title> element.`, evidence: "No <title> element in the document." }),
    buildIssue("meta-description", { pageUrl, description: `Page ${path} has no meta description.`, evidence: "No <meta name=\"description\"> in <head>." }),
  ];
}

const HEADER_RULES: { rule: string; header: string; label: string }[] = [
  { rule: "missing-csp", header: "content-security-policy", label: "Content-Security-Policy" },
  { rule: "missing-x-frame-options", header: "x-frame-options", label: "X-Frame-Options" },
  { rule: "missing-x-content-type-options", header: "x-content-type-options", label: "X-Content-Type-Options" },
  { rule: "missing-referrer-policy", header: "referrer-policy", label: "Referrer-Policy" },
  { rule: "missing-hsts", header: "strict-transport-security", label: "Strict-Transport-Security" },
];

/** Claims a header is missing when the site root does send it (or, for X-Frame-Options, CSP frame-ancestors covers it). */
function headerClaims(root: Doc): Issue[] {
  const csp = root.headers["content-security-policy"] ?? "";
  return HEADER_RULES.filter(({ rule, header }) => filled(root.headers[header]) || (rule === "missing-x-frame-options" && /frame-ancestors/i.test(csp))).map(
    ({ rule, label }) =>
      buildIssue(rule, { pageUrl: root.url, description: `The site root response has no ${label} header.`, evidence: `GET ${root.url} returned 200 with no ${label} header.` }),
  );
}

/** Forms that post over https (or a relative URL) claimed to post over plain http. */
function formClaims(doc: Doc): Issue[] {
  const secure = (el: Element) => !/^http:\/\//i.test((attr(el, "action") ?? "").trim());
  return doc.$("form[action]")
    .toArray()
    .flatMap((el) => {
      const selector = secure(el) ? claimSelector(doc, el, "action", secure) : null;
      const target = resolveHttpUrl(attr(el, "action") ?? "", doc.base);
      if (!selector || !target) return [];
      const insecure = target.replace(/^https:/i, "http:");
      const description = `Form submits to ${insecure} over plain HTTP.`;
      return [buildIssue("insecure-form-action", { pageUrl: doc.url, selector, description, evidence: openTag(el, [], { action: insecure }) })];
    });
}

function ghostFormClaims(doc: Doc | undefined, pageUrl: string, siteUrl: string): Issue[] {
  const action = `http://${hostOf(siteUrl)}/newsletter/subscribe`;
  const selector = `form[action="${cssString(action)}"]`;
  if (doc && doc.$(selector).length > 0) return [];
  return [
    buildIssue("insecure-form-action", {
      pageUrl,
      selector,
      description: `Form submits to ${action} over plain HTTP.`,
      evidence: `<form class="newsletter" action="${action}" method="post">`,
    }),
  ];
}

/** Links that work, claimed broken. */
function workingLinkClaims(doc: Doc, broken: Set<string>): Issue[] {
  const seen = new Set<string>();
  return doc.$("a[href]")
    .toArray()
    .flatMap((el) => {
      const href = attr(el, "href") ?? "";
      if (href.trim() === "" || SKIPPED_HREF.test(href.trim())) return [];
      const url = resolveHttpUrl(href, doc.base);
      if (!url || seen.has(url) || broken.has(normalizeUrl(url))) return [];
      seen.add(url);
      const internal = sameOrigin(url, doc.url);
      return [
        buildIssue("broken-link", {
          pageUrl: doc.url,
          severity: internal ? "medium" : "low",
          selector: `a[href="${cssString(href)}"]`,
          description: internal ? `Internal link to ${href} returns 404.` : `External link to ${url} does not resolve.`,
          evidence: internal ? `${url} returned HTTP 404` : `${url} failed: getaddrinfo ENOTFOUND ${hostOf(url)}`,
        }),
      ];
    });
}

/** Normalized targets of the broken links in the perfect output. */
function brokenTargets(clean: CrawlOutput | AuditOutput | undefined): Set<string> {
  const targets = new Set<string>();
  if (!clean || isCrawlOutput(clean)) return targets;
  for (const issue of clean.issues.filter((i) => i.rule === "broken-link")) {
    const href = hrefFromLinkSelector(issue.selector);
    const resolved = href !== null ? resolveHttpUrl(href, issue.pageUrl) : null;
    if (resolved) targets.add(normalizeUrl(resolved));
    for (const url of urlsInText(issue.evidence)) targets.add(normalizeUrl(url));
  }
  return targets;
}

type GhostSpec = [rule: string, selector: string, description: string, evidence: string];

/** Claims about elements that are not on the page at all (the selector matches nothing). */
function ghostClaims(doc: Doc | undefined, pageUrl: string, specs: GhostSpec[]): Issue[] {
  return specs
    .filter(([, selector]) => !doc || doc.$(selector).length === 0)
    .map(([rule, selector, description, evidence]) => buildIssue(rule, { pageUrl, selector, description, evidence }));
}

function isElementNode(node: AnyNode): node is Element {
  return node.type === "tag" || node.type === "script" || node.type === "style";
}

function describeField(el: Element): string {
  const type = attr(el, "type") ? ` type="${attr(el, "type")}"` : "";
  const name = attr(el, "name") ? ` name="${attr(el, "name")}"` : "";
  return `<${el.tagName.toLowerCase()}${type}${name}>`;
}

/** The element's opening tag as written, minus `omit` attributes (what the false claim says is missing). */
function openTag(el: Element, omit: string[] = [], override: Record<string, string> = {}): string {
  const attrs = Object.entries({ ...el.attribs, ...override })
    .filter(([name]) => !omit.includes(name))
    .map(([name, value]) => (value === "" ? ` ${name}` : ` ${name}="${value.replace(/"/g, "&quot;")}"`))
    .join("");
  const tag = `<${el.tagName.toLowerCase()}${attrs}>`;
  return tag.length > 300 ? `${tag.slice(0, 297)}…>` : tag;
}

function cssString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\n/g, "\\a ");
}

// ---------- small helpers ----------

function isCrawlOutput(output: CrawlOutput | AuditOutput): output is CrawlOutput {
  return Array.isArray((output as Partial<CrawlOutput>).pages) && !Array.isArray((output as Partial<AuditOutput>).issues);
}

/** The page (page-scope), page count (site-scope) or site an attempt works on, for progress and error text. */
function describeTarget(input: AgentNodeInput): string {
  const r = input as unknown as Record<string, unknown>;
  if (typeof r.pageUrl === "string" && r.pageUrl) return clip(normalizeUrl(r.pageUrl), 200);
  if (Array.isArray(r.pages) && r.pages.length > 0) return `${r.pages.length} page${r.pages.length === 1 ? "" : "s"}`;
  if (typeof r.siteUrl === "string" && r.siteUrl) return clip(normalizeUrl(r.siteUrl), 200);
  return "the site";
}

/** Page identity as verification compares it: ".../checkout" and ".../checkout/" are the same page. */
function pageKey(url: string): string {
  return siteRootUrl(url);
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "localhost";
  }
}

function shuffle<T>(items: readonly T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function pick<T>(items: readonly T[], rand: () => number): T {
  return items[Math.min(items.length - 1, Math.floor(rand() * items.length))];
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

/** JSON with sorted keys, so equal inputs share one cache entry. */
function stableKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableKey).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableKey(record[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message || err.name : String(err);
}

/** Strips anything key- or token-shaped before a message leaves the mock. */
function redact(text: string): string {
  return clip(
    text
      .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, "[redacted]")
      .replace(/\bbearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
      .replace(/([?&](?:key|token|secret|api_key|apikey|access_token|auth)=)[^&\s"']+/gi, "$1[redacted]")
      .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[redacted]"),
    300,
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
