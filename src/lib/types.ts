// Shared domain types. Every module codes against these; change with care.

export type Severity = "critical" | "high" | "medium" | "low";
export const SEVERITIES: Severity[] = ["critical", "high", "medium", "low"];

export type AuditCategory = "accessibility" | "performance" | "seo" | "security" | "links";
export const AUDIT_CATEGORIES: AuditCategory[] = ["accessibility", "performance", "seo", "security", "links"];

/** Capabilities that are delegated to (Darwin or mock) agents. */
export type Capability = "crawl" | AuditCategory;
export const CAPABILITIES: Capability[] = ["crawl", ...AUDIT_CATEGORIES];

/** Steps Axolotl runs itself (no external agent). */
export type BuiltinStep = "merge" | "prioritize" | "fixplan";

/** One finding in the shared audit format (spec section 5). `rule` is a stable code from src/lib/audit/rules.ts. */
export interface Issue {
  category: AuditCategory;
  severity: Severity;
  rule: string;
  /** Absolute URL of the page the issue is on. Site-wide issues use the site root URL. */
  pageUrl: string;
  selector?: string;
  description: string;
  recommendation: string;
  evidence: string;
}

export interface CrawlPage {
  url: string;
  title: string;
  status: number;
}

export interface CrawlOutput {
  pages: CrawlPage[];
}

export interface AuditOutput {
  issues: Issue[];
  /** Pages the agent says it checked (absolute URLs). */
  pagesChecked: string[];
  summary?: string;
}

// ---------- node inputs ----------

export interface CrawlInput {
  siteUrl: string;
  maxPages: number;
}
export interface PageAuditInput {
  siteUrl: string;
  pageUrl: string;
}
export interface SiteAuditInput {
  siteUrl: string;
  pages: string[];
}
export type AgentNodeInput = CrawlInput | PageAuditInput | SiteAuditInput;

// ---------- built-in outputs ----------

export interface MergeOutput {
  issues: Issue[];
  /** Node instance ids whose branch exhausted every backup. */
  partialBranches: { nodeId: string; label: string }[];
  coverage: { nodeId: string; label: string; passed: boolean; issueCount: number }[];
}

export interface PrioritizedIssue extends Issue {
  id: string;
  /** Lower = fix first. */
  priority: number;
  effort: "small" | "medium" | "large";
  /** How many raw findings were merged into this one. */
  duplicates: number;
  /** Agents that reported it. */
  reportedBy: string[];
}

export interface PrioritizedOutput {
  issues: PrioritizedIssue[];
  dedupedFrom: number;
}

export interface FixDraft {
  issueId: string;
  title: string;
  /** Short code or config snippet. */
  patch: string;
  language: string;
}

export interface FixPlanOutput {
  headline: string;
  summary: string;
  topFixes: FixDraft[];
  source: "llm" | "template";
}

// ---------- agents ----------

/** Where a run's agents are looked up: the simulated catalog or Darwin Search. */
export type AgentSource = "mock" | "darwin";

/**
 * How one agent runs. "mock": simulated; "darwin": through Darwin Act; "direct": called straight
 * at its own MCP endpoint (found through Darwin Search, or a local test agent), no Act needed.
 */
export type AgentKind = AgentSource | "direct";

/** An agent's own MCP endpoint, for direct calls without Darwin Act. */
export interface AgentEndpoint {
  protocol: "MCP";
  url: string;
  /** Tool to call; picked by capability from tools/list when absent. */
  toolName?: string;
  /**
   * darwin: published and verified by Darwin Search; provider: listed on Darwin, address from the provider's
   * record because Darwin doesn't publish it (src/lib/darwin/providerEndpoints.ts); manual: given by address
   * (YOUR_AGENT_MCP_URL); local-test: Axolotl's own test agents.
   */
  origin: "darwin" | "provider" | "manual" | "local-test";
}

export interface AgentRef {
  agentId: string;
  capabilityId: string;
  name: string;
  source: AgentKind;
  /** Provider / publisher label, display only. */
  provider?: string;
}

export type Readiness = "ready" | "not_ready" | "unverified" | "unavailable";

export interface AgentCandidate extends AgentRef {
  capability: Capability;
  description: string;
  readiness: Readiness | string;
  canStartThread: boolean;
  reasons: string[];
  uncertainties: string[];
  requiredSetup: unknown;
  connectionPrompt?: string;
  providerCheck?: string;
  rank: number;
  searchId?: string;
  /** JSON schema of the capability's arguments when Darwin exposes one. */
  argumentSchema?: Record<string, unknown> | null;
  /** Verified MCP endpoint, when Darwin publishes one: the agent can then run directly, without Act. */
  endpoint?: AgentEndpoint;
  /** What the listing declares about sign-in, payment and runtime (Darwin's executionRequirements). */
  terms?: ListingTerms;
  /** First-sight trust check, attached by the search and direct-connect routes. */
  trust?: TrustReport;
}

// ---------- trust (first-sight reliability) ----------

export type DeclaredState = "required" | "not_required" | "unknown";

/** What an agent's listing says it needs, read from Darwin's executionRequirements (or the mock catalog). */
export interface ListingTerms {
  auth?: DeclaredState;
  /** Credential kinds the provider asks for (API_KEY, OAUTH2, SESSION_COOKIE, ...). */
  authMechanisms?: string[];
  payment?: DeclaredState;
  /** Price or terms text when the listing gives one ("$0.02 per page"). */
  paymentTerms?: string;
  /** REMOTE_MCP, LOCAL_STDIO, X402_PAYMENT, COMMERCE, ... */
  runtime?: string;
  /** Inputs the tool marks as secrets (passwords, keys) it wants passed in the call. */
  secretInputs?: string[];
  /** PROVIDER_DECLARED, PROVIDER_OBSERVED, DERIVED_FROM_VERIFIED_RECEIPT, UNKNOWN. */
  evidence?: string;
}

/** The three questions a trust check answers. */
export type TrustDimension = "safety" | "cost" | "quality";

/** good: evidence it's fine; unknown: not enough to say; warn: a real concern; bad: don't run it unattended. */
export type TrustLevel = "good" | "unknown" | "warn" | "bad";

export interface TrustSignal {
  dimension: TrustDimension;
  level: TrustLevel;
  /** Plain-language finding ("Asks to be paid per call"). */
  text: string;
  /** listing: what the agent or Darwin says; probe: a trial run; history: past runs through Axolotl. */
  source: "listing" | "probe" | "history";
}

export interface TrustDimensionView {
  level: TrustLevel;
  /** 0..1, higher is safer / cheaper / more accurate. */
  score: number;
  summary: string;
}

export interface TrialResult {
  passed: boolean;
  /** Share of the demo site's planted issues (or pages) the agent found. */
  recall?: number;
  /** Findings that matched nothing planted (audits on the demo site only). */
  falseFindings?: number;
  failureType?: FailureType;
  detail: string;
  latencyMs: number;
  at: number;
}

export type TrustVerdict = "trusted" | "untested" | "caution" | "avoid";

export interface TrustReport {
  agentId: string;
  capability: Capability;
  name: string;
  source: AgentKind;
  /** 0..100: safety and cost gate it, quality sets it. */
  score: number;
  /**
   * trusted: safe, free and proven accurate; untested: nothing wrong found, accuracy not measured yet;
   * caution: usable, but read the signals; avoid: looks unsafe, so runs never use it.
   */
  verdict: TrustVerdict;
  safety: TrustDimensionView;
  cost: TrustDimensionView;
  quality: TrustDimensionView;
  signals: TrustSignal[];
  trial?: TrialResult;
  checkedAt: number;
}

/** An agent the router found for a step at run time, with what it needs to be called. */
export interface RoutedAgent extends AgentRef {
  capability?: Capability;
  searchId?: string;
  argumentSchema?: Record<string, unknown> | null;
  /** Set for direct agents. */
  endpoint?: AgentEndpoint;
  /** The provider charges for each call. */
  paid?: boolean;
  /** Price per call in cents, when the listing states one. */
  priceCents?: number;
}

/** Where an agent sits in a step's route: free agents first, then paid (within the run's budget), then simulated. */
export type RouteTier = "yours" | "free" | "paid" | "simulated";

export interface RouteCandidate {
  agent: AgentRef;
  tier: RouteTier;
  /** Why it is at this point in the order ("Most reliable free agent (94% verified over 31 runs)"). */
  reason: string;
  priceCents?: number;
  trustScore?: number;
  verdict?: TrustVerdict;
}

/** What the router did for a step: where it searched, what it will try in order, and what it left out. */
export interface RoutePlan {
  searched: string[];
  agents: RouteCandidate[];
  skipped: { agent: AgentRef; reason: string }[];
  /** Search notes or errors worth showing ("Darwin Search failed: ..."). */
  notes: string[];
}

export interface AgentStats {
  agentId: string;
  capability: Capability;
  name: string;
  source: AgentSource;
  attempts: number;
  successes: number;
  failures: Partial<Record<FailureType, number>>;
  totalLatencyMs: number;
  /** Beta-Bernoulli (successes + 1) / (attempts + 2). */
  score: number;
  avgLatencyMs: number;
  updatedAt: number;
}

// ---------- faults & failures ----------

/** Corruptions a mock agent (or chaos) can apply to an otherwise good output. */
export type CorruptionKind = "hallucinated_pages" | "empty" | "refusal" | "schema" | "fabricated";

/** A fault that chaos mode or a manual button can inject into an attempt. */
export type FaultMode = "error" | "timeout" | "stall" | "auth_block" | "corrupt";

export type FailureType =
  | "error"
  | "timeout"
  | "stall"
  | "auth_block"
  | "payment_block"
  | "transport"
  | "killed"
  | "verification";

// ---------- verification ----------

export interface LayerResult {
  layer: 1 | 2 | 3 | 4;
  name: string;
  pass: boolean;
  /** Layer did not apply (e.g. nothing verifiable to spot-check). Skipped layers count as pass. */
  skipped?: boolean;
  reason: string;
  confidence?: number;
  /** For layer 4: which judge produced the verdict. */
  source?: "mock" | "llm" | "cache" | "budget_fallback";
  details?: unknown;
}

export interface VerificationResult {
  pass: boolean;
  layers: LayerResult[];
  /** Recall against ground-truth.json when auditing the demo site. */
  recall?: { found: number; expected: number; ratio: number };
}

// ---------- engine state ----------

export type NodeState =
  | "idle"
  | "queued"
  | "running"
  | "verifying"
  | "swapping"
  | "passed"
  | "failed" // every agent found for the step failed: branch stops
  | "partial" // merge/downstream finished with some branches missing
  | "cancelled";

export type AttemptOutcome = "running" | "verifying" | "passed" | "hard_failure" | "silent_failure";

export interface AttemptView {
  id: string;
  runId: string;
  nodeId: string;
  attemptNo: number;
  agent: AgentRef;
  idempotencyKey: string;
  /** Transport retries that reused the same idempotency key. */
  transportRetries: number;
  instruction: string;
  input: unknown;
  rawOutput: unknown;
  outcome: AttemptOutcome;
  failureType?: FailureType;
  failureDetail?: string;
  injectedFault?: FaultMode;
  /** Who injected the fault: a button press, or chaos mode. */
  faultSource?: "manual" | "chaos";
  verification?: VerificationResult;
  /** How a real agent's answer was read into the step's format (real and direct agents only). */
  translation?: TranslationNote;
  /** Why the router picked this agent at this point ("Next most reliable backup (94% verified over 31 runs)"). */
  routeReason?: string;
  /** Charged for this attempt (paid agents only), in cents. */
  costCents?: number;
  latencyMs?: number;
  startedAt: number;
  finishedAt?: number;
}

export interface TranslationNote {
  /** native: already in Axolotl's format; rules: read by pattern; llm: read by GPT; none: not translated. */
  method: "native" | "rules" | "llm" | "none";
  /** Candidate findings (or pages) seen in the answer. */
  found: number;
  /** Findings (or pages) that made it into the output. */
  kept: number;
  /** Candidates that matched none of the step's checks, or were off-site. */
  dropped: number;
  /** Plain-language summary for the UI. */
  text: string;
}

export interface NodeView {
  id: string;
  runId: string;
  templateId: string;
  label: string;
  kind: "agent" | "builtin";
  capability?: Capability;
  builtin?: BuiltinStep;
  /** For fan-out nodes: the page this instance covers. */
  itemKey?: string;
  dependsOn: string[];
  state: NodeState;
  currentAgent?: AgentRef;
  attemptCount: number;
  swaps: number;
  startedAt?: number;
  finishedAt?: number;
  /** True when restored from a checkpoint on resume. */
  restored?: boolean;
  /** Stand-in for a fan-out template before the crawl tells us which pages exist. */
  placeholder?: boolean;
  output?: unknown;
  error?: string;
  /** Agents found for this step at run time, in the order they are tried, and the ones left out. */
  route?: RoutePlan;
}

export interface ChaosConfig {
  enabled: boolean;
  /** Probability (0..1) that any given attempt gets a random fault. */
  rate: number;
  /** Relative weights of fault kinds chosen when chaos fires. */
  weights: Record<FaultMode, number>;
}

export interface RunConfig {
  siteUrl: string;
  /** What the person typed to start the run ("Do a full accessibility audit of Tidepool Labs"), when they typed one. */
  request?: string;
  maxPages: number;
  client: AgentSource;
  /**
   * Darwin runs only: after the real agents Darwin finds for a step, fall back to simulated agents, so a
   * step still finishes when every real agent fails or none is reachable. Shown as "Simulated" in the UI.
   */
  simulatedBackups: boolean;
  /**
   * Most the run may spend on paid agents, in cents. 0 means paid agents are never used. With a
   * budget, every free agent for a step is tried before any paid one.
   */
  budgetCents: number;
  chaos: ChaosConfig;
  /** "live" allows real OpenAI calls (budget-guarded); "mock" never calls the network. */
  llmMode: "mock" | "live";
  seed: number;
  /** Multiplies every mock latency, timeout and poll interval. 1 = live demo pace. */
  timeScale: number;
  concurrency: number;
  /** "Without Axolotl" baseline: primary agent only, no verification, no failover. */
  baseline: boolean;
  /** Write to SQLite. The time-lapse runs in memory. */
  persist: boolean;
  /** Update agent reliability stats from this run. */
  recordStats: boolean;
}

export type RunStatus = "running" | "completed" | "partial" | "failed" | "crashed" | "cancelled";

export interface RunSummary {
  id: string;
  status: RunStatus;
  config: RunConfig;
  createdAt: number;
  finishedAt?: number;
  stats?: RunStats;
}

export interface RunStats {
  nodes: number;
  passed: number;
  failedBranches: number;
  attempts: number;
  recoveries: number;
  hardFailures: number;
  silentFailures: number;
  humanInterventions: number;
  issuesFound: number;
  durationMs: number;
  /** Ground-truth recall for the final report when auditing the demo site. */
  recall?: number;
  /** Oracle (hidden from verification): did any accepted output contain injected corruption? */
  acceptedCorruptOutput?: boolean;
  /** Spent on paid agents, in cents. */
  spentCents?: number;
}

// ---------- live events (SSE) ----------

export type EngineEvent =
  | { type: "run_started"; run: RunSummary }
  | { type: "node_added"; runId: string; node: NodeView }
  | { type: "node_updated"; runId: string; node: NodeView }
  | { type: "node_removed"; runId: string; nodeId: string }
  | { type: "attempt"; runId: string; attempt: AttemptView }
  | { type: "swap"; runId: string; nodeId: string; from: AgentRef; to: AgentRef; reason: string }
  | { type: "alert"; runId: string; nodeId?: string; level: "info" | "warn" | "error"; message: string; at: number }
  | { type: "run_finished"; run: RunSummary }
  | { type: "stats_updated"; at: number }
  | { type: "timelapse"; data: TimelapseTick };

export interface TimelapseSide {
  runs: number;
  completed: number;
  /** Runs that "completed" but delivered a corrupted report (counted as failures). */
  silentlyCorrupt: number;
  recoveries: number;
  humanInterventions: number;
  wastedHours: number;
}

export interface TimelapseTick {
  id: string;
  index: number;
  total: number;
  /** Simulated wall clock, e.g. "02:40". */
  clock: string;
  without: TimelapseSide;
  with: TimelapseSide;
  done: boolean;
  /** Per-run points for the split-screen chart. */
  point?: { index: number; clock: string; withRate: number; withoutRate: number };
}
