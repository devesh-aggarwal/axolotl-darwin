// Browser-side API client. Thin wrappers over the route handlers in src/app/api.
import type { ProductMode } from "@/config/mode";
import type { NodeTemplate } from "@/config/workflow";
import type {
  AgentCandidate,
  AgentPool,
  AgentSource,
  AgentStats,
  AttemptView,
  ChaosConfig,
  NodeView,
  PoolMember,
  RunConfig,
  RunSummary,
  TimelapseTick,
  TrialResult,
  TrustReport,
} from "@/lib/types";

export interface LlmUsageView {
  model: string;
  keyPresent: boolean;
  processCalls: number;
  dayCalls: number;
  day: string;
  limits: { perProcess: number; perDay: number; maxOutputTokens: number };
  inputTokens: number;
  outputTokens: number;
  cacheHits: number;
  lastError?: string;
}

export interface TimelapseView {
  id: string;
  running: boolean;
  ticks: TimelapseTick[];
  options: { runs: number; chaosRate: number; seed: number; durationMs: number };
}

export interface BootState {
  mode: ProductMode;
  workflow: NodeTemplate[];
  agentTemplates: string[];
  defaults: RunConfig & { manualAuditHours: number; llmCallsPerRun: number };
  chaos: ChaosConfig;
  activeRunId: string | null;
  runs: RunSummary[];
  pools: { mock: AgentPool[]; darwin: AgentPool[] };
  stats: AgentStats[];
  llm: LlmUsageView;
  darwin: { actConfigured: boolean };
  timelapse: TimelapseView | null;
}

export interface RunDetail {
  run: RunSummary;
  nodes: NodeView[];
  attempts: AttemptView[];
}

export interface SearchResponse {
  templateId: string;
  client: AgentSource;
  searchId: string;
  status: string;
  query: string;
  agents: AgentCandidate[];
  note?: string;
}

export interface DirectConnectResponse {
  candidate: AgentCandidate | null;
  tools: { name: string; description: string }[];
  note?: string;
}

export interface ScoreHistoryView {
  agentId: string;
  capability: string;
  points: { at: number; score: number; attempts: number }[];
}

async function call<T>(path: string, init?: RequestInit, timeoutMs = 20_000): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      signal: ctrl.signal,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
      cache: "no-store",
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new Error("The server didn't answer. If several Axolotl tabs are open, close the extras and try again.");
    }
    throw new Error("Can't reach the Axolotl server.");
  } finally {
    clearTimeout(timer);
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

const post = <T>(path: string, body?: unknown) => call<T>(path, { method: "POST", body: JSON.stringify(body ?? {}) });

export const api = {
  state: () => call<BootState>("/api/state"),
  startRun: (config: Partial<RunConfig>) => post<{ run: RunSummary }>("/api/runs", config),
  run: (id: string) => call<RunDetail>(`/api/runs/${encodeURIComponent(id)}`),
  node: (runId: string, nodeId: string) =>
    call<{ node: NodeView; attempts: AttemptView[] }>(`/api/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}`),
  fault: (runId: string, nodeId: string, fault: "kill" | "timeout" | "corrupt" | "auth") =>
    post<{ ok: boolean }>(`/api/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}/fault`, { fault }),
  crash: (id: string) => post<{ ok: boolean }>(`/api/runs/${encodeURIComponent(id)}/crash`),
  resume: (id: string) => post<{ run: RunSummary }>(`/api/runs/${encodeURIComponent(id)}/resume`),
  cancel: (id: string) => post<{ ok: boolean }>(`/api/runs/${encodeURIComponent(id)}/cancel`),
  report: <T>(id: string) => call<T>(`/api/runs/${encodeURIComponent(id)}/report`),
  setChaos: (patch: Partial<ChaosConfig>) => post<{ chaos: ChaosConfig }>("/api/chaos", patch),
  search: (templateId: string, client: AgentSource, query?: string) =>
    call<SearchResponse>(
      `/api/setup/search?templateId=${encodeURIComponent(templateId)}&client=${client}${query ? `&query=${encodeURIComponent(query)}` : ""}`,
    ),
  savePool: (templateId: string, client: AgentSource, members: Partial<PoolMember>[]) =>
    post<{ pool: AgentPool }>("/api/setup/pool", { templateId, client, members }),
  directInfo: (templateId: string) =>
    call<{ testAgent: { name: string; url: string } | null }>(`/api/setup/direct?templateId=${encodeURIComponent(templateId)}`),
  connectDirect: (templateId: string, url: string, toolName?: string) =>
    post<DirectConnectResponse>("/api/setup/direct", { templateId, url, toolName }),
  healthCheck: (client: AgentSource, templateId?: string) => post<{ pools: AgentPool[] }>("/api/setup/health", { client, templateId }),
  resetPools: (client: AgentSource) => post<{ ok: boolean }>("/api/setup/reset", { client }),
  stats: () => call<{ stats: AgentStats[]; history: ScoreHistoryView[] }>("/api/stats"),
  resetStats: () => call<{ ok: boolean }>("/api/stats", { method: "DELETE" }),
  timelapse: () => call<{ timelapse: TimelapseView | null }>("/api/timelapse"),
  startTimelapse: (opts: { runs?: number; chaosRate?: number; durationMs?: number; seed?: number }) =>
    post<{ timelapse: TimelapseView }>("/api/timelapse", opts),
  cancelTimelapse: () => call<{ cancelled: boolean }>("/api/timelapse", { method: "DELETE" }),
  llm: () => call<{ llm: LlmUsageView }>("/api/llm"),
  trust: (capability?: string) => call<{ reports: TrustReport[] }>(`/api/trust${capability ? `?capability=${encodeURIComponent(capability)}` : ""}`),
  // A real agent gets the same time limit as a run attempt (4 minutes), so the call waits longer than usual.
  trial: (templateId: string, agentId: string) =>
    call<{ trial: TrialResult; trust: TrustReport }>("/api/trust/trial", { method: "POST", body: JSON.stringify({ templateId, agentId }) }, 260_000),
};
