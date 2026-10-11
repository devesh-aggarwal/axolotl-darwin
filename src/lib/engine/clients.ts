// One client instance per kind per process: simulated agents, Darwin Act, and direct MCP calls.
import type { DarwinClient } from "@/lib/darwin/types";
import { McpDirectClient } from "@/lib/darwin/mcp";
import { MockDarwinClient } from "@/lib/darwin/mock";
import { RealDarwinClient } from "@/lib/darwin/real";
import { env } from "@/lib/env";
import type { AgentKind } from "@/lib/types";

type ClientKind = DarwinClient["kind"];
const g = globalThis as unknown as { __axolotlClients?: Partial<Record<ClientKind, DarwinClient>> };

const IMPLS = { mock: MockDarwinClient, real: RealDarwinClient, mcp: McpDirectClient } as const;

/** Client for a pool source ("mock" | "darwin") or an agent's kind ("direct" runs over MCP). */
export function getDarwinClient(source: AgentKind | ClientKind): DarwinClient {
  const kind: ClientKind = source === "darwin" || source === "real" ? "real" : source === "direct" || source === "mcp" ? "mcp" : "mock";
  const Impl = IMPLS[kind];
  g.__axolotlClients ??= {};
  // The instance outlives hot reloads on globalThis; rebuild it if its class was reloaded.
  if (!(g.__axolotlClients[kind] instanceof Impl)) g.__axolotlClients[kind] = new Impl();
  return g.__axolotlClients[kind]!;
}

export function actConfigured(): boolean {
  return Boolean(env.darwinAccessToken);
}
