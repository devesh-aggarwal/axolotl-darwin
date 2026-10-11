// Event-day check: with the credentials Darwin gives us, which ways of running real agents work?
//   1. Search (always public)      2. Act (needs an allowlisted user token)
//   3. Direct MCP calls to agents whose endpoint Darwin has verified (no Act needed)
// Prints what works and what to do next. Never prints credentials.
//
// Dry run (default): simulated search + Axolotl's local test agents. Nothing leaves this machine.
//   npx tsx --tsconfig tsconfig.json --env-file=.env scripts/darwin-smoke.ts
// Live: real Darwin Search (6 queries) and connection checks (tools/list) on up to 3 endpoints.
//   npx tsx --tsconfig tsconfig.json --env-file=.env scripts/darwin-smoke.ts --live
// Add --act to start ONE Act thread, and --call to make ONE direct tool call (both audit DEMO_SITE_URL).
import { AGENT_TEMPLATES, type NodeTemplate } from "@/config/workflow";
import type { DarwinClient, SearchResult, TaskHandle, TaskPoll } from "@/lib/darwin/types";
import type { AgentCandidate, AgentNodeInput, Capability, RoutedAgent } from "@/lib/types";

const argv = new Set(process.argv.slice(2));
const LIVE = argv.has("--live");
const TRY_ACT = argv.has("--act");
const TRY_CALL = argv.has("--call");
const MAX_DESCRIBE = 3;
const ACT_WAIT_MS = 180_000;

const line = (s = "") => console.log(s);
const head = (s: string) => line(`\n── ${s} ${"─".repeat(Math.max(0, 60 - s.length))}`);

function secretState(v: string | undefined): string {
  return v ? `set (${v.length} characters)` : "not set";
}

function isPublic(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return !["localhost", "127.0.0.1", "::1", "[::1]"].includes(h) && !h.endsWith(".local");
  } catch {
    return false;
  }
}

function inputFor(t: NodeTemplate, siteUrl: string): AgentNodeInput {
  if (t.capability === "crawl") return { siteUrl, maxPages: 5 };
  if (t.scope === "page") return { siteUrl, pageUrl: siteUrl };
  return { siteUrl, pages: [siteUrl] };
}

async function main(): Promise<void> {
  const { env, demoSiteUrl } = await import("@/lib/env");
  const { RealDarwinClient } = await import("@/lib/darwin/real");
  const { MockDarwinClient } = await import("@/lib/darwin/mock");
  const { McpDirectClient } = await import("@/lib/darwin/mcp");
  const { adaptInput } = await import("@/lib/llm/adapter");
  const { translateOutput } = await import("@/lib/translate");

  // A dry run audits a copy of the demo site served from this process.
  const local = LIVE ? null : await (await import("./serve-demo-site")).startDemoServer(0);
  const siteUrl = local ? `${local.origin}/demo-site/` : demoSiteUrl();
  line(LIVE ? "LIVE: talking to Darwin." : "DRY RUN: simulated search and local test agents. Nothing leaves this machine. Add --live on event day.");

  head("Credentials");
  line(`DARWIN_ACCESS_TOKEN (Act): ${secretState(env.darwinAccessToken)}`);
  line(`DARWIN_API_KEY (Search):   ${secretState(env.darwinApiKey)}`);
  line(`DEMO_SITE_URL:             ${siteUrl}${!LIVE || isPublic(siteUrl) ? "" : "  ← not public: real agents can't reach it. Deploy demo-site/ and set DEMO_SITE_URL."}`);

  // ---------- 1. Search ----------
  head("1. Search");
  const search: DarwinClient = LIVE ? new RealDarwinClient() : new MockDarwinClient();
  const results = new Map<Capability, SearchResult>();
  for (const t of AGENT_TEMPLATES) {
    const capability = t.capability as Capability;
    try {
      // One request per search: a rejected credential is reported, not retried anonymously.
      const r = await search.search(t.query ?? capability, { maxResults: 5, capability, noAnonymousRetry: true } as Parameters<DarwinClient["search"]>[1]);
      results.set(capability, r);
      const direct = r.agents.filter((a) => a.endpoint).length;
      const startable = r.agents.filter((a) => a.canStartThread).length;
      line(`${t.label.padEnd(17)} ${String(r.agents.length).padStart(2)} found · ${startable} can start an Act thread · ${direct} with a verified endpoint`);
      for (const a of r.agents.slice(0, 3)) line(`   - ${a.name} (${a.provider ?? a.source}; readiness ${a.readiness})`);
    } catch (err) {
      line(`${t.label.padEnd(17)} search failed: ${(err as Error).message}`);
    }
  }
  const searchWorks = results.size > 0 && [...results.values()].some((r) => r.agents.length > 0);

  // ---------- 2. Act ----------
  head("2. Act (run agents through Darwin)");
  let actVerdict: "works" | "not allowlisted" | "no token" | "failed" | "not tried" = "not tried";
  if (!env.darwinAccessToken && LIVE) {
    actVerdict = "no token";
    line("No DARWIN_ACCESS_TOKEN, so Act can't be used. Ask Darwin for a user token with human:actions on the Act allowlist.");
  } else if (!TRY_ACT) {
    line(LIVE ? "Skipped. Add --act to start one thread (it audits DEMO_SITE_URL)." : "Skipped in a dry run.");
  } else {
    const t = AGENT_TEMPLATES.find((x) => x.capability === "crawl")!;
    const agent = results.get("crawl")?.agents.find((a) => a.canStartThread) ?? results.get("crawl")?.agents[0];
    if (!agent) {
      line("No crawl agent found to try.");
    } else {
      const act = search as InstanceType<typeof RealDarwinClient>;
      const res = await runOnce(act, agent, t, inputFor(t, siteUrl), "act", adaptInput, translateOutput);
      actVerdict = res.verdict;
    }
  }

  // ---------- 3. Direct ----------
  head("3. Direct connection (no Act needed)");
  const mcp = LIVE
    ? new McpDirectClient()
    : new McpDirectClient({
        allowLoopback: true,
        fetchImpl: async (input, init) => {
          const { handleMcpRequest } = await import("@/lib/testAgents/mcpServer");
          const req = new Request(input as RequestInfo, init);
          return handleMcpRequest(req, /\/test-agents\/([\w-]+)\/mcp/.exec(new URL(req.url).pathname)?.[1] ?? "");
        },
      });
  let candidates: AgentCandidate[] = [...results.values()].flatMap((r) => r.agents.filter((a) => a.endpoint));
  if (!LIVE) {
    const { TEST_AGENTS } = await import("@/lib/testAgents/mcpServer");
    candidates = TEST_AGENTS.slice(0, MAX_DESCRIBE).map((a) => ({
      agentId: `direct:${a.id}`,
      capabilityId: a.tool,
      name: `${a.name} (local test agent)`,
      source: "direct",
      capability: a.capability,
      description: a.description,
      readiness: "ready",
      canStartThread: true,
      reasons: [],
      uncertainties: [],
      requiredSetup: null,
      rank: 1,
      endpoint: { protocol: "MCP", url: `http://127.0.0.1:9/test-agents/${a.id}/mcp`, origin: "local-test" },
    }));
  }
  const reachable: { agent: AgentCandidate; tool: string }[] = [];
  if (!candidates.length) {
    line("No search result published a verified MCP endpoint. Direct calls need one (or an address from the provider's docs, added in Setup).");
  }
  for (const a of candidates.slice(0, MAX_DESCRIBE)) {
    try {
      const d = await mcp.describeEndpoint(a.endpoint!.url);
      const tool = mcp.suggestTool(d.tools, a.capability);
      line(`✓ ${a.name}: connected, ${d.tools.length} tool(s)${tool ? `, will use "${tool.name}"` : ", none clearly fits this step"}`);
      if (tool) reachable.push({ agent: { ...a, endpoint: { ...a.endpoint!, toolName: tool.name }, argumentSchema: tool.inputSchema }, tool: tool.name });
    } catch (err) {
      line(`✗ ${a.name}: ${(err as Error).message}`);
    }
  }
  if (candidates.length > MAX_DESCRIBE) line(`(${candidates.length - MAX_DESCRIBE} more not checked; the cap is ${MAX_DESCRIBE})`);
  let directVerdict: "works" | "failed" | "not tried" = "not tried";
  if (reachable.length && (TRY_CALL || !LIVE)) {
    const { agent } = reachable[0];
    const t = AGENT_TEMPLATES.find((x) => x.capability === agent.capability)!;
    const res = await runOnce(mcp, agent, t, inputFor(t, siteUrl), "direct", adaptInput, translateOutput);
    directVerdict = res.verdict === "works" ? "works" : "failed";
  } else if (reachable.length) {
    line("Add --call to make one real tool call with the first reachable agent.");
  }

  // ---------- verdict ----------
  head("What this means");
  if (actVerdict === "works") line("• Act works: pick Darwin agents in Setup; they run through Darwin. Simulated backups stay on as the safety net.");
  else if (actVerdict === "not allowlisted") line("• Act is blocked (not on the pilot allowlist). Ask Darwin to allowlist the token, or use direct agents.");
  else if (actVerdict === "no token") line("• No Act token. Ask Darwin for a user token with human:actions, or use direct agents.");
  if (reachable.length) {
    line(`• ${reachable.length} agent(s) answer directly. In Setup (Darwin Search), they show "can run directly"; pick them and they run without Act.`);
    if (directVerdict === "works") line("  A tool call worked end to end; its answer was translated and is ready for the checks.");
  }
  if (actVerdict !== "works" && !reachable.length) {
    line(
      searchWorks
        ? "• Search only: run in Darwin mode with simulated backups. Setup shows real Darwin results; runs use simulated agents and say so."
        : "• Search failed too: run on simulated agents (Mock catalog).",
    );
  }
  if (LIVE && !isPublic(siteUrl)) line("• Deploy demo-site/ and set DEMO_SITE_URL before any real agent runs.");
  await local?.close();
}

async function runOnce(
  client: DarwinClient,
  agent: AgentCandidate,
  t: NodeTemplate,
  input: AgentNodeInput,
  label: "act" | "direct",
  adaptInput: typeof import("@/lib/llm/adapter").adaptInput,
  translateOutput: typeof import("@/lib/translate").translateOutput,
): Promise<{ verdict: "works" | "not allowlisted" | "failed" }> {
  const member: RoutedAgent = { ...agent };
  const adapted = await adaptInput({ agent: member, template: t, input, llmMode: "mock" });
  line(`Starting one ${label === "act" ? "Act thread" : "tool call"} with ${agent.name}…`);
  let handle: TaskHandle;
  try {
    handle = await client.startTask({
      agent: member,
      instruction: adapted.instruction,
      arguments: adapted.arguments,
      idempotencyKey: `axl:smoke:${label}:${Date.now()}`,
      searchId: agent.searchId,
      context: { runId: "smoke", nodeInstanceId: t.id, capability: t.capability as Capability, input, seed: 1, attemptNo: 1, timeScale: 1 },
    });
  } catch (err) {
    const msg = (err as Error).message;
    line(`✗ couldn't start: ${msg}`);
    return { verdict: /ACT_PREVIEW_ACCESS_REQUIRED/.test(msg) ? "not allowlisted" : "failed" };
  }
  const end = Date.now() + ACT_WAIT_MS;
  let poll: TaskPoll = { status: "running", cursor: "" };
  let last = "";
  try {
    while (Date.now() < end) {
      poll = await client.pollTask(handle);
      if (poll.status !== "running") break;
      if (poll.progress && poll.progress !== last) line(`   … ${(last = poll.progress)}`);
      await new Promise((r) => setTimeout(r, label === "act" ? 3_000 : 300));
    }
  } finally {
    await client.cancelTask(handle).catch(() => undefined);
  }
  if (poll.status === "completed") {
    const tr = await translateOutput(poll.output, { template: t, input, llmMode: "mock" });
    line(`✓ finished. Translation: ${tr.note.text}`);
    return { verdict: "works" };
  }
  if (poll.status === "running") line(`✗ no answer within ${ACT_WAIT_MS / 1000}s (cancelled).`);
  else if (poll.status === "blocked") line(`✗ blocked: ${poll.message}`);
  else line(`✗ ${poll.code}: ${poll.message}`);
  return { verdict: poll.status === "error" && /ACT_PREVIEW_ACCESS_REQUIRED/.test(poll.code) ? "not allowlisted" : "failed" };
}

main().catch((err) => {
  console.error("smoke failed:", (err as Error).message);
  process.exit(1);
});
