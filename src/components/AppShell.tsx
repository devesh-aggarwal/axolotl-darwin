"use client";
import { useEffect, useState } from "react";
import { EvolutionView } from "@/components/evolution/EvolutionView";
import { NightView } from "@/components/night/NightView";
import { ReportView } from "@/components/report/ReportView";
import { Inspector } from "@/components/run/Inspector";
import { RunToolbar } from "@/components/run/RunToolbar";
import { WorkflowGraph } from "@/components/run/WorkflowGraph";
import { AxolotlProvider, useAxolotl, type Tab } from "@/components/store";
import { CloseIcon, Empty } from "@/components/ui/primitives";
import { Toasts } from "@/components/ui/Toasts";
import { useCopy } from "@/components/ui/copy";

// The story in order: run, read the report. Then the proof that it matters.
const FLOW: { id: Tab; label: string; step: number }[] = [
  { id: "run", label: "Live run", step: 1 },
  { id: "report", label: "Report", step: 2 },
];
const PROOF: { id: Tab; label: string }[] = [
  { id: "night", label: "Overnight" },
  { id: "evolution", label: "Rankings" },
];

export function Mark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden>
      <g fill="none" stroke="var(--regrow)" strokeWidth="4.5" strokeLinecap="round">
        <path d="M14 22c-4-2-6-6-6-10M14 30c-5 0-9-2-11-5M15 38c-4 2-8 2-11 1" />
        <path d="M50 22c4-2 6-6 6-10M50 30c5 0 9-2 11-5M49 38c4 2 8 2 11 1" />
      </g>
      <ellipse cx="32" cy="34" rx="18" ry="15" fill="var(--regrow)" />
      <circle cx="25" cy="31" r="2.8" fill="var(--ink)" />
      <circle cx="39" cy="31" r="2.8" fill="var(--ink)" />
    </svg>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      ref={(el) => {
        // On phones the nav scrolls sideways; keep the open tab in view.
        if (active && el) el.scrollIntoView({ block: "nearest", inline: "nearest" });
      }}
      className={`flex h-10 shrink-0 items-center whitespace-nowrap rounded-[8px] px-2.5 text-[14.5px] transition-colors lg:px-3 ${
        active ? "bg-panel-2 font-semibold text-ink" : "text-muted hover:bg-panel-2/60 hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

function TopBar() {
  const { state, actions } = useAxolotl();
  const copy = useCopy();
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-panel px-4 lg:gap-8">
      <div className="flex shrink-0 items-center gap-2">
        <Mark size={24} />
        <span className="text-[18px] font-semibold tracking-[-0.02em] text-ink">Axolotl</span>
        <span className="ml-1 hidden text-[13.5px] text-muted 2xl:inline">{copy.tagline}</span>
      </div>
      <nav
        className="no-scrollbar -my-2 flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto py-2 max-md:pr-6 max-md:[mask-image:linear-gradient(to_right,#000_80%,transparent)]"
        aria-label="Views"
      >
        {FLOW.map((t) => (
          <TabButton key={t.id} active={state.tab === t.id} onClick={() => actions.setTab(t.id)}>
            <span
              className={`mr-1.5 inline-flex h-[20px] w-[20px] items-center justify-center rounded-full text-[12px] font-semibold tabular ${
                state.tab === t.id ? "bg-ink text-white" : "bg-panel-2 text-muted"
              }`}
            >
              {t.step}
            </span>
            {t.label}
          </TabButton>
        ))}
        <span className="mx-2 h-5 w-px shrink-0 bg-line-strong lg:mx-3" aria-hidden />
        <span className="mr-1 hidden shrink-0 text-[13px] font-medium text-muted md:inline">Proof</span>
        {PROOF.map((t) => (
          <TabButton key={t.id} active={state.tab === t.id} onClick={() => actions.setTab(t.id)}>
            {t.label}
          </TabButton>
        ))}
      </nav>
      <div
        className="flex shrink-0 items-center gap-1.5 text-[13.5px]"
        style={{ color: state.connected ? "var(--muted)" : "var(--s-partial)" }}
        title={state.connected ? "Live updates connected" : "Live updates paused. Reconnecting…"}
      >
        <span className="inline-block h-[8px] w-[8px] rounded-full" style={{ background: state.connected ? "var(--s-passed)" : "var(--s-partial)" }} />
        <span className="hidden sm:inline">{state.connected ? "Live" : "Paused"}</span>
      </div>
    </header>
  );
}

function useNarrow(breakpoint = 1100): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [breakpoint]);
  return narrow;
}

function RunView() {
  const { state, actions } = useAxolotl();
  const hasRun = Boolean(state.run);
  const narrow = useNarrow();
  const [statsOpen, setStatsOpen] = useState(false);
  // On narrow screens the inspector floats over the graph and opens on demand.
  const panelOpen = !narrow || statsOpen || Boolean(state.selectedNodeId);
  const { selectNode } = actions;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (state.selectedNodeId) selectNode(null);
      else setStatsOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state.selectedNodeId, selectNode]);
  const [viewportW, setViewportW] = useState(1024);
  useEffect(() => {
    const on = () => setViewportW(window.innerWidth);
    on();
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  const coverRight = narrow && panelOpen ? Math.min(380, viewportW * 0.9) : 0;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <RunToolbar />
      <div className="relative flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="relative min-h-0 flex-1">
            {hasRun ? (
              <WorkflowGraph coverRight={coverRight} />
            ) : (
              <Empty title="Audit a website overnight, without babysitting it">
                Press Start run. Axolotl finds an agent for each step, checks every answer, and switches to another agent when one fails. Turn on Chaos to see it recover.
              </Empty>
            )}
            {narrow && hasRun && !panelOpen && (
              <button
                onClick={() => setStatsOpen(true)}
                className="card absolute right-3 top-3 z-10 px-3 py-1.5 text-[13.5px] font-medium text-ink-2 hover:text-ink"
              >
                Run summary
              </button>
            )}
          </div>
        </div>
        {panelOpen && (
          <aside
            className={
              narrow
                ? "absolute inset-y-0 right-0 z-20 w-[min(380px,90%)] border-l border-line bg-panel shadow-[var(--shadow-panel)]"
                : "w-[clamp(300px,28vw,380px)] shrink-0 border-l border-line bg-panel"
            }
          >
            {narrow && !state.selectedNodeId && (
              <button
                className="absolute right-2 top-2 z-10 inline-flex h-8 w-8 items-center justify-center rounded-[8px] text-muted hover:bg-panel-2 hover:text-ink"
                onClick={() => setStatsOpen(false)}
                aria-label="Close"
              >
                <CloseIcon />
              </button>
            )}
            <Inspector />
          </aside>
        )}
      </div>
    </div>
  );
}

function Body() {
  const { state } = useAxolotl();
  if (state.bootError && !state.boot) {
    return <Empty title="Can't reach the Axolotl server">{state.bootError}</Empty>;
  }
  switch (state.tab) {
    case "run":
      return <RunView />;
    case "night":
      return <NightView />;
    case "evolution":
      return <EvolutionView />;
    case "report":
      return <ReportView />;
  }
}

/** While the live stream is down, motion that implies "happening now" stops (see .stale in globals.css). */
function Frame({ children }: { children: React.ReactNode }) {
  const { state } = useAxolotl();
  const stale = !state.connected && state.run?.status === "running";
  return <div className={`relative flex h-screen flex-col overflow-hidden ${stale ? "stale" : ""}`}>{children}</div>;
}

export function AppShell() {
  return (
    <AxolotlProvider>
      <Frame>
        <TopBar />
        <main className="flex min-h-0 flex-1 flex-col">
          <Body />
        </main>
        <Toasts />
      </Frame>
    </AxolotlProvider>
  );
}
