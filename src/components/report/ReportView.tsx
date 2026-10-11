"use client";
// Run report, ready in the morning: what to fix first, drafted fixes, the real page with problems
// outlined, every failure and recovery, and the time saved.
import { useEffect, useMemo, useRef, useState } from "react";
import { useAxolotl } from "@/components/store";
import { Button, Empty } from "@/components/ui/primitives";
import { normalizeUrl } from "@/lib/audit/url";
import type { RunReport } from "@/lib/engine/report";
import { FixDrafts } from "@/components/report/FixDrafts";
import { IssueList, type CategoryFilter, type SeverityFilter } from "@/components/report/IssueList";
import { IssueOverlay } from "@/components/report/IssueOverlay";
import { ReportHeader } from "@/components/report/ReportHeader";
import { RunPicker } from "@/components/report/RunPicker";
import { Timeline } from "@/components/report/Timeline";
import { RUN_STATUS_LABEL, defaultRunId, isInterruption } from "@/components/report/format";
import { useReport } from "@/components/report/useReport";

type Section = "issues" | "fixes" | "page" | "timeline";

export function ReportView() {
  const { state, actions } = useAxolotl();
  const [picked, setPicked] = useState<string | null>(null);
  const runs = useMemo(() => [...state.runs].sort((a, b) => b.createdAt - a.createdAt), [state.runs]);
  const runId = picked && runs.some((r) => r.id === picked) ? picked : defaultRunId(runs, state.runId);
  const run = runs.find((r) => r.id === runId) ?? null;
  const { report, error, loading, refresh } = useReport(runId, run);

  const openLive = (id: string) => {
    void actions.loadRun(id).then(() => actions.setTab("run"));
  };

  if (!state.boot) return <Empty title="Loading…" />;
  if (!runs.length || !runId) {
    return (
      <Empty title="No reports yet">
        A report is written at the end of every run: what to fix first, drafted fixes, and the hours saved.
        <span className="mt-4 flex justify-center">
          <Button tone="primary" onClick={() => actions.setTab("run")}>
            Start a run
          </Button>
        </span>
      </Empty>
    );
  }

  let body;
  if (report && report.run.id === runId) {
    body = <ReportBody key={runId} report={report} runId={runId} onOpenLive={() => openLive(runId)} />;
  } else if (error && !loading) {
    body = (
      <Empty title="Couldn't load this report">
        {error}
        <span className="mt-4 flex justify-center">
          <Button onClick={refresh}>Try again</Button>
        </span>
      </Empty>
    );
  } else {
    body = <Empty title="Loading report…" />;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-8 py-2.5">
        <span className="text-[14px] text-muted">Report for</span>
        <RunPicker runs={runs} value={runId} onChange={setPicked} />
        {run?.status === "running" && (
          <span className="flex items-center gap-2 text-[14px] text-muted">
            <span className="anim-pulse inline-block h-2 w-2 rounded-full bg-running" style={{ ["--state" as string]: "var(--s-running)" }} />
            Still running
          </span>
        )}
        <span className="ml-auto flex items-center gap-2">
          {run && (
            <Button tone="ghost" size="sm" onClick={() => openLive(run.id)} title="Open this run's workflow graph">
              Open the run
            </Button>
          )}
          <Button tone="ghost" size="sm" onClick={refresh} disabled={loading}>
            Refresh
          </Button>
        </span>
      </div>
      {/* A size container, so the page view below can be exactly as tall as this scroll area (100cqh). */}
      <div data-report-scroll className="relative flex min-h-0 flex-1 flex-col overflow-y-auto [container-type:size]">
        {body}
      </div>
    </div>
  );
}

function ReportBody({ report, runId, onOpenLive }: { report: RunReport; runId: string; onOpenLive: () => void }) {
  const [section, setSection] = useState<Section>("issues");
  const [category, setCategory] = useState<CategoryFilter>("all");
  const [severity, setSeverity] = useState<SeverityFilter>("all");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [focus, setFocus] = useState<{ id: string; n: number } | null>(null);
  const [page, setPage] = useState<string | null>(null);
  const navRef = useRef<HTMLDivElement>(null);
  const [scrollReq, setScrollReq] = useState<{ n: number; smooth: boolean } | null>(null);

  const issues = report.prioritized?.issues ?? [];
  const fixes = report.fixPlan?.topFixes ?? [];
  const running = report.run.status === "running";
  const incidents = report.timeline.filter((t) => t.kind !== "passed" && t.kind !== "start" && !isInterruption(t)).length;

  // Scrolls the tab bar to the top after the new section renders, so the page view fills the screen.
  useEffect(() => {
    const nav = navRef.current;
    const scroller = nav?.closest("[data-report-scroll]");
    if (!scrollReq || !nav || !scroller) return;
    const top = scroller.scrollTop + nav.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    scroller.scrollTo({ top, behavior: scrollReq.smooth ? "smooth" : "auto" });
  }, [scrollReq]);

  const go = (s: Section) => {
    setSection(s);
    setScrollReq((r) => ({ n: (r?.n ?? 0) + 1, smooth: true }));
  };

  const pickTab = (s: Section) => {
    if (s === "page") return go(s);
    setSection(s);
    // Past the header (tab bar stuck at the top): start the new section from its beginning.
    const nav = navRef.current;
    const scroller = nav?.closest("[data-report-scroll]");
    if (nav && scroller && nav.getBoundingClientRect().top <= scroller.getBoundingClientRect().top + 1) {
      setScrollReq((r) => ({ n: (r?.n ?? 0) + 1, smooth: false }));
    }
  };

  const openIssue = (id: string) => {
    const issue = issues.find((i) => i.id === id);
    if (!issue) return;
    if (category !== "all" && category !== issue.category) setCategory("all");
    if (severity !== "all" && severity !== issue.severity) setSeverity("all");
    setExpanded(id);
    setSection("issues");
    setFocus((f) => ({ id, n: (f?.n ?? 0) + 1 }));
  };

  const showOnPage = (url: string) => {
    setPage(normalizeUrl(url));
    go("page");
  };

  if (!report.prioritized && !report.fixPlan) {
    return (
      <div className="mx-auto w-full max-w-[1080px] px-8 pb-16 pt-10">
        <h1 className="text-[22px] font-semibold tracking-[-0.01em] text-ink">
          {running ? "The report is still being written" : "This run stopped before the report was written"}
        </h1>
        <p className="mt-2 max-w-[720px] text-[15px] leading-relaxed text-ink-2">
          {running
            ? "Problems, drafted fixes and hours saved appear when the audit steps finish. Here is what has happened so far."
            : `The run ended as "${RUN_STATUS_LABEL[report.run.status].toLowerCase()}" before the problems were merged and ranked. Resume it from the Run view to finish the report.`}
        </p>
        {!running && (
          <Button className="mt-5" onClick={onOpenLive}>
            Open the run
          </Button>
        )}
        <div className="mt-10 border-t border-line pt-6">
          <Timeline report={report} />
        </div>
      </div>
    );
  }

  const tabs: { id: Section; label: string; count?: number }[] = [
    { id: "issues", label: "Problems", count: issues.length },
    { id: "page", label: "See them on the page" },
    { id: "fixes", label: "Drafted fixes", count: fixes.length },
    { id: "timeline", label: "What happened", count: incidents || undefined },
  ];
  const pageView = section === "page";

  return (
    <div className={`mx-auto w-full max-w-[1080px] px-8 pt-8 max-sm:px-4 ${pageView ? "" : "pb-16"}`}>
      <ReportHeader report={report} onShowTimeline={() => go("timeline")} />

      {/* The page view is exactly one screen tall, so the frame scrolls on its own and never traps the report's scrolling. */}
      <div ref={navRef} className={`mt-8 ${pageView ? "flex h-[100cqh] min-h-[420px] flex-col" : ""}`}>
        <div className="sticky top-0 z-10 flex gap-x-7 gap-y-1 overflow-x-auto border-b border-line bg-bg pt-3 max-sm:gap-x-5" role="tablist" aria-label="Report sections">
          {tabs.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={section === t.id}
              onClick={() => pickTab(t.id)}
              className={`relative shrink-0 whitespace-nowrap pb-3 text-[15px] transition-colors ${section === t.id ? "text-ink" : "text-muted hover:text-ink-2"}`}
            >
              {t.label}
              {t.count !== undefined && <span className="ml-1.5 tabular text-muted">{t.count}</span>}
              {section === t.id && <span className="absolute inset-x-0 bottom-0 h-[2px] rounded-full bg-ink" />}
            </button>
          ))}
        </div>

        <div className={pageView ? "flex min-h-0 flex-1 flex-col pb-4 pt-4" : "pt-6"}>
          {section === "issues" && (
            <IssueList
              issues={issues}
              dedupedFrom={report.prioritized?.dedupedFrom ?? issues.length}
              fixes={fixes}
              category={category}
              severity={severity}
              onCategory={setCategory}
              onSeverity={setSeverity}
              expandedId={expanded}
              onToggle={(id) => setExpanded((cur) => (cur === id ? null : id))}
              focus={focus}
              onShowOnPage={showOnPage}
            />
          )}
          {section === "fixes" && <FixDrafts plan={report.fixPlan} issues={issues} onOpenIssue={openIssue} />}
          {section === "page" &&
            (report.prioritized ? (
              <IssueOverlay runId={runId} siteUrl={report.run.config.siteUrl} issues={issues} page={page} onPage={setPage} />
            ) : (
              <Empty title="Nothing to show yet">The page view appears once problems are merged and ranked.</Empty>
            ))}
          {section === "timeline" && <Timeline report={report} />}
        </div>
      </div>
    </div>
  );
}
