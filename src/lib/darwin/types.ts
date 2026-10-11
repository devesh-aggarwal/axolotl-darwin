// DarwinClient abstraction (spec section 8). The engine only talks to this interface,
// so MockDarwinClient and RealDarwinClient are interchangeable per run.
import type { AgentCandidate, AgentNodeInput, AgentRef, Capability, CorruptionKind, FaultMode, Readiness } from "@/lib/types";

export interface SearchOptions {
  maxResults?: number;
  /** Lets the mock return its catalog for a capability; the real client ignores it. */
  capability?: Capability;
}

export interface SearchResult {
  searchId: string;
  status: string;
  query: string;
  agents: AgentCandidate[];
  /** Darwin's plain-language assessment / no-match reason, when present. */
  note?: string;
  /** Anonymous Darwin searches return a token Act needs (X-Search-Token). Never logged. */
  searchToken?: string;
}

export interface TaskContext {
  runId: string;
  nodeInstanceId: string;
  capability: Capability;
  input: AgentNodeInput;
  seed: number;
  attemptNo: number;
  timeScale: number;
  /** Fault the engine wants this attempt to suffer (chaos / manual button). Mock honors it; real ignores it. */
  forcedFault?: FaultMode;
  /** Pages from the crawl, so mock corruption can invent pages that don't exist. */
  knownPages?: string[];
}

export interface StartTaskParams {
  agent: AgentRef;
  /** Natural-language instruction from the input adapter. */
  instruction: string;
  /** Structured arguments when the capability exposes an argument schema. */
  arguments?: Record<string, unknown>;
  /** Same key ⇒ same task. Reused only for a transport retry of the identical request. */
  idempotencyKey: string;
  searchId?: string;
  context: TaskContext;
}

export interface TaskHandle {
  taskId: string;
  threadId: string;
  actRequestId?: string;
  startedAt: number;
}

export type TaskPoll =
  | { status: "running"; cursor: string; progress?: string }
  | {
      status: "completed";
      cursor: string;
      output: unknown;
      raw: unknown;
      /**
       * Experiment oracle. Mock only. NEVER read by verification; used to score the
       * "without Axolotl" baseline (did a corrupted report get accepted?).
       */
      oracle?: { corrupted: boolean; corruption?: CorruptionKind };
    }
  | { status: "error"; cursor: string; code: string; message: string; retryable: boolean }
  | { status: "blocked"; cursor: string; kind: "authentication" | "payment" | "approval"; message: string };

export class TransportError extends Error {
  readonly transport = true;
  constructor(message: string) {
    super(message);
    this.name = "TransportError";
  }
}

export interface HealthResult {
  status: Readiness;
  ready: boolean;
  detail: string;
  checkedAt: number;
}

export interface DarwinClient {
  readonly kind: "mock" | "real" | "mcp";
  search(query: string, opts?: SearchOptions): Promise<SearchResult>;
  /** May throw TransportError (engine retries once with the same idempotency key). */
  startTask(params: StartTaskParams): Promise<TaskHandle>;
  /** May throw TransportError. */
  pollTask(handle: TaskHandle, cursor?: string): Promise<TaskPoll>;
  cancelTask(handle: TaskHandle): Promise<void>;
  healthCheck(agent: AgentRef): Promise<HealthResult>;
}
