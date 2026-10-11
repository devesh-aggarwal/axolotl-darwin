// Darwin listings whose MCP address Darwin knows but doesn't publish yet. Their records say the route
// is resolved and no sign-in or payment is needed, but connectionMethods comes back empty because
// Darwin's own route check expired (threadUnavailableReason ROUTE_VERIFICATION_EXPIRED). The address is
// the provider's public MCP server from its Darwin v2 capability record. Darwin hasn't re-verified it,
// so the direct client connects and lists tools before every call, and the trust check says so.
import type { AgentCandidate, AgentEndpoint, Capability } from "@/lib/types";

// Lazynext Accessibility Checker (checker.lazynext.com). Darwin lists its scan_html and scan_url tools as
// separate capabilities and returns either one for an accessibility search. Both run scan_html: it audits
// the page's markup with no quota, so it also works on a site that isn't public; scan_url allows 3 free
// scans a day per IP and can't reach localhost.
const LAZYNEXT: ProviderListing = {
  // Darwin titles these listings by tool name ("scan_url"); the agent's own name reads better on a card.
  name: "Lazynext Accessibility Checker",
  provider: "Lazynext",
  endpoint: { protocol: "MCP", url: "https://checker.lazynext.com/mcp", toolName: "scan_html", origin: "provider" },
};

export interface ProviderListing {
  name: string;
  provider: string;
  endpoint: AgentEndpoint;
}

const KNOWN: Record<string, ProviderListing> = {
  cmuzfoebm00me06pi2c361syz: LAZYNEXT, // scan_html
  cmuzfolno00tc06pijb65ki0z: LAZYNEXT, // scan_url
};

/**
 * Real agents offered on every run that asks for them (RunConfig.realAgents), whether or not Darwin's
 * search returns them that time: Darwin's results vary between identical searches.
 */
export function pinnedAgents(capability: Capability): AgentCandidate[] {
  if (capability !== "accessibility") return [];
  return [
    {
      agentId: "cmuzfnke9004106msw00dinmv",
      capabilityId: "cmuzfoebm00me06pi2c361syz",
      name: LAZYNEXT.name,
      provider: LAZYNEXT.provider,
      source: "darwin",
      capability,
      description: "Audit pasted HTML markup for WCAG violations (static rules, no render, no quota).",
      readiness: "unavailable",
      canStartThread: false,
      reasons: [],
      uncertainties: [],
      requiredSetup: null,
      rank: 1,
      argumentSchema: null,
      endpoint: { ...LAZYNEXT.endpoint },
      terms: { auth: "not_required", authMechanisms: [], payment: "not_required", runtime: "REMOTE_MCP", secretInputs: [], evidence: "DERIVED_FROM_VERIFIED_RECEIPT" },
    },
  ];
}

/** The provider's own MCP address (and name) for a Darwin capability that doesn't publish one, if known. */
export function providerListing(capabilityId: string): ProviderListing | undefined {
  const hit = KNOWN[capabilityId];
  return hit ? { ...hit, endpoint: { ...hit.endpoint } } : undefined;
}
