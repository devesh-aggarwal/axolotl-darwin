// Runtime discovery: when a step needs an agent, search Darwin (or the simulated catalog) for it,
// vet every result automatically, and order what's left. Nobody approves agents ahead of time:
// the trust check, the run's spending limit and whether an agent can run unattended decide.
//   - Unsafe listings (trust verdict "avoid") are never used.
//   - Agents that need a sign-in or setup are skipped: nobody is around to sign in.
//   - Paid agents are skipped unless the run has a spending limit; then they go after every free one.
//   - Order within a tier: proven reliability first, then the trust check, then Darwin's rank.
import { productMode } from "@/config/mode";
import type { NodeTemplate } from "@/config/workflow";
import { YOUR_AGENTS } from "@/lib/darwin/mockCatalog";
import { pinnedAgents } from "@/lib/darwin/providerEndpoints";
import type { SearchResult } from "@/lib/darwin/types";
import { actConfigured, getDarwinClient } from "@/lib/engine/clients";
import { env } from "@/lib/env";
import { NO_INCIDENTS, assessTrust } from "@/lib/trust/assess";
import { incidentCounts, latestTrial, rememberListing, toListing } from "@/lib/trust/store";
import type {
  AgentCandidate,
  AgentRef,
  AgentSource,
  AgentStats,
  Capability,
  RouteCandidate,
  RoutePlan,
  RouteTier,
  RoutedAgent,
  TrustVerdict,
} from "@/lib/types";

/** Results asked of each search. */
export const MAX_RESULTS = 8;
/** Chance per step that a less-tested free agent is tried second, so an early lucky streak doesn't fix the order forever. */
export const EXPLORE_RATE = 0.1;
/** Agents with fewer attempts than this still count as less tested. */
const EXPLORE_MAX_ATTEMPTS = 5;

const PAID_RUNTIMES = new Set(["X402_PAYMENT", "COMMERCE"]);
const TIER_ORDER: RouteTier[] = ["yours", "free", "paid", "simulated"];

export type SearchFn = (source: AgentSource, query: string, capability: Capability) => Promise<SearchResult>;

export interface VettedAgent {
  agent: RoutedAgent;
  tier: RouteTier;
  /** Darwin's search rank (1 = first). */
  rank: number;
  trustScore: number;
  verdict?: TrustVerdict;
}

/** Everything found for one step, vetted. Shared by every page instance of the step in a run. */
export interface Discovery {
  vetted: VettedAgent[];
  skipped: RoutePlan["skipped"];
  searched: string[];
  notes: string[];
}

export interface DiscoverOptions {
  template: NodeTemplate;
  client: AgentSource;
  simulatedBackups: boolean;
  budgetCents: number;
  stats: Map<string, AgentStats>;
  /** Read and write trust history (listings, incidents, trials). Off for the time-lapse and baseline. */
  useHistory: boolean;
  /** Offer the known real agents for this step first (pinnedAgents), even when Darwin's search misses them. */
  pinReal?: boolean;
  /** Tests inject a search; defaults to the Darwin client for each source. */
  search?: SearchFn;
}

/** The simulated catalog never changes, so its search results are shared across runs. */
const mockSearches = new Map<Capability, Promise<SearchResult>>();

function defaultSearch(source: AgentSource, query: string, capability: Capability): Promise<SearchResult> {
  const run = () => getDarwinClient(source).search(query, { capability, maxResults: MAX_RESULTS });
  if (source !== "mock") return run();
  let hit = mockSearches.get(capability);
  if (!hit) {
    hit = run();
    hit.catch(() => mockSearches.delete(capability));
    mockSearches.set(capability, hit);
  }
  return hit;
}

export async function discover(o: DiscoverOptions): Promise<Discovery> {
  const capability = o.template.capability as Capability;
  const query = o.template.query ?? capability;
  const search = o.search ?? defaultSearch;
  const out: Discovery = { vetted: [], skipped: [], searched: [], notes: [] };

  const yours = yourAgent(capability);
  if (yours) out.vetted.push({ agent: yours, tier: "yours", rank: 0, trustScore: 100 });

  // A Darwin run searches Darwin; simulated agents are a last resort when allowed.
  const sources: AgentSource[] = o.client === "darwin" ? ["darwin", ...(o.simulatedBackups ? (["mock"] as const) : [])] : ["mock"];
  const seen = new Set(out.vetted.map((v) => v.agent.agentId));
  // Known real agents first. Built-in agents then count as backups, tried only after the real ones.
  let real = 0;
  for (const c of o.pinReal ? pinnedAgents(capability) : []) {
    seen.add(c.agentId);
    const v = vet(c, "darwin", o);
    if ("skip" in v) out.skipped.push({ agent: refOf(c), reason: v.skip });
    else {
      out.vetted.push({ ...v, tier: v.tier });
      real++;
    }
  }
  if (real) out.searched.push("Known real agents");
  for (const source of sources) {
    const label = source === "darwin" ? "Darwin Search" : "Simulated catalog";
    let result: SearchResult;
    try {
      result = await search(source, query, capability);
    } catch (err) {
      out.notes.push(`${label} failed: ${(err as Error).message}`);
      continue;
    }
    out.searched.push(label);
    if (!result.agents.length && result.note) out.notes.push(`${label}: ${result.note}`);
    for (const c of result.agents) {
      if (seen.has(c.agentId)) continue;
      seen.add(c.agentId);
      const v = vet(c, source, o);
      if ("skip" in v) out.skipped.push({ agent: refOf(c), reason: v.skip });
      else out.vetted.push({ ...v, tier: source === "mock" && (o.client === "darwin" || real > 0) ? "simulated" : v.tier });
    }
  }
  return out;
}

function vet(c: AgentCandidate, source: AgentSource, o: DiscoverOptions): Omit<VettedAgent, "tier"> & { tier: RouteTier } | { skip: string } {
  const listing = toListing(c);
  if (o.useHistory) rememberListing(listing);
  const report = assessTrust({
    listing,
    stats: o.stats.get(`${c.agentId}|${c.capability}`),
    incidents: o.useHistory ? incidentCounts(c.agentId, c.capability) : NO_INCIDENTS,
    trial: o.useHistory ? latestTrial(c.agentId, c.capability) : undefined,
  });
  if (report.verdict === "avoid") return { skip: `Failed its safety check: ${report.safety.summary}` };

  const t = c.terms;
  if (t?.auth === "required" || hasSetup(c.requiredSetup)) return { skip: "Needs a sign-in with its provider, and nobody is around to sign in" };

  const paid = t?.payment === "required" || (t?.runtime !== undefined && PAID_RUNTIMES.has(t.runtime));
  const priceCents = paid ? parsePriceCents(t?.paymentTerms) : undefined;
  if (paid && o.budgetCents <= 0) return { skip: `Charges per call${t?.paymentTerms ? ` (${t.paymentTerms})` : ""}, and this run has no spending limit` };
  if (paid && priceCents !== undefined && priceCents > o.budgetCents) {
    return { skip: `Costs ${fmtCents(priceCents)} per call, more than the run's ${fmtCents(o.budgetCents)} limit` };
  }

  let kind: RoutedAgent["source"] = "mock";
  if (source === "darwin") {
    // Through Act when it's set up, otherwise straight at the agent's own verified address.
    if (actConfigured()) kind = "darwin";
    else if (c.endpoint) kind = "direct";
    else return { skip: "Can't be called: Darwin Act isn't set up and the agent publishes no direct address" };
  }
  // Readiness is only meaningful where it was really checked (the simulated catalog, or an authorized Darwin caller).
  if (c.readiness === "unavailable" && (source === "mock" || actConfigured())) return { skip: "Not answering right now" };

  const agent: RoutedAgent = {
    agentId: c.agentId,
    capabilityId: c.capabilityId,
    name: c.name,
    source: kind,
    provider: c.provider,
    capability: c.capability,
    searchId: c.searchId,
    argumentSchema: c.argumentSchema ?? null,
    ...(kind === "direct" ? { endpoint: c.endpoint } : {}),
    ...(paid ? { paid: true, priceCents } : {}),
  };
  return { agent, tier: paid ? "paid" : "free", rank: c.rank, trustScore: report.score, verdict: report.verdict };
}

/** Option B: the team's own agent goes first. A real one at YOUR_AGENT_MCP_URL, or the simulated stand-in. */
function yourAgent(capability: Capability): RoutedAgent | null {
  if (productMode() !== "your-agent") return null;
  if (env.yourAgentUrl) {
    return {
      agentId: `direct:your-agent:${capability}`,
      capabilityId: `your-agent:${capability}`,
      name: "Your agent",
      provider: "Your team",
      source: "direct",
      capability,
      endpoint: { protocol: "MCP", url: env.yourAgentUrl, origin: "manual" },
    };
  }
  const stand = YOUR_AGENTS.find((a) => a.capability === capability);
  return stand ? { agentId: stand.agentId, capabilityId: stand.capabilityId, name: stand.name, provider: stand.provider, source: "mock", capability } : null;
}

export interface OrderedRoute {
  agents: RoutedAgent[];
  plan: RoutePlan;
  /** A less-tested free agent moved up this time. */
  explored?: RoutedAgent;
}

/**
 * The order one step instance tries agents in: your agent, then free agents, then paid ones, then
 * simulated ones. Within a tier, by verified reliability, then trust, then Darwin's rank.
 * Without Axolotl (baseline) only the first agent runs: your agent, or Darwin's top free result.
 */
export function orderRoute(d: Discovery, capability: Capability, stats: Map<string, AgentStats>, rand?: () => number, baseline = false): OrderedRoute {
  const st = (a: AgentRef) => stats.get(`${a.agentId}|${capability}`);
  const score = (v: VettedAgent) => st(v.agent)?.score ?? 0.5;
  const latency = (v: VettedAgent) => st(v.agent)?.avgLatencyMs || Number.MAX_SAFE_INTEGER;

  let ordered: VettedAgent[];
  let explored: VettedAgent | undefined;
  if (baseline) {
    const first = [...d.vetted].filter((v) => v.tier === "yours" || v.tier === "free").sort((a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier) || a.rank - b.rank)[0];
    ordered = first ? [first] : [];
  } else {
    const byTier = TIER_ORDER.map((tier) =>
      d.vetted
        .filter((v) => v.tier === tier)
        .sort((a, b) => score(b) - score(a) || b.trustScore - a.trustScore || latency(a) - latency(b) || a.rank - b.rank),
    );
    const free = byTier[1];
    if (rand && free.length > 2 && rand() < EXPLORE_RATE) {
      const attempts = (v: VettedAgent) => st(v.agent)?.attempts ?? 0;
      const fresh = free.slice(2).filter((v) => attempts(v) < EXPLORE_MAX_ATTEMPTS && attempts(v) < attempts(free[1]));
      if (fresh.length) {
        explored = fresh[Math.floor(rand() * fresh.length)];
        byTier[1] = [free[0], explored, ...free.slice(1).filter((v) => v !== explored)];
      }
    }
    ordered = byTier.flat();
  }

  const freeSeen = { n: 0 };
  const agents: RouteCandidate[] = ordered.map((v) => ({
    agent: refOf(v.agent),
    tier: v.tier,
    reason: reasonFor(v, v === explored, freeSeen, trackRecord(st(v.agent))),
    ...(v.agent.priceCents !== undefined ? { priceCents: v.agent.priceCents } : {}),
    ...(v.tier !== "yours" ? { trustScore: v.trustScore } : {}),
    ...(v.verdict ? { verdict: v.verdict } : {}),
  }));
  return {
    agents: ordered.map((v) => v.agent),
    plan: { searched: d.searched, agents, skipped: d.skipped, notes: d.notes },
    explored: explored?.agent,
  };
}

function reasonFor(v: VettedAgent, explored: boolean, freeSeen: { n: number }, record: string): string {
  switch (v.tier) {
    case "yours":
      return "Your agent goes first";
    case "free":
      if (explored) return `Less-tested agent, tried early so the rankings stay fair (${record})`;
      return `${freeSeen.n++ === 0 ? "Most" : "Next most"} reliable free agent found (${record})`;
    case "paid":
      return `Paid agent${v.agent.priceCents !== undefined ? ` (${fmtCents(v.agent.priceCents)} per call)` : ""}, tried only after every free one (${record})`;
    case "simulated":
      return `Backup, used only after every real one (${record})`;
  }
}

function trackRecord(s: AgentStats | undefined): string {
  if (!s || s.attempts === 0) return "no track record yet";
  return `${Math.round(s.score * 100)}% verified over ${s.attempts} run${s.attempts === 1 ? "" : "s"}`;
}

function refOf(a: AgentRef): AgentRef {
  return { agentId: a.agentId, capabilityId: a.capabilityId, name: a.name, source: a.source, provider: a.provider };
}

function hasSetup(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true;
}

/** "$0.04 per page audited" → 4. The first dollar amount in the terms; undefined when there is none. */
export function parsePriceCents(terms: string | undefined): number | undefined {
  const m = terms?.match(/\$\s?(\d{1,6}(?:\.\d{1,4})?)/);
  if (!m) return undefined;
  return Math.max(1, Math.round(Number(m[1]) * 100));
}

export function fmtCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
