"use client";
// Setup (user awake): for each agent step, search, pick a primary and backups, approve them
// up front, then save and health-check. Unattended runs only ever use what is saved here.
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/components/api";
import { useAxolotl } from "@/components/store";
import { Button, Empty, Segmented } from "@/components/ui/primitives";
import { fmtClock } from "@/components/ui/tokens";
import type { AgentCandidate, AgentPool, AgentSource } from "@/lib/types";
import { ApproveStep } from "./ApproveStep";
import { HealthStep } from "./HealthStep";
import {
  MAX_BACKUPS,
  assignBackup,
  assignPrimary,
  draftFromPool,
  draftMembers,
  fromCandidate,
  moveUp,
  newestPool,
  removeMember,
  sameAsPool,
  setApproved,
  slotKey,
  toSavePayload,
  type Draft,
} from "./model";
import { NodeRail, NodeStrip, type RailEntry } from "./NodeRail";
import { PickStep, type SearchState } from "./PickStep";
import { Dot } from "./ui";

interface CheckSummary {
  at: number;
  ready: number;
  total: number;
}

/** Inline two-step reset: "confirm" waits for a second click, "done" shows a short success note. */
type ResetStage = { kind: "confirm" | "done"; client: AgentSource } | null;
const CONFIRM_MS = 5000;
const DONE_MS = 3000;

/** Survives tab switches: a half-finished setup is still there when the user comes back. */
const memory: {
  client: AgentSource | null;
  selected: string | null;
  queries: Record<string, string>;
  searches: Record<string, SearchState>;
  drafts: Record<string, Draft>;
} = { client: null, selected: null, queries: {}, searches: {}, drafts: {} };

function withoutClient<T>(rec: Record<string, T>, client: AgentSource): Record<string, T> {
  return Object.fromEntries(Object.entries(rec).filter(([k]) => !k.startsWith(`${client}:`)));
}

export function SetupView() {
  const { state, actions } = useAxolotl();
  const boot = state.boot;

  const [clientPick, setClientPick] = useState<AgentSource | null>(() => memory.client);
  const [selectedPick, setSelectedPick] = useState<string | null>(() => memory.selected);
  const [queries, setQueries] = useState<Record<string, string>>(() => memory.queries);
  const [searches, setSearches] = useState<Record<string, SearchState>>(() => memory.searches);
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() => memory.drafts);
  /** Pools returned by save / health-check, shown until the boot snapshot catches up. */
  const [fresh, setFresh] = useState<Record<string, AgentPool>>({});
  const [busy, setBusy] = useState<Record<string, "save" | "check" | undefined>>({});
  const [nodeErrors, setNodeErrors] = useState<Record<string, string | null>>({});
  const [globalBusy, setGlobalBusy] = useState<"check" | "reset" | null>(null);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [lastCheck, setLastCheck] = useState<Partial<Record<AgentSource, CheckSummary>>>({});
  const [resetStage, setResetStage] = useState<ResetStage>(null);
  const confirmRef = useRef<HTMLDivElement>(null);
  const searchSeq = useRef<Record<string, number>>({});

  // The confirm step quietly backs out after a few seconds; the success note fades the same way.
  useEffect(() => {
    if (!resetStage) return;
    // Keyboard focus lands on Cancel, so a second Enter never resets by accident.
    if (resetStage.kind === "confirm") confirmRef.current?.querySelector<HTMLButtonElement>("button:last-child")?.focus();
    const t = setTimeout(() => setResetStage(null), resetStage.kind === "confirm" ? CONFIRM_MS : DONE_MS);
    return () => clearTimeout(t);
  }, [resetStage]);

  useEffect(() => {
    memory.client = clientPick;
    memory.selected = selectedPick;
    memory.queries = queries;
    memory.drafts = drafts;
    // An in-flight search is dropped on unmount, so only settled results are kept.
    memory.searches = Object.fromEntries(Object.entries(searches).filter(([, v]) => v.status !== "loading"));
  }, [clientPick, selectedPick, queries, drafts, searches]);

  // Pool changes from anywhere (saves, health checks, the background scheduler) refresh the snapshot.
  useEffect(() => {
    const t = setTimeout(() => void actions.refreshBoot(), 150);
    return () => clearTimeout(t);
  }, [state.poolsVersion, actions]);

  const templates = useMemo(() => boot?.workflow.filter((t) => t.kind === "agent") ?? [], [boot]);
  const client: AgentSource = clientPick ?? boot?.defaults.client ?? "mock";
  const actConfigured = Boolean(boot?.darwin.actConfigured);
  const template = templates.find((t) => t.id === selectedPick) ?? templates[0];

  if (!boot) return <Empty title="Loading setup…" />;
  if (!template) return <Empty title="This workflow has no agent steps" />;

  const poolFor = (templateId: string): AgentPool | null =>
    newestPool(boot.pools[client]?.find((p) => p.templateId === templateId) ?? null, fresh[slotKey(client, templateId)]);

  const key = slotKey(client, template.id);
  const pool = poolFor(template.id);
  const draft = drafts[key] ?? draftFromPool(pool);
  const dirty = !sameAsPool(draft, pool);
  const members = draftMembers(draft);
  const query = queries[template.id] ?? template.query ?? "";

  const pickDone = Boolean(draft.primary) && draft.backups.length >= MAX_BACKUPS;
  const approveDone = members.length > 0 && members.every((m) => m.approved);
  const healthDone = Boolean(pool) && !dirty && Boolean(pool?.members.every((m) => m.lastHealthCheck));
  const activeStep = !pickDone ? 1 : !approveDone ? 2 : !healthDone ? 3 : 0;

  const rail: RailEntry[] = templates.map((t) => {
    const p = poolFor(t.id);
    const d = drafts[slotKey(client, t.id)];
    return { template: t, pool: p, dirty: d ? !sameAsPool(d, p) : false };
  });

  const editDraft = (fn: (d: Draft) => Draft) => setDrafts((all) => ({ ...all, [key]: fn(all[key] ?? draftFromPool(pool)) }));
  const storePool = (p: AgentPool) => setFresh((f) => ({ ...f, [slotKey(p.client, p.templateId)]: p }));

  const runSearch = async () => {
    const k = key;
    const seq = (searchSeq.current[k] ?? 0) + 1;
    searchSeq.current[k] = seq;
    setSearches((s) => ({ ...s, [k]: { ...s[k], status: "loading", error: undefined } }));
    try {
      const result = await api.search(template.id, client, query.trim() || undefined);
      if (searchSeq.current[k] !== seq) return;
      setSearches((s) => ({ ...s, [k]: { status: "done", result, at: Date.now() } }));
    } catch (err) {
      if (searchSeq.current[k] !== seq) return;
      setSearches((s) => ({ ...s, [k]: { ...s[k], status: "error", error: (err as Error).message } }));
    }
  };

  const searchId = searches[key]?.result?.searchId;
  const onPrimary = (c: AgentCandidate) => editDraft((d) => assignPrimary(d, fromCandidate(c, pool, searchId)));
  const onBackup = (c: AgentCandidate) => editDraft((d) => assignBackup(d, fromCandidate(c, pool, searchId)));

  const save = async () => {
    const k = key;
    if (!draft.primary) return;
    setBusy((b) => ({ ...b, [k]: "save" }));
    setNodeErrors((e) => ({ ...e, [k]: null }));
    try {
      const { pool: saved } = await api.savePool(template.id, client, toSavePayload(draft));
      storePool(saved);
      setDrafts((all) => {
        const next = { ...all };
        delete next[k];
        return next;
      });
      void actions.refreshBoot();
    } catch (err) {
      setNodeErrors((e) => ({ ...e, [k]: `Couldn't save: ${(err as Error).message}` }));
    } finally {
      setBusy((b) => ({ ...b, [k]: undefined }));
    }
  };

  const checkNode = async () => {
    const k = key;
    setBusy((b) => ({ ...b, [k]: "check" }));
    setNodeErrors((e) => ({ ...e, [k]: null }));
    try {
      const { pools } = await api.healthCheck(client, template.id);
      pools.forEach(storePool);
      void actions.refreshBoot();
    } catch (err) {
      setNodeErrors((e) => ({ ...e, [k]: `Health check failed: ${(err as Error).message}` }));
    } finally {
      setBusy((b) => ({ ...b, [k]: undefined }));
    }
  };

  const checkAll = async () => {
    const c = client;
    setGlobalBusy("check");
    setGlobalError(null);
    try {
      const { pools } = await api.healthCheck(c);
      pools.forEach(storePool);
      const all = pools.flatMap((p) => p.members);
      setLastCheck((l) => ({ ...l, [c]: { at: Date.now(), ready: all.filter((m) => m.ready).length, total: all.length } }));
      void actions.refreshBoot();
    } catch (err) {
      setGlobalError(`Health check failed: ${(err as Error).message}`);
    } finally {
      setGlobalBusy(null);
    }
  };

  const askReset = () => {
    setGlobalError(null);
    setResetStage({ kind: "confirm", client });
  };

  const reset = async () => {
    const c = client;
    setResetStage(null);
    setGlobalBusy("reset");
    setGlobalError(null);
    try {
      await api.resetPools(c);
      setFresh((f) => withoutClient(f, c));
      setDrafts((d) => withoutClient(d, c));
      setLastCheck((l) => ({ ...l, [c]: undefined }));
      await actions.refreshBoot();
      setResetStage({ kind: "done", client: c });
    } catch (err) {
      setGlobalError(`Reset failed: ${(err as Error).message}`);
    } finally {
      setGlobalBusy(null);
    }
  };

  const summary = lastCheck[client];
  const stage = resetStage?.client === client ? resetStage.kind : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-x-6 gap-y-2 border-b border-line bg-raised px-4 py-2.5">
        <div className="flex items-center gap-2.5">
          <span className="text-[12.5px] text-muted">Find agents in</span>
          <Segmented
            value={client}
            onChange={setClientPick}
            options={[
              { value: "mock", label: "Mock catalog", title: "Built-in mock agents, local and repeatable" },
              { value: "darwin", label: "Darwin Search", title: "The public Darwin API" },
            ]}
          />
        </div>
        <span
          className="flex items-center gap-1.5 text-[12.5px] text-muted"
          title={actConfigured ? "Darwin agents can be searched and run" : "Darwin agents can be searched, but not run, until an account is connected"}
        >
          <Dot color={actConfigured ? "var(--s-passed)" : "var(--faint)"} hollow={!actConfigured} />
          {actConfigured ? "Real Darwin agents: connected" : "Real Darwin agents: not connected yet"}
        </span>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
          {globalError ? (
            <span className="max-w-[360px] truncate text-[12.5px] text-[var(--s-failed)]" title={globalError}>
              {globalError}
            </span>
          ) : stage === "done" ? (
            <span className="anim-rise text-[12.5px] text-[var(--s-passed)]" role="status">
              {client === "mock" ? "Default agents restored" : "Saved Darwin agents cleared"}
            </span>
          ) : stage === "confirm" ? (
            <span className="text-[12.5px] text-muted">
              {client === "mock" ? "Replace your picks with the default agents?" : "Remove every saved Darwin agent?"}
            </span>
          ) : (
            summary && (
              <span className="text-[12.5px] text-muted">
                Checked at <span className="tabular">{fmtClock(summary.at)}</span> ·{" "}
                <span className="tabular" style={{ color: summary.ready === summary.total ? "var(--s-passed)" : "var(--ink-2)" }}>
                  {summary.ready} of {summary.total}
                </span>{" "}
                ready
              </span>
            )
          )}
          {stage === "confirm" ? (
            <div ref={confirmRef} className="flex items-center gap-1.5">
              <Button tone="danger" onClick={reset} disabled={globalBusy !== null}>
                Confirm reset
              </Button>
              <Button tone="ghost" onClick={() => setResetStage(null)}>
                Cancel
              </Button>
            </div>
          ) : (
            <>
              <Button onClick={checkAll} disabled={globalBusy !== null}>
                {globalBusy === "check" ? "Checking…" : "Check health of all"}
              </Button>
              <Button tone="ghost" onClick={askReset} disabled={globalBusy !== null}>
                {globalBusy === "reset" ? "Resetting…" : "Reset to defaults"}
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Below 1100px the step list becomes one sideways row and the three steps stack. */}
      <div className="shrink-0 border-b border-line bg-raised min-[1100px]:hidden">
        <NodeStrip entries={rail} selectedId={template.id} onSelect={setSelectedPick} />
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col overflow-y-auto min-[1100px]:flex-row min-[1100px]:overflow-hidden">
        <aside className="hidden w-[236px] shrink-0 border-r border-line bg-raised min-[1100px]:block">
          <NodeRail entries={rail} selectedId={template.id} onSelect={setSelectedPick} />
        </aside>

        <section className="relative min-w-0 shrink-0 min-[1100px]:min-h-0 min-[1100px]:flex-1 min-[1100px]:overflow-y-auto" aria-label="Pick agents">
          <PickStep
            key={key}
            template={template}
            client={client}
            actConfigured={actConfigured}
            query={query}
            onQuery={(q) => setQueries((all) => ({ ...all, [template.id]: q }))}
            onSearch={runSearch}
            search={searches[key]}
            draft={draft}
            savedPool={pool}
            onPrimary={onPrimary}
            onBackup={onBackup}
            onUnassign={(k) => editDraft((d) => removeMember(d, k))}
            done={pickDone}
            active={activeStep === 1}
          />
        </section>

        <aside
          className="relative shrink-0 border-t border-line bg-raised min-[1100px]:min-h-0 min-[1100px]:w-[372px] min-[1100px]:overflow-y-auto min-[1100px]:border-l min-[1100px]:border-t-0"
          aria-label="Approve and check health"
        >
          <ApproveStep
            client={client}
            actConfigured={actConfigured}
            draft={draft}
            onApprove={(k, v) => editDraft((d) => setApproved(d, k, v))}
            onMoveUp={(k) => editDraft((d) => moveUp(d, k))}
            onRemove={(k) => editDraft((d) => removeMember(d, k))}
            done={approveDone}
            active={activeStep === 2}
          />
          <div className="mx-6 border-t border-line min-[1100px]:mx-5" />
          <HealthStep
            client={client}
            pool={pool}
            dirty={dirty}
            canSave={Boolean(draft.primary)}
            busy={busy[key] ?? null}
            error={nodeErrors[key] ?? null}
            onSave={save}
            onCheck={checkNode}
            done={healthDone}
            active={activeStep === 3}
          />
        </aside>
      </div>
    </div>
  );
}
