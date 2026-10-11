"use client";
import { useEffect, useRef, useState } from "react";
import { useAxolotl } from "@/components/store";
import { Button, Segmented, Toggle } from "@/components/ui/primitives";
import { fmtCents } from "@/components/ui/tokens";
import type { AgentSource } from "@/lib/types";

export function RunToolbar() {
  const { state, actions } = useAxolotl();
  const boot = state.boot;
  const [siteDraft, setSiteUrl] = useState<string | null>(null);
  const [clientDraft, setClient] = useState<AgentSource | null>(null);
  const siteUrl = siteDraft ?? boot?.defaults.siteUrl ?? "";
  const client = clientDraft ?? boot?.defaults.client ?? "mock";
  const [judge, setJudge] = useState<"mock" | "live">("mock");
  const [simulatedBackups, setSimulatedBackups] = useState(true);
  // Spending limit per run, in dollars as typed; sent as cents.
  const [budgetDraft, setBudgetDraft] = useState<string | null>(null);
  const budgetDollars = budgetDraft ?? String((boot?.defaults.budgetCents ?? 0) / 100);
  const budgetCents = Math.round(Math.min(100, Math.max(0, Number(budgetDollars) || 0)) * 100);
  const [starting, setStarting] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!settingsOpen) return;
    const close = (e: MouseEvent) => {
      if (settingsRef.current && !settingsRef.current.contains(e.target as Node)) setSettingsOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setSettingsOpen(false);
      }
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [settingsOpen]);

  const chaos = state.chaos;
  const run = state.run;
  const running = run?.status === "running";
  const resumable = run && (run.status === "crashed" || run.status === "cancelled" || run.status === "partial" || run.status === "failed");
  const llmLeft = boot ? Math.max(0, boot.llm.limits.perDay - boot.llm.dayCalls) : 0;

  const start = async () => {
    setStarting(true);
    // Chaos comes from the server's current setting (the toggle updates it immediately).
    await actions.startRun({ siteUrl, client, llmMode: judge, simulatedBackups, budgetCents });
    setStarting(false);
  };

  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-line bg-panel px-4 py-3">
      <input
        value={siteUrl}
        onChange={(e) => setSiteUrl(e.target.value)}
        spellCheck={false}
        aria-label="Website to audit"
        placeholder="https://your-site.com"
        className="h-9 min-w-[220px] flex-1 rounded-[8px] border border-line-strong bg-panel px-3 text-[13.5px] text-ink outline-none focus:border-[var(--focus)] focus:shadow-[0_0_0_3px_color-mix(in_srgb,var(--focus)_15%,transparent)]"
      />
      {chaos && (
        <Toggle
          ariaLabel="Chaos mode"
          checked={chaos.enabled}
          onChange={(v) => actions.setChaos({ enabled: v })}
          label={<span title="Randomly break agents while the run is going">Chaos</span>}
        />
      )}
      <div className="relative" ref={settingsRef}>
        <Button tone="ghost" onClick={() => setSettingsOpen((v) => !v)} aria-expanded={settingsOpen}>
          Settings
        </Button>
        {settingsOpen && (
          <div className="card anim-rise absolute right-0 top-11 z-30 flex w-[300px] flex-col gap-4 p-4">
            <div>
              <div className="mb-1.5 text-[12.5px] text-muted">Agents</div>
              <Segmented
                value={client}
                onChange={setClient}
                options={[
                  { value: "mock", label: "Simulated" },
                  { value: "darwin", label: "Darwin" },
                ]}
              />
              {client === "darwin" && (
                <>
                  {!boot?.darwin.actConfigured && (
                    <div className="mt-1.5 text-[12px] leading-snug text-muted">
                      Darwin Act isn&rsquo;t connected. Agents that publish their own address are called directly; the others are left out.
                    </div>
                  )}
                  <div className="mt-3">
                    <Toggle
                      ariaLabel="Simulated backups"
                      checked={simulatedBackups}
                      onChange={setSimulatedBackups}
                      label={<span title="If every real agent for a step fails, simulated agents finish it">Simulated backups</span>}
                    />
                    <div className="mt-1 text-[12px] leading-snug text-muted">
                      {simulatedBackups ? "Real agents go first. Simulated ones finish a step only if they all fail." : "Real agents only. A step with no working agent is left out."}
                    </div>
                  </div>
                </>
              )}
            </div>
            <div>
              <label htmlFor="run-budget" className="mb-1.5 block text-[12.5px] text-muted">
                Spending limit per run
              </label>
              <div className="flex items-center gap-2">
                <div className="relative w-[96px]">
                  <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[13px] text-muted">$</span>
                  <input
                    id="run-budget"
                    type="number"
                    inputMode="decimal"
                    min={0}
                    max={100}
                    step={0.5}
                    value={budgetDollars}
                    onChange={(e) => setBudgetDraft(e.target.value)}
                    className="tabular h-8 w-full rounded-[8px] border border-line-strong bg-panel pl-6 pr-2 text-[13px] text-ink outline-none focus:border-[var(--focus)]"
                  />
                </div>
                <span className="text-[12.5px] text-ink-2">{budgetCents ? "per run" : "No paid agents"}</span>
              </div>
              <div className="mt-1.5 text-[12px] leading-snug text-muted">
                {budgetCents
                  ? `Free agents go first. Paid ones are tried only if every free one fails, up to ${fmtCents(budgetCents)} in total.`
                  : "Paid agents are skipped. Set a limit to let Axolotl use them when every free agent fails."}
              </div>
            </div>
            <div>
              <div className="mb-1.5 text-[12.5px] text-muted">Output review</div>
              <Segmented
                value={judge}
                onChange={setJudge}
                options={[
                  { value: "mock", label: "Rules only" },
                  { value: "live", label: "GPT review" },
                ]}
              />
              {judge === "live" && (
                <div className="mt-1.5 text-[12px] leading-snug text-muted">
                  Uses gpt-5.6-luna, at most {boot?.defaults.llmCallsPerRun ?? 20} calls per run. {llmLeft} left today.
                </div>
              )}
            </div>
            {chaos && (
              <div>
                <div className="mb-1.5 flex justify-between text-[12.5px] text-muted">
                  <span>Chaos intensity</span>
                  <span className="tabular">{Math.round(chaos.rate * 100)}%</span>
                </div>
                <input
                  type="range"
                  min={0.05}
                  max={0.6}
                  step={0.05}
                  value={chaos.rate}
                  onChange={(e) => actions.setChaos({ rate: Number(e.target.value) })}
                  className="w-full accent-[var(--s-failed)]"
                  aria-label="Chaos intensity"
                />
              </div>
            )}
          </div>
        )}
      </div>
      <div className="flex items-center gap-2">
        {running && (
          <Button tone="ghost" onClick={actions.crash} title="Kill the engine mid-run to show resume from checkpoint">
            Simulate crash
          </Button>
        )}
        {!running && resumable && (
          <Button
            tone="regrow"
            onClick={actions.resume}
            title="Finished steps are restored from their checkpoints; only the rest runs again"
          >
            {run?.status === "partial" || run?.status === "failed" ? "Retry failed steps" : "Resume from checkpoint"}
          </Button>
        )}
        <Button tone="primary" onClick={start} disabled={starting || running || !siteUrl}>
          {running ? "Running…" : "Start run"}
        </Button>
      </div>
    </div>
  );
}
