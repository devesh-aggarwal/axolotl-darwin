"use client";
// Fetches /api/runs/:id/report. Refetches when the run's status or finish time changes,
// polls while it is still running, and keeps the last good report across refetches.
import { useCallback, useEffect, useState } from "react";
import { api } from "@/components/api";
import type { RunReport } from "@/lib/engine/report";
import type { RunSummary } from "@/lib/types";

const POLL_MS = 4000;

interface Loaded {
  key: string;
  runId: string;
  report: RunReport | null;
  error: string | null;
}

export interface ReportState {
  report: RunReport | null;
  error: string | null;
  loading: boolean;
  refresh: () => void;
}

export function useReport(runId: string | null, run: RunSummary | null): ReportState {
  const running = run?.status === "running";
  const [tick, setTick] = useState(0);
  const [nonce, setNonce] = useState(0);
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setTick((x) => x + 1), POLL_MS);
    return () => clearInterval(t);
  }, [running]);

  const key = runId ? [runId, run?.status ?? "", run?.finishedAt ?? "", running ? tick : 0, nonce].join("|") : null;

  useEffect(() => {
    if (!key || !runId) return;
    let cancelled = false;
    api.report<RunReport>(runId).then(
      (report) => {
        if (!cancelled) setLoaded({ key, runId, report, error: null });
      },
      (err: Error) => {
        if (cancelled) return;
        // A failed refetch keeps the report already on screen.
        setLoaded((prev) => (prev && prev.runId === runId && prev.report ? { ...prev, key, error: err.message } : { key, runId, report: null, error: err.message }));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [key, runId]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  const current = loaded && loaded.runId === runId ? loaded : null;
  return {
    report: current?.report ?? null,
    error: current?.error ?? null,
    loading: Boolean(key) && loaded?.key !== key,
    refresh,
  };
}
