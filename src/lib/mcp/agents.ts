// Darwin Search for the MCP tools: cached for ten minutes, one retry on a server error (Darwin's
// search returns intermittent 500s), and the search token stripped before anything leaves.
// routeAgents() vets and orders results with the engine's own discover() + orderRoute(), so the MCP
// tools and workflow runs share one set of rules: unsafe, sign-in-only and uncallable agents are
// dropped, paid ones only within budget, free before paid.
import type { NodeTemplate } from "@/config/workflow";
import { getDarwinClient } from "@/lib/engine/clients";
import { MAX_RESULTS, discover, fmtCents, orderRoute, type SearchFn } from "@/lib/engine/discovery";
import type { AgentCandidate, AgentRef, Capability, RouteCandidate } from "@/lib/types";

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

export interface RoutedAgents {
  searchId: string;
  /** Callable now, in the order Axolotl would try them. */
  runnable: (RouteCandidate & { candidate?: AgentCandidate })[];
  /** Found but left out, with the reason. */
  skipped: { agent: AgentRef; reason: string }[];
  notes: string[];
}

/** Darwin Search, vetted and ordered by the engine's routing rules. Never writes trust history. */
export async function routeAgents(query: string, opts: { budgetCents?: number; maxResults?: number } = {}): Promise<RoutedAgents> {
  let found: FoundAgents | null = null;
  const search: SearchFn = async () => {
    found = await findAgents(query, opts.maxResults ?? MAX_RESULTS);
    return { searchId: found.searchId, status: "completed", query: found.query, agents: found.agents, note: found.note };
  };
  // Capability only keys reliability stats here; MCP lookups start with none.
  const capability: Capability = "crawl";
  const template = { id: "mcp", label: query, kind: "agent", capability, query, dependsOn: [], scope: "run", description: query } satisfies NodeTemplate;
  const d = await discover({ template, client: "darwin", simulatedBackups: false, budgetCents: opts.budgetCents ?? 0, stats: new Map(), useHistory: false, search });
  const { plan } = orderRoute(d, capability, new Map());
  const byId = new Map(((found as FoundAgents | null)?.agents ?? []).map((a) => [a.agentId, a]));
  return {
    searchId: (found as FoundAgents | null)?.searchId ?? "",
    runnable: plan.agents.map((r) => ({ ...r, candidate: byId.get(r.agent.agentId) })),
    skipped: plan.skipped,
    notes: plan.notes,
  };
}

export { fmtCents };
