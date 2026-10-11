// Trust records in SQLite: every agent setup has seen (its listing), its trials, and the incidents
// runs recorded against it. Reports are computed on read, so they always reflect the latest runs.
// This is the outcome data that can later be shared with users (and with Darwin's ranking).
import { getDb, json } from "@/lib/db";
import { getStatsMap } from "@/lib/engine/stats";
import { assessTrust, NO_INCIDENTS, type IncidentCounts, type Listing } from "@/lib/trust/assess";
import type { AgentCandidate, AgentStats, Capability, TrialResult, TrustReport } from "@/lib/types";

export type IncidentKind = "hijack" | "payment" | "sign_in";

const MAX_TEXT = 4_000;

/** The listing fields worth keeping, clipped so a huge description can't bloat the table. */
export function toListing(c: AgentCandidate, toolText?: string[]): Listing {
  const clip = (s: string | undefined) => (s === undefined ? undefined : s.slice(0, MAX_TEXT));
  return {
    agentId: c.agentId,
    capabilityId: c.capabilityId,
    capability: c.capability,
    name: c.name,
    provider: c.provider,
    source: c.source,
    searchId: c.searchId,
    argumentSchema: c.argumentSchema ?? null,
    description: clip(c.description) ?? "",
    uncertainties: c.uncertainties.slice(0, 20).map((u) => u.slice(0, 500)),
    connectionPrompt: clip(c.connectionPrompt),
    providerCheck: c.providerCheck,
    terms: c.terms,
    endpoint: c.endpoint,
    ...(toolText?.length ? { toolText: toolText.slice(0, 20).map((t) => t.slice(0, 1_000)) } : {}),
  };
}

export function rememberListing(l: Listing): void {
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO agent_listings (agent_id, capability, listing_json, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(agent_id, capability) DO UPDATE SET listing_json = excluded.listing_json, last_seen = excluded.last_seen`,
    )
    .run(l.agentId, l.capability, JSON.stringify(l), now, now);
}

export function getListing(agentId: string, capability: Capability): Listing | null {
  const row = getDb().prepare(`SELECT listing_json FROM agent_listings WHERE agent_id = ? AND capability = ?`).get(agentId, capability) as
    | { listing_json: string }
    | undefined;
  return row ? json<Listing | null>(row.listing_json, null) : null;
}

export function recordTrial(agentId: string, capability: Capability, result: TrialResult): void {
  getDb()
    .prepare(`INSERT INTO agent_trials (agent_id, capability, result_json, at) VALUES (?, ?, ?, ?)`)
    .run(agentId, capability, JSON.stringify(result), result.at);
}

export function latestTrial(agentId: string, capability: Capability): TrialResult | undefined {
  const row = getDb()
    .prepare(`SELECT result_json FROM agent_trials WHERE agent_id = ? AND capability = ? ORDER BY id DESC LIMIT 1`)
    .get(agentId, capability) as { result_json: string } | undefined;
  return row ? json<TrialResult | undefined>(row.result_json, undefined) : undefined;
}

export function recordIncident(agentId: string, capability: Capability, kind: IncidentKind, detail: string, runId?: string): void {
  getDb()
    .prepare(`INSERT INTO agent_incidents (agent_id, capability, kind, detail, run_id, at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(agentId, capability, kind, detail.slice(0, 500), runId ?? null, Date.now());
}

export function incidentCounts(agentId: string, capability: Capability): IncidentCounts {
  const rows = getDb()
    .prepare(`SELECT kind, COUNT(*) AS n FROM agent_incidents WHERE agent_id = ? AND capability = ? GROUP BY kind`)
    .all(agentId, capability) as { kind: IncidentKind; n: number }[];
  const out = { ...NO_INCIDENTS };
  for (const r of rows) {
    if (r.kind === "hijack") out.hijack = r.n;
    else if (r.kind === "payment") out.payment = r.n;
    else if (r.kind === "sign_in") out.signIn = r.n;
  }
  return out;
}

/** Trust report for a listing, with everything Axolotl has seen the agent do. */
export function trustFor(l: Listing, stats: Map<string, AgentStats> = getStatsMap()): TrustReport {
  return assessTrust({
    listing: l,
    stats: stats.get(`${l.agentId}|${l.capability}`),
    incidents: incidentCounts(l.agentId, l.capability),
    trial: latestTrial(l.agentId, l.capability),
  });
}

/** Remember each search result and attach its trust report. */
export function withTrust<T extends AgentCandidate>(candidates: T[], toolText?: string[]): T[] {
  const stats = getStatsMap();
  return candidates.map((c) => {
    const listing = toListing(c, toolText);
    rememberListing(listing);
    return { ...c, trust: trustFor(listing, stats) };
  });
}

/** Every agent setup has seen, newest first, optionally for one capability. */
export function allTrustReports(capability?: Capability): TrustReport[] {
  const rows = getDb()
    .prepare(`SELECT listing_json FROM agent_listings ${capability ? "WHERE capability = ?" : ""} ORDER BY last_seen DESC`)
    .all(...(capability ? [capability] : [])) as { listing_json: string }[];
  const stats = getStatsMap();
  return rows
    .map((r) => json<Listing | null>(r.listing_json, null))
    .filter((l): l is Listing => Boolean(l))
    .map((l) => trustFor(l, stats));
}

/** Trust verdicts by "agentId|capability", for code that only needs to know what's blocked. */
export function trustVerdicts(): Map<string, TrustReport["verdict"]> {
  return new Map(allTrustReports().map((r) => [`${r.agentId}|${r.capability}`, r.verdict]));
}

export function resetTrust(): void {
  getDb().exec(`DELETE FROM agent_listings; DELETE FROM agent_trials; DELETE FROM agent_incidents;`);
}
