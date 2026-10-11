"use client";
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { Button, Empty, Segmented } from "@/components/ui/primitives";
import { CATEGORY_LABEL, SEVERITY_COLOR } from "@/components/ui/tokens";
import { RULES } from "@/lib/audit/rules";
import { AUDIT_CATEGORIES, SEVERITIES, type AuditCategory, type FixDraft, type PrioritizedIssue, type Severity } from "@/lib/types";
import { CodeBlock } from "@/components/report/FixDrafts";
import { SEV_LABEL, pageLabel, plural } from "@/components/report/format";
import { cleanText, codesIn } from "@/components/report/planText";

export type CategoryFilter = "all" | AuditCategory;
export type SeverityFilter = "all" | Severity;

const EFFORT_LABEL = { small: "Quick fix", medium: "Moderate", large: "Large change" } as const;

function Count({ n }: { n: number }) {
  return <span className={`ml-1.5 tabular ${n ? "text-muted" : "text-faint"}`}>{n}</span>;
}

export function SeverityMark({ severity }: { severity: Severity }) {
  return (
    <span className="inline-flex items-center gap-2 text-[14px]" style={{ color: SEVERITY_COLOR[severity] }}>
      <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: SEVERITY_COLOR[severity] }} />
      {SEV_LABEL[severity]}
    </span>
  );
}

export function IssueList({
  issues,
  dedupedFrom,
  fixes,
  category,
  severity,
  onCategory,
  onSeverity,
  expandedId,
  onToggle,
  focus,
  onShowOnPage,
}: {
  issues: PrioritizedIssue[];
  dedupedFrom: number;
  fixes: FixDraft[];
  category: CategoryFilter;
  severity: SeverityFilter;
  onCategory: (c: CategoryFilter) => void;
  onSeverity: (s: SeverityFilter) => void;
  expandedId: string | null;
  onToggle: (id: string) => void;
  focus: { id: string; n: number } | null;
  onShowOnPage: (pageUrl: string) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const fixById = new Map(fixes.map((f) => [f.issueId, f]));
  const inSev = (i: PrioritizedIssue) => severity === "all" || i.severity === severity;
  const inCat = (i: PrioritizedIssue) => category === "all" || i.category === category;
  const shown = issues.filter((i) => inCat(i) && inSev(i));

  useEffect(() => {
    if (!focus) return;
    const row = listRef.current?.querySelector<HTMLElement>(`[data-issue="${CSS.escape(focus.id)}"]`);
    row?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [focus]);

  if (!issues.length) return <Empty title="No problems found">Every check that finished came back clean.</Empty>;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <Segmented<CategoryFilter>
          value={category}
          onChange={onCategory}
          options={[
            { value: "all", label: <>All types<Count n={issues.filter(inSev).length} /></> },
            ...AUDIT_CATEGORIES.map((c) => ({
              value: c as CategoryFilter,
              label: (
                <>
                  {CATEGORY_LABEL[c] ?? c}
                  <Count n={issues.filter((i) => i.category === c && inSev(i)).length} />
                </>
              ),
            })),
          ]}
        />
        <Segmented<SeverityFilter>
          value={severity}
          onChange={onSeverity}
          options={[
            { value: "all", label: <>Any severity</> },
            ...SEVERITIES.map((s) => ({
              value: s as SeverityFilter,
              label: (
                <span className="inline-flex items-center">
                  <span className="mr-1.5 inline-block h-[7px] w-[7px] rounded-full" style={{ background: SEVERITY_COLOR[s] }} />
                  {SEV_LABEL[s]}
                  <Count n={issues.filter((i) => i.severity === s && inCat(i)).length} />
                </span>
              ),
            })),
          ]}
        />
      </div>

      <div ref={listRef} className="mt-5">
        <div className="grid grid-cols-[104px_minmax(0,1fr)_minmax(72px,150px)_20px] gap-4 border-b border-line px-3 pb-2 text-[13.5px] text-muted">
          <span>Severity</span>
          <span>Problem</span>
          <span>Page</span>
          <span />
        </div>
        {shown.map((i) => (
          <IssueRow key={i.id} issue={i} fix={fixById.get(i.id)} open={expandedId === i.id} onToggle={() => onToggle(i.id)} onShowOnPage={onShowOnPage} />
        ))}
        {!shown.length && <div className="px-3 py-10 text-center text-[14px] text-muted">No problems match these filters.</div>}
      </div>
      <p className="mt-4 px-3 text-[13.5px] text-muted">
        {shown.length === issues.length ? plural(issues.length, "problem") : `Showing ${shown.length} of ${issues.length} problems`}
        {dedupedFrom > issues.length ? `, merged from ${plural(dedupedFrom, "separate report")},` : ","} ranked by severity, then by effort. Fix from the top.
      </p>
    </div>
  );
}

function IssueRow({
  issue: i,
  fix,
  open,
  onToggle,
  onShowOnPage,
}: {
  issue: PrioritizedIssue;
  fix?: FixDraft;
  open: boolean;
  onToggle: () => void;
  onShowOnPage: (pageUrl: string) => void;
}) {
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onToggle();
    }
  };
  return (
    <div data-issue={i.id} className={`scroll-mt-16 border-b border-line ${open ? "bg-raised" : ""}`}>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={onToggle}
        onKeyDown={onKey}
        className={`grid cursor-pointer grid-cols-[104px_minmax(0,1fr)_minmax(72px,150px)_20px] items-baseline gap-4 rounded-[8px] px-3 py-3.5 transition-colors ${open ? "" : "hover:bg-panel"}`}
      >
        <SeverityMark severity={i.severity} />
        <span className="text-[15px] leading-snug text-ink">{cleanText(i.description)}</span>
        <span className="truncate text-[14px] text-ink-2" title={i.pageUrl}>
          {pageLabel(i.pageUrl)}
        </span>
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden className={`self-center text-muted transition-transform ${open ? "rotate-180" : ""}`}>
          <path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      </div>
      {open && <IssueDetail issue={i} fix={fix} onShowOnPage={onShowOnPage} />}
    </div>
  );
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-4 py-1.5 text-[14px]">
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 break-words text-ink-2">{children}</dd>
    </div>
  );
}

function IssueDetail({ issue: i, fix, onShowOnPage }: { issue: PrioritizedIssue; fix?: FixDraft; onShowOnPage: (pageUrl: string) => void }) {
  const rule = RULES[i.rule];
  const codes = [i.rule, ...codesIn(i.description).filter((c) => c !== i.rule)];
  return (
    <div className="anim-rise px-3 pb-6 pl-[132px] pt-1 max-sm:pl-3">
      <div className="text-[14px] text-muted">How to fix it</div>
      <p className="mt-1 max-w-[720px] text-[15px] leading-relaxed text-ink">{i.recommendation}</p>

      <dl className="mt-5 max-w-[720px]">
        <Detail label="Type">{CATEGORY_LABEL[i.category] ?? i.category}</Detail>
        <Detail label="Check">
          {rule?.title ?? i.rule}
          <span className="text-muted"> ({codes.join(", ")})</span>
        </Detail>
        {i.selector && <Detail label="Element">{i.selector}</Detail>}
        <Detail label="Evidence">{i.evidence || "—"}</Detail>
        <Detail label="Effort">{EFFORT_LABEL[i.effort] ?? i.effort}</Detail>
        <Detail label="Reported by">{i.reportedBy.length ? i.reportedBy.join(", ") : "—"}</Detail>
        {i.duplicates > 1 && <Detail label="Duplicates">{i.duplicates} reports of the same problem were merged into this one</Detail>}
      </dl>

      {fix && (
        <div className="mt-5 max-w-[820px]">
          <div className="mb-2 text-[14px] text-muted">Drafted fix: {fix.title}</div>
          <CodeBlock patch={fix.patch} language={fix.language} />
        </div>
      )}

      <Button className="mt-5" onClick={() => onShowOnPage(i.pageUrl)}>
        Show it on the page
      </Button>
    </div>
  );
}
