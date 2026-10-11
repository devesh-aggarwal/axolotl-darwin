"use client";
// Client state: boot snapshot from /api/state, then live engine events over SSE.
import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from "react";
import { api, type BootState, type RunDetail, type TimelapseView } from "@/components/api";
import { stepName } from "@/components/ui/names";
import { FAILURE_PHRASE } from "@/components/ui/tokens";
import type { AgentRef, AttemptView, ChaosConfig, EngineEvent, NodeView, RunConfig, RunSummary } from "@/lib/types";

export type Tab = "run" | "setup" | "night" | "evolution" | "report";

export interface AlertItem {
  id: number;
  at: number;
  level: "info" | "warn" | "error";
  message: string;
  nodeId?: string;
  runId?: string;
}

export interface ActivityItem {
  id: number;
  at: number;
  kind: "recovered" | "lost" | "done" | "started" | "note";
  text: string;
  nodeId?: string;
}

export interface SwapMark {
  at: number;
  from: AgentRef;
  to: AgentRef;
  reason: string;
}

interface State {
  connected: boolean;
  boot: BootState | null;
  bootError: string | null;
  tab: Tab;
  runs: RunSummary[];
  runId: string | null;
  run: RunSummary | null;
  nodes: Record<string, NodeView>;
  attempts: Record<string, AttemptView[]>;
  alerts: AlertItem[];
  activity: ActivityItem[];
  swaps: Record<string, SwapMark>;
  flashes: Record<string, number>;
  selectedNodeId: string | null;
  chaos: ChaosConfig | null;
  statsVersion: number;
  poolsVersion: number;
  timelapse: TimelapseView | null;
}

type Action =
  | { type: "boot"; boot: BootState }
  | { type: "bootError"; error: string }
  | { type: "connected"; value: boolean }
  | { type: "tab"; tab: Tab }
  | { type: "loadRun"; detail: RunDetail }
  | { type: "selectNode"; nodeId: string | null }
  | { type: "chaos"; chaos: ChaosConfig }
  | { type: "event"; event: EngineEvent }
  | { type: "timelapse"; timelapse: TimelapseView | null }
  | { type: "alert"; level: AlertItem["level"]; message: string };

const MAX_ALERTS = 250;
let alertSeq = 0;

const initial: State = {
  connected: false,
  boot: null,
  bootError: null,
  tab: "run",
  runs: [],
  runId: null,
  run: null,
  nodes: {},
  attempts: {},
  alerts: [],
  activity: [],
  swaps: {},
  flashes: {},
  selectedNodeId: null,
  chaos: null,
  statsVersion: 0,
  poolsVersion: 0,
  timelapse: null,
};

function upsertRun(runs: RunSummary[], run: RunSummary): RunSummary[] {
  const i = runs.findIndex((r) => r.id === run.id);
  if (i === -1) return [run, ...runs].slice(0, 30);
  const next = runs.slice();
  next[i] = run;
  return next;
}

function pushAlert(alerts: AlertItem[], a: Omit<AlertItem, "id">): AlertItem[] {
  const next = [...alerts, { ...a, id: ++alertSeq }];
  return next.length > MAX_ALERTS ? next.slice(next.length - MAX_ALERTS) : next;
}

function pushActivity(list: ActivityItem[], a: Omit<ActivityItem, "id" | "at">): ActivityItem[] {
  const next = [...list, { ...a, id: ++alertSeq, at: Date.now() }];
  return next.length > 60 ? next.slice(next.length - 60) : next;
}

function nodeName(node: NodeView | undefined): string {
  return node ? stepName(node) : "A step";
}

function groupAttempts(list: AttemptView[]): Record<string, AttemptView[]> {
  const out: Record<string, AttemptView[]> = {};
  for (const a of list) (out[a.nodeId] ??= []).push(a);
  for (const k of Object.keys(out)) out[k].sort((x, y) => x.attemptNo - y.attemptNo);
  return out;
}

function reduce(state: State, action: Action): State {
  switch (action.type) {
    case "boot":
      return { ...state, boot: action.boot, bootError: null, runs: action.boot.runs, chaos: action.boot.chaos, timelapse: action.boot.timelapse };
    case "bootError":
      return { ...state, bootError: action.error };
    case "connected":
      return { ...state, connected: action.value };
    case "tab":
      return { ...state, tab: action.tab };
    case "loadRun": {
      const nodes: Record<string, NodeView> = {};
      for (const n of action.detail.nodes) nodes[n.id] = n;
      return {
        ...state,
        runId: action.detail.run.id,
        run: action.detail.run,
        runs: upsertRun(state.runs, action.detail.run),
        nodes,
        attempts: groupAttempts(action.detail.attempts),
        swaps: {},
        flashes: {},
        activity: state.runId === action.detail.run.id ? state.activity : [],
        selectedNodeId: state.runId === action.detail.run.id ? state.selectedNodeId : null,
        alerts: state.runId === action.detail.run.id ? state.alerts : state.alerts.filter((a) => !a.runId),
      };
    }
    case "selectNode":
      return { ...state, selectedNodeId: action.nodeId };
    case "chaos":
      return { ...state, chaos: action.chaos };
    case "timelapse":
      return { ...state, timelapse: action.timelapse };
    case "alert":
      return { ...state, alerts: pushAlert(state.alerts, { at: Date.now(), level: action.level, message: action.message }) };
    case "event":
      return applyEvent(state, action.event);
  }
}

function applyEvent(state: State, e: EngineEvent): State {
  switch (e.type) {
    case "run_started": {
      const runs = upsertRun(state.runs, e.run);
      if (e.run.id !== state.runId) return { ...state, runs };
      return { ...state, runs, run: e.run };
    }
    case "run_finished": {
      const runs = upsertRun(state.runs, e.run);
      if (e.run.id !== state.runId) return { ...state, runs };
      const label = e.run.status === "completed" ? "Run completed" : `Run ${e.run.status}`;
      const doneText =
        e.run.status === "completed"
          ? "Run finished. Every step passed its checks."
          : e.run.status === "partial"
            ? "Run finished with a gap: one branch couldn't be recovered."
            : e.run.status === "crashed"
              ? "The engine went down mid-run. Resume picks up from the last finished step."
              : `Run ${e.run.status}.`;
      return {
        ...state,
        runs,
        run: e.run,
        activity: pushActivity(state.activity, { kind: e.run.status === "completed" ? "done" : "lost", text: doneText }),
        alerts: pushAlert(state.alerts, { at: Date.now(), level: e.run.status === "completed" ? "info" : "warn", message: label, runId: e.run.id }),
      };
    }
    case "node_added":
    case "node_updated": {
      if (e.runId !== state.runId) return state;
      const prev = state.nodes[e.node.id];
      const flashes =
        e.node.state === "failed" && prev?.state !== "failed" ? { ...state.flashes, [e.node.id]: Date.now() } : state.flashes;
      const lost = e.node.state === "failed" && Boolean(e.node.error) && !prev?.error;
      const activity = lost
        ? pushActivity(state.activity, { kind: "lost", text: `${nodeName(e.node)} couldn't be recovered. The rest of the run continues.`, nodeId: e.node.id })
        : state.activity;
      return { ...state, nodes: { ...state.nodes, [e.node.id]: { ...prev, ...e.node } }, flashes, activity };
    }
    case "node_removed": {
      if (e.runId !== state.runId) return state;
      const nodes = { ...state.nodes };
      delete nodes[e.nodeId];
      return { ...state, nodes };
    }
    case "attempt": {
      if (e.runId !== state.runId) return state;
      const list = state.attempts[e.attempt.nodeId] ?? [];
      const i = list.findIndex((a) => a.id === e.attempt.id);
      const next = i === -1 ? [...list, e.attempt] : list.map((a, idx) => (idx === i ? e.attempt : a));
      return { ...state, attempts: { ...state.attempts, [e.attempt.nodeId]: next } };
    }
    case "swap": {
      if (e.runId !== state.runId) return state;
      const failed = [...(state.attempts[e.nodeId] ?? [])].reverse().find((a) => a.failureType);
      const phrase = failed?.failureType ? FAILURE_PHRASE[failed.failureType] : "failed";
      return {
        ...state,
        swaps: { ...state.swaps, [e.nodeId]: { at: Date.now(), from: e.from, to: e.to, reason: e.reason } },
        activity: pushActivity(state.activity, {
          kind: "recovered",
          text: `${nodeName(state.nodes[e.nodeId])}: ${e.from.name} ${phrase}. Switched to ${e.to.name}.`,
          nodeId: e.nodeId,
        }),
      };
    }
    case "alert": {
      if (e.runId && e.runId !== state.runId) return state;
      return { ...state, alerts: pushAlert(state.alerts, { at: e.at, level: e.level, message: e.message, nodeId: e.nodeId, runId: e.runId }) };
    }
    case "stats_updated":
      return { ...state, statsVersion: state.statsVersion + 1 };
    case "pool_updated":
      return { ...state, poolsVersion: state.poolsVersion + 1 };
    case "timelapse": {
      const tl = state.timelapse && state.timelapse.id === e.data.id ? state.timelapse : null;
      const base: TimelapseView = tl ?? { id: e.data.id, running: true, ticks: [], options: { runs: e.data.total, chaosRate: 0, seed: 0, durationMs: 0 } };
      const ticks = base.ticks.some((t) => t.index === e.data.index) ? base.ticks : [...base.ticks, e.data];
      return { ...state, timelapse: { ...base, ticks, running: !e.data.done } };
    }
  }
}

interface Actions {
  setTab: (tab: Tab) => void;
  refreshBoot: () => Promise<void>;
  startRun: (config: Partial<RunConfig>) => Promise<void>;
  loadRun: (runId: string) => Promise<void>;
  selectNode: (nodeId: string | null) => void;
  injectFault: (nodeId: string, fault: "kill" | "timeout" | "corrupt" | "auth") => Promise<void>;
  crash: () => Promise<void>;
  resume: () => Promise<void>;
  cancel: () => Promise<void>;
  setChaos: (patch: Partial<ChaosConfig>) => Promise<void>;
  startTimelapse: (opts: { runs?: number; chaosRate?: number; durationMs?: number }) => Promise<void>;
  cancelTimelapse: () => Promise<void>;
  notify: (level: AlertItem["level"], message: string) => void;
}

const Ctx = createContext<{ state: State; actions: Actions } | null>(null);

export function AxolotlProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reduce, initial);
  const runIdRef = useRef<string | null>(null);
  useEffect(() => {
    runIdRef.current = state.runId;
  }, [state.runId]);

  const notify = useCallback((level: AlertItem["level"], message: string) => dispatch({ type: "alert", level, message }), []);
  const guard = useCallback(
    async (fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (err) {
        notify("error", (err as Error).message);
      }
    },
    [notify],
  );

  const loadRun = useCallback(async (runId: string) => {
    const detail = await api.run(runId);
    runIdRef.current = runId;
    dispatch({ type: "loadRun", detail });
  }, []);

  const refreshBoot = useCallback(async () => {
    try {
      const boot = await api.state();
      dispatch({ type: "boot", boot });
      const pick = runIdRef.current ?? boot.activeRunId ?? boot.runs[0]?.id ?? null;
      if (pick && pick !== runIdRef.current) await loadRun(pick).catch(() => undefined);
    } catch (err) {
      dispatch({ type: "bootError", error: (err as Error).message });
    }
  }, [loadRun]);

  useEffect(() => {
    const syncFromHash = () => {
      const fromHash = (window.location.hash.slice(1) || "run") as Tab;
      if (["run", "setup", "night", "evolution", "report"].includes(fromHash)) dispatch({ type: "tab", tab: fromHash });
    };
    syncFromHash();
    window.addEventListener("hashchange", syncFromHash);
    void refreshBoot();
    // Browsers allow ~6 open connections per host, and every tab's live stream holds one.
    // Hidden tabs disconnect, and catch up (boot snapshot + current run) when shown again.
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const disconnect = () => {
      if (retry) clearTimeout(retry);
      retry = null;
      es?.close();
      es = null;
      dispatch({ type: "connected", value: false });
    };
    const connect = () => {
      if (es || document.visibilityState === "hidden") return;
      es = new EventSource("/api/events");
      es.onopen = () => dispatch({ type: "connected", value: true });
      es.onerror = () => {
        dispatch({ type: "connected", value: false });
        disconnect();
        retry = setTimeout(connect, 2000);
      };
      es.onmessage = (msg) => {
        try {
          const event = JSON.parse(msg.data) as EngineEvent | { type: "hello" };
          if (event.type === "hello") return;
          dispatch({ type: "event", event });
        } catch {
          // ignore malformed frames
        }
      };
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        disconnect();
        return;
      }
      connect();
      void refreshBoot();
      if (runIdRef.current) void loadRun(runIdRef.current).catch(() => undefined);
    };
    document.addEventListener("visibilitychange", onVisibility);
    connect();
    return () => {
      window.removeEventListener("hashchange", syncFromHash);
      document.removeEventListener("visibilitychange", onVisibility);
      disconnect();
    };
  }, [refreshBoot, loadRun]);

  // Keep the open tab in the URL hash so a reload lands on the same view.
  useEffect(() => {
    const want = state.tab === "run" ? "" : `#${state.tab}`;
    if (window.location.hash !== want) window.history.replaceState(null, "", want || window.location.pathname);
  }, [state.tab]);

  // Pools changed somewhere (setup, health checks): refresh the boot snapshot so every view sees them.
  useEffect(() => {
    if (!state.poolsVersion) return;
    const t = setTimeout(() => void refreshBoot(), 300);
    return () => clearTimeout(t);
  }, [state.poolsVersion, refreshBoot]);

  const actions = useMemo<Actions>(
    () => ({
      setTab: (tab) => dispatch({ type: "tab", tab }),
      refreshBoot,
      notify,
      loadRun: (runId) => guard(() => loadRun(runId)),
      startRun: (config) =>
        guard(async () => {
          const { run } = await api.startRun(config);
          runIdRef.current = run.id;
          dispatch({ type: "loadRun", detail: { run, nodes: [], attempts: [] } });
          dispatch({ type: "tab", tab: "run" });
          // Pick up anything emitted before our state switched to this run.
          setTimeout(() => void loadRun(run.id).catch(() => undefined), 150);
        }),
      selectNode: (nodeId) => dispatch({ type: "selectNode", nodeId }),
      injectFault: (nodeId, fault) =>
        guard(async () => {
          if (!runIdRef.current) return;
          await api.fault(runIdRef.current, nodeId, fault);
        }),
      crash: () =>
        guard(async () => {
          if (runIdRef.current) await api.crash(runIdRef.current);
        }),
      resume: () =>
        guard(async () => {
          if (!runIdRef.current) return;
          const id = runIdRef.current;
          await api.resume(id);
          setTimeout(() => void loadRun(id).catch(() => undefined), 150);
        }),
      cancel: () =>
        guard(async () => {
          if (runIdRef.current) await api.cancel(runIdRef.current);
        }),
      setChaos: (patch) =>
        guard(async () => {
          const { chaos } = await api.setChaos(patch);
          dispatch({ type: "chaos", chaos });
        }),
      startTimelapse: (opts) =>
        guard(async () => {
          const { timelapse } = await api.startTimelapse(opts);
          dispatch({ type: "timelapse", timelapse });
        }),
      cancelTimelapse: () =>
        guard(async () => {
          await api.cancelTimelapse();
        }),
    }),
    [guard, loadRun, notify, refreshBoot],
  );

  return <Ctx.Provider value={{ state, actions }}>{children}</Ctx.Provider>;
}

export function useAxolotl() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAxolotl must be used inside <AxolotlProvider>");
  return v;
}
