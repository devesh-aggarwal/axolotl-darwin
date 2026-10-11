// Darwin Search for the MCP tools: cached for ten minutes, one retry on a server error (Darwin's
// search returns intermittent 500s), and the search token stripped before anything leaves.
// TODO(runtime-discovery): once engine/discovery.ts lands on main, vet and order results with
// discover() + orderRoute() here so the MCP tools and the engine share one set of routing rules.
import { getDarwinClient } from "@/lib/engine/clients";
import type { AgentCandidate } from "@/lib/types";

export interface FoundAgents {
  searchId: string;
  query: string;
  agents: AgentCandidate[];
  note?: string;
}

const TTL_MS = 10 * 60_000;
const g = globalThis as unknown as { __axolotlAgentCache?: Map<string, { at: number; value: FoundAgents }> };

export async function findAgents(query: string, maxResults = 5): Promise<FoundAgents> {
  const key = `${maxResults}:${query.trim().toLowerCase()}`;
  g.__axolotlAgentCache ??= new Map();
  const hit = g.__axolotlAgentCache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  const client = getDarwinClient("darwin");
  let lastErr: unknown;
  for (let i = 0; i < 2; i++) {
    try {
      const r = await client.search(query, { maxResults });
      const value: FoundAgents = { searchId: r.searchId, query: r.query, agents: r.agents, note: r.note };
      g.__axolotlAgentCache.set(key, { at: Date.now(), value });
      if (g.__axolotlAgentCache.size > 200) g.__axolotlAgentCache.delete(g.__axolotlAgentCache.keys().next().value as string);
      return value;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Compact listing for a model to read. */
export function describeAgent(a: AgentCandidate): Record<string, unknown> {
  return {
    name: a.name,
    agentId: a.agentId,
    capabilityId: a.capabilityId,
    rank: a.rank,
    what: a.description.length > 240 ? `${a.description.slice(0, 237)}...` : a.description,
    why: a.reasons.slice(0, 2),
    caveats: a.uncertainties.slice(0, 2),
    readiness: a.readiness,
    runsDirectly: Boolean(a.endpoint),
  };
}
