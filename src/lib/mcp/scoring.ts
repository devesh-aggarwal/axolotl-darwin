// Real MCP calls feed the same reliability scores as workflow runs: every map lookup and every
// cart Axolotl verifies counts for (or against) the agent or route that produced it.
// Simulated delivery platforms, skipped providers and login/payment walls never count.
import { recordAttemptOutcome } from "@/lib/engine/stats";
import { publish } from "@/lib/events";
import type { Attempt } from "@/lib/mcp/failover";
import { routeName } from "@/lib/mcp/hostRoutes";
import type { AgentKind, FailureType, McpCapability } from "@/lib/types";

/** Rows the person or the host produced, not an agent Axolotl called. */
const NOT_AN_AGENT = new Set(["Your saved places", "Web search (run by you)"]);

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/\(.*?\)/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function failureOf(a: Attempt): FailureType {
  if (a.outcome === "rejected") return "verification";
  return /timed out/i.test(a.reason) ? "timeout" : "error";
}

function record(capability: McpCapability, agentId: string, name: string, source: AgentKind, success: boolean, failureType: FailureType | undefined, ms: number, note?: string) {
  try {
    recordAttemptOutcome({ agent: { agentId, capabilityId: capability, name, source }, capability, success, failureType, note, latencyMs: ms });
  } catch {
    // Scoring is bookkeeping; a database hiccup must never fail the tool call.
  }
}

/** Score the map providers behind one address resolution. */
export function scoreAddressAttempts(attempts: Attempt[]): void {
  let any = false;
  for (const a of attempts) {
    if (a.source === "simulated" || NOT_AN_AGENT.has(a.agent)) continue;
    if (a.outcome !== "ok" && a.outcome !== "failed" && a.outcome !== "rejected") continue;
    // A cross-check that disagrees doesn't say which source was wrong, so it counts for neither.
    if (a.step === "cross-check address" && a.outcome === "rejected") continue;
    const ok = a.outcome === "ok";
    record("address", `map:${slug(a.agent)}`, a.agent.split(" (")[0], a.source === "darwin" ? "darwin" : "direct", ok, ok ? undefined : failureOf(a), a.ms, a.reason);
    any = true;
  }
  if (any) publish({ type: "stats_updated", at: Date.now() });
}

/** Score one delivery route on whether the cart it produced passed Axolotl's cart check. */
export function scoreDeliveryRoute(routeId: string, passed: boolean, note?: string): void {
  record("delivery", `route:${slug(routeId)}`, routeName(routeId), "direct", passed, passed ? undefined : "verification", 0, note);
  publish({ type: "stats_updated", at: Date.now() });
}
