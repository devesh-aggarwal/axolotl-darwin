"use client";
import { useEffect, useRef, useState } from "react";
import { useAxolotl } from "@/components/store";
import { Button, Segmented, Toggle } from "@/components/ui/primitives";
import { fmtCents } from "@/components/ui/tokens";
import { SITE_CHECKS, parseRequest } from "@/lib/request";
import type { AgentSource, RunConfig } from "@/lib/types";

/** Stretches simulated agent delays (and their timeouts) so a run takes about 30–40 s, closer to real agents. */
const DEMO_PACE = 1.9;
const DEFAULT_REQUEST = "Audit Tidepool Labs before launch";

export function RunToolbar() {
  const { state, actions } = useAxolotl();
  const boot = state.boot;
  const [request, setRequest] = useState("");
  const [clientDraft, setClient] = useState<AgentSource | null>(null);
  // An empty box runs the default audit, so Start run always works; typing a request changes what runs.
  const parsed = parseRequest(request.trim() ? request : DEFAULT_REQUEST, boot?.defaults.siteUrl ?? "");
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
    if (parsed.kind !== "audit") return;
    setStarting(true);
    // Chaos is always on from this screen, so every run shows agents failing and being replaced.
    // The server setting is switched on too, so a resumed run keeps breaking agents the same way.
    if (chaos && !chaos.enabled) await actions.setChaos({ enabled: true });
    await actions.startRun({
      siteUrl: parsed.siteUrl,
      request: request.trim() || DEFAULT_REQUEST,
      ...(parsed.maxPages ? { maxPages: parsed.maxPages } : {}),
      client,
      llmMode: judge,
      simulatedBackups,
      budgetCents,
      chaos: { ...(chaos ?? { rate: 0.15, weights: {} }), enabled: true } as RunConfig["chaos"],
      timeScale: DEMO_PACE,
    });
    setStarting(false);
  };

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-panel px-4 py-3">
      <form
        className="basis-full lg:basis-0 lg:min-w-[320px] lg:flex-1"
        onSubmit={(e) => {
          e.preventDefault();
          if (!running && !starting) void start();
        }}
      >
        <input
          value={request}
          onChange={(e) => setRequest(e.target.value)}
          aria-label="What should Axolotl do?"
          aria-describedby="request-plan"
          placeholder="What should Axolotl do? e.g. Do a full accessibility audit of Tidepool Labs"
          className="h-10 w-full rounded-[8px] border border-line-strong bg-panel px-3 text-[15px] text-ink outline-none placeholder:text-muted focus:border-[var(--focus)] focus:shadow-[0_0_0_3px_color-mix(in_srgb,var(--focus)_15%,transparent)]"
        />
      </form>
      <div className="relative" ref={settingsRef}>
        <Button tone="ghost" onClick={() => setSettingsOpen((v) => !v)} aria-expanded={settingsOpen}>
          Settings
        </Button>
        {settingsOpen && (
          <div className="card anim-rise absolute right-0 top-11 z-30 flex w-[300px] flex-col gap-4 p-4">
            <div>
              <div className="mb-1.5 text-[13.5px] text-muted">Agents</div>
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
                    <div className="mt-1.5 text-[13px] leading-snug text-muted">
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
                    <div className="mt-1 text-[13px] leading-snug text-muted">
                      {simulatedBackups ? "Real agents go first. Simulated ones finish a step only if they all fail." : "Real agents only. A step with no working agent is left out."}
                    </div>
                  </div>
                </>
              )}
            </div>
            <div>
              <label htmlFor="run-budget" className="mb-1.5 block text-[13.5px] text-muted">
                Spending limit per run
              </label>
              <div className="flex items-center gap-2">
                <div className="relative w-[96px]">
                  <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[14px] text-muted">$</span>
                  <input
                    id="run-budget"
                    type="number"
                    inputMode="decimal"
                    min={0}
                    max={100}
                    step={0.5}
                    value={budgetDollars}
                    onChange={(e) => setBudgetDraft(e.target.value)}
                    className="tabular h-8 w-full rounded-[8px] border border-line-strong bg-panel pl-6 pr-2 text-[14px] text-ink outline-none focus:border-[var(--focus)]"
                  />
                </div>
                <span className="text-[13.5px] text-ink-2">{budgetCents ? "per run" : "No paid agents"}</span>
              </div>
              <div className="mt-1.5 text-[13px] leading-snug text-muted">
                {budgetCents
                  ? `Free agents go first. Paid ones are tried only if every free one fails, up to ${fmtCents(budgetCents)} in total.`
                  : "Paid agents are skipped. Set a limit to let Axolotl use them when every free agent fails."}
              </div>
            </div>
            <div>
              <div className="mb-1.5 text-[13.5px] text-muted">Output review</div>
              <Segmented
                value={judge}
                onChange={setJudge}
                options={[
                  { value: "mock", label: "Rules only" },
                  { value: "live", label: "GPT review" },
                ]}
              />
              {judge === "live" && (
                <div className="mt-1.5 text-[13px] leading-snug text-muted">
                  Uses gpt-5.6-luna, at most {boot?.defaults.llmCallsPerRun ?? 20} calls per run. {llmLeft} left today.
                </div>
              )}
            </div>
            {chaos && (
              <div>
                <div className="mb-1.5 flex justify-between text-[13.5px] text-muted">
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
          <>
            <Button tone="ghost" onClick={actions.crash} title="Kill the engine mid-run to show resume from checkpoint">
              Simulate crash
            </Button>
            <Button tone="default" onClick={actions.cancel} title="Stop every step now. Finished steps keep their results.">
              Stop run
            </Button>
          </>
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
        <Button tone="primary" onClick={start} disabled={starting || running || parsed.kind !== "audit"}>
          {running ? "Running…" : "Start run"}
        </Button>
      </div>
      {request.trim() && <RequestPlan parsed={parsed} />}
    </div>
  );
}

/** What Axolotl will run for the typed request, before it runs. */
function RequestPlan({ parsed }: { parsed: ReturnType<typeof parseRequest> }) {
  if (parsed.kind !== "audit") {
    return (
      <p id="request-plan" className="basis-full text-[13.5px] leading-snug text-ink-2">
        {parsed.message}
      </p>
    );
  }
  const focus = parsed.focus.length === 1 ? ` Focus: ${FOCUS_NAME[parsed.focus[0]]}; the other checks run too.` : "";
  return (
    <p id="request-plan" className="basis-full text-[13.5px] leading-snug text-ink-2">
      <span className="font-medium text-ink">Website audit of {parsed.siteLabel}.</span> Crawl up to {parsed.maxPages ?? 5} pages, then check{" "}
      {SITE_CHECKS}, verify every answer, and draft fixes.{focus}
    </p>
  );
}

const FOCUS_NAME: Record<string, string> = {
  accessibility: "accessibility",
  performance: "performance",
  seo: "SEO",
  security: "security headers",
  links: "broken links",
  crawl: "pages",
};
