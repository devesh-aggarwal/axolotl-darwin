// First-sight trust check: when setup finds an agent, answer three questions before anyone relies on it.
//   Safety:  does it look malicious (steers the caller, asks for secrets, ships data elsewhere)?
//   Cost:    will it charge, or stop an unattended run to ask for payment or a sign-in?
//   Quality: does it get the answer right? A trial on the demo site, then every real run, tell us.
// Pure: the caller passes in the listing, past runs, incidents and the latest trial.
import { betaScore } from "@/lib/engine/stats";
import { mergeScans, scanText, type TextScan } from "@/lib/trust/signals";
import type {
  AgentCandidate,
  AgentStats,
  TrialResult,
  TrustDimension,
  TrustDimensionView,
  TrustLevel,
  TrustReport,
  TrustSignal,
  TrustVerdict,
} from "@/lib/types";

/** What Axolotl saw an agent do in past runs, beyond pass/fail. */
export interface IncidentCounts {
  /** Its answer tried to override the caller's instructions. */
  hijack: number;
  /** Stopped a run to ask for payment. */
  payment: number;
  /** Stopped a run to ask for a sign-in. */
  signIn: number;
}

export const NO_INCIDENTS: IncidentCounts = { hijack: 0, payment: 0, signIn: 0 };

/** The listing fields the check reads. A search result has them all; a stored listing keeps just these. */
export type Listing = Pick<
  AgentCandidate,
  | "agentId"
  | "capabilityId"
  | "capability"
  | "name"
  | "provider"
  | "source"
  | "description"
  | "uncertainties"
  | "connectionPrompt"
  | "providerCheck"
  | "terms"
  | "endpoint"
  | "searchId"
  | "argumentSchema"
> & {
  /** Tool descriptions from an MCP server's tools/list (direct agents). */
  toolText?: string[];
};

export interface AssessInput {
  listing: Listing;
  stats?: AgentStats;
  incidents?: IncidentCounts;
  trial?: TrialResult;
  now?: number;
}

/** A trial counts as this many runs when blended with real history. */
export const TRIAL_WEIGHT = 3;
/** Quality at or above this is "good"; below QUALITY_WARN is "bad". */
export const QUALITY_GOOD = 0.8;
export const QUALITY_WARN = 0.6;

const LEVEL_RANK: Record<TrustLevel, number> = { good: 0, unknown: 1, warn: 2, bad: 3 };
const SAFETY_FACTOR: Record<TrustLevel, number> = { good: 1, unknown: 0.85, warn: 0.7, bad: 0 };
const COST_FACTOR: Record<TrustLevel, number> = { good: 1, unknown: 0.9, warn: 0.8, bad: 0.5 };

const PAID_RUNTIMES = new Set(["X402_PAYMENT", "COMMERCE"]);
const MECHANISM_LABEL: Record<string, string> = {
  API_KEY: "an API key",
  OAUTH2: "an OAuth sign-in",
  BEARER: "a bearer token",
  HTTP_BASIC: "a username and password",
  SESSION_COOKIE: "a browser session",
  MUTUAL_TLS: "a client certificate",
  SIGNED_REQUEST: "signed requests",
  OPERATION_SECRET_INPUT: "a secret in each call",
};

export function assessTrust({ listing, stats, incidents = NO_INCIDENTS, trial, now = Date.now() }: AssessInput): TrustReport {
  const signals: TrustSignal[] = [];
  const add = (dimension: TrustDimension, level: TrustLevel, text: string, source: TrustSignal["source"] = "listing") =>
    signals.push({ dimension, level, text, source });

  const scan = listingScan(listing);
  safetySignals(listing, scan, incidents, add);
  costSignals(listing, scan, incidents, add);
  const qualityScore = qualitySignals(listing, stats, trial, add);

  const safety = dimension("safety", signals);
  const cost = dimension("cost", signals);
  const quality = dimension("quality", signals, qualityScore);
  const score = Math.round(100 * quality.score * SAFETY_FACTOR[safety.level] * COST_FACTOR[cost.level]);
  return {
    agentId: listing.agentId,
    capability: listing.capability,
    name: listing.name,
    source: listing.source,
    score,
    verdict: verdictOf(safety.level, cost.level, quality.level),
    safety,
    cost,
    quality,
    signals: signals.sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level]),
    ...(trial ? { trial } : {}),
    checkedAt: now,
  };
}

/** The agent's own words: description, connection text, caveats, tool descriptions. */
function listingScan(l: Listing): TextScan {
  return mergeScans([l.description, l.connectionPrompt, ...l.uncertainties, ...(l.toolText ?? [])].map(scanText));
}

type Add = (dimension: TrustDimension, level: TrustLevel, text: string, source?: TrustSignal["source"]) => void;

function safetySignals(l: Listing, scan: TextScan, inc: IncidentCounts, add: Add): void {
  if (scan.override) add("safety", "bad", "Its listing tells the calling agent to ignore its instructions");
  if (scan.secretAsk) add("safety", "bad", "Its listing asks for your keys, tokens or passwords");
  if (scan.exfil) add("safety", "bad", "Its listing asks for results to be sent to an outside address");
  if (scan.shell) add("safety", "bad", "Its listing asks to run shell commands");
  if (inc.hijack) add("safety", "bad", `Its answer tried to override Axolotl's instructions in ${times(inc.hijack)}`, "history");

  const t = l.terms;
  if (t?.secretInputs?.length) add("safety", "warn", `Wants secrets passed in every call (${t.secretInputs.slice(0, 3).join(", ")})`);
  if (t?.runtime === "LOCAL_STDIO") add("safety", "warn", "Runs as a program on your machine, not as a hosted service");

  if (l.endpoint?.origin === "darwin") add("safety", "good", "Darwin verified its address");
  else if (l.endpoint?.origin === "provider") add("safety", "unknown", "Listed on Darwin, but Darwin's address check has lapsed; Axolotl connects and checks it itself");
  else if (l.endpoint?.origin === "manual") add("safety", "unknown", "Address added by hand; nobody has verified it");
  else if (l.endpoint?.origin === "local-test") add("safety", "good", "Axolotl's own local test agent");
  if (t?.evidence === "DERIVED_FROM_VERIFIED_RECEIPT") add("safety", "good", "Darwin confirmed what it needs from a real call");
  else if (l.source === "darwin" && !t) add("safety", "unknown", "Listing doesn't say what it needs to run");
  if (l.source === "mock" && !scan.override && !scan.secretAsk && !scan.exfil && !scan.shell) add("safety", "good", "Simulated agent: runs inside Axolotl");
}

function costSignals(l: Listing, scan: TextScan, inc: IncidentCounts, add: Add): void {
  const t = l.terms;
  const paid = t?.payment === "required" || (t?.runtime !== undefined && PAID_RUNTIMES.has(t.runtime));
  if (paid) {
    const terms = t?.paymentTerms ? `: ${t.paymentTerms}` : "";
    add("cost", "bad", `Charges for each call${terms}. Axolotl never pays, so a run stops when it asks`);
  } else if (scan.pricing) add("cost", "warn", `Its listing mentions pricing ("${scan.pricing}")`);
  if (inc.payment) add("cost", "bad", `Asked for payment in ${times(inc.payment)}`, "history");

  if (t?.auth === "required") {
    const how = (t.authMechanisms ?? []).map((m) => MECHANISM_LABEL[m]).filter(Boolean)[0];
    add("cost", "warn", `Needs an account with the provider${how ? ` (${how})` : ""} before it can run`);
  }
  if (inc.signIn) add("cost", "warn", `Stopped to ask for a sign-in in ${times(inc.signIn)}`, "history");

  if (!paid && !scan.pricing && !inc.payment) {
    if (t?.payment === "not_required") add("cost", "good", t.evidence === "DERIVED_FROM_VERIFIED_RECEIPT" ? "Free to call, confirmed by Darwin" : "Says it's free to call");
    else if (l.source === "mock") add("cost", "good", "Simulated agent: free");
    else if (l.endpoint?.origin === "local-test") add("cost", "good", "Local test agent: free");
    else add("cost", "unknown", "Doesn't say whether it charges");
  }
}

/** Returns the quality score (0..1): past runs and the trial blended, or 0.5 with nothing to go on. */
function qualitySignals(l: Listing, stats: AgentStats | undefined, trial: TrialResult | undefined, add: Add): number {
  let successes = 0;
  let attempts = 0;
  if (trial) {
    const recall = trial.recall ?? (trial.passed ? 1 : 0);
    const found = trial.recall !== undefined ? `, found ${Math.round(recall * 100)}% of the planted issues` : "";
    const wrong = trial.falseFindings ? `, ${trial.falseFindings} false finding${trial.falseFindings === 1 ? "" : "s"}` : "";
    if (trial.passed) add("quality", recall >= QUALITY_GOOD ? "good" : "warn", `Passed a trial on the demo site${found}${wrong}`, "probe");
    else add("quality", "bad", `Failed a trial on the demo site: ${trial.detail}`, "probe");
    successes += trial.passed ? TRIAL_WEIGHT * recall : 0;
    attempts += TRIAL_WEIGHT;
  }
  if (stats && stats.attempts > 0) {
    const rate = stats.successes / stats.attempts;
    const level: TrustLevel = rate >= QUALITY_GOOD ? "good" : rate >= QUALITY_WARN ? "warn" : "bad";
    add("quality", level, `Verified in ${stats.successes} of ${stats.attempts} past run${stats.attempts === 1 ? "" : "s"}`, "history");
    successes += stats.successes;
    attempts += stats.attempts;
  }
  if (!attempts) {
    add("quality", "unknown", "Not tried yet. Run a trial to measure it");
    if (l.uncertainties.some((u) => /not schema-validated|verify findings/i.test(u))) add("quality", "warn", "Provider says its output isn't validated");
    return 0.5;
  }
  return betaScore(successes, attempts);
}

function dimension(d: TrustDimension, signals: TrustSignal[], qualityScore?: number): TrustDimensionView {
  const mine = signals.filter((s) => s.dimension === d);
  let level: TrustLevel;
  if (d === "quality") {
    const measured = mine.some((s) => s.source !== "listing");
    const q = qualityScore ?? 0.5;
    level = !measured ? (mine.some((s) => s.level === "warn") ? "warn" : "unknown") : q >= QUALITY_GOOD ? "good" : q >= QUALITY_WARN ? "warn" : "bad";
  } else {
    // The worst concern decides; "good" needs at least one piece of good evidence.
    const worst = mine.reduce<TrustLevel | null>((w, s) => (w === null || LEVEL_RANK[s.level] > LEVEL_RANK[w] ? s.level : w), null);
    level = worst ?? "unknown";
  }
  const score = d === "quality" ? (qualityScore ?? 0.5) : { good: 1, unknown: 0.6, warn: 0.4, bad: 0 }[level];
  const lead = mine.find((s) => s.level === level) ?? mine[0];
  return { level, score: round2(score), summary: lead?.text ?? SUMMARY_FALLBACK[d] };
}

const SUMMARY_FALLBACK: Record<TrustDimension, string> = {
  safety: "Nothing known either way",
  cost: "Doesn't say whether it charges",
  quality: "Not tried yet",
};

function verdictOf(safety: TrustLevel, cost: TrustLevel, quality: TrustLevel): TrustVerdict {
  if (safety === "bad") return "avoid";
  if (safety === "warn" || cost === "warn" || cost === "bad" || quality === "warn" || quality === "bad") return "caution";
  if (quality === "unknown") return "untested";
  return safety === "good" && cost === "good" ? "trusted" : "caution";
}

function times(n: number): string {
  return n === 1 ? "1 past run" : `${n} past runs`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
