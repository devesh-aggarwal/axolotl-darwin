// Report-local formatting and derivations. Pure functions, safe on the client.
// Colors are CSS variables only, so the view follows the palette in globals.css.
import type { TimelineEntry } from "@/lib/engine/report";
import { shortPath } from "@/components/ui/tokens";
import { normalizeUrl, siteRootUrl } from "@/lib/audit/url";
import { isSiteWide } from "@/components/report/planText";
import type { PrioritizedIssue, RunStatus, RunSummary, Severity } from "@/lib/types";

export const RUN_STATUS_COLOR: Record<RunStatus, string> = {
  running: "var(--s-running)",
  completed: "var(--s-passed)",
  partial: "var(--s-partial)",
  failed: "var(--s-failed)",
  crashed: "var(--s-failed)",
  cancelled: "var(--s-idle)",
};

export const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  running: "Running",
  completed: "Completed",
  partial: "Partial",
  failed: "Failed",
  crashed: "Crashed",
  cancelled: "Stopped",
};

export const SEV_LABEL: Record<Severity, string> = { critical: "Critical", high: "High", medium: "Medium", low: "Low" };

export const TIMELINE_COLOR: Record<TimelineEntry["kind"], string> = {
  start: "var(--faint)",
  passed: "var(--faint)",
  hard_failure: "var(--s-failed)",
  silent_failure: "var(--s-partial)",
  recovered: "var(--regrow)",
  exhausted: "var(--s-failed)",
};

export const TIMELINE_LABEL: Record<TimelineEntry["kind"], string> = {
  start: "Started",
  passed: "Passed",
  hard_failure: "Agent failed",
  silent_failure: "Bad output caught",
  recovered: "Backup took over",
  exhausted: "Gave up after every agent failed",
};

/**
 * An attempt cut off because the run itself stopped (a crash or a cancel), not because the agent failed.
 * The run's stats don't count these as failures, so the report doesn't either.
 */
export function isInterruption(e: TimelineEntry): boolean {
  return e.kind === "hard_failure" && /^The run stopped while the agent was working/.test(e.detail);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function dayStart(t: number): number {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** "Today 9:55 PM", "Yesterday 11:10 PM", "Oct 8 2:02 PM" (clock in the viewer's locale). */
export function fmtWhen(at: number, now = Date.now()): string {
  const d = new Date(at);
  const hm = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const days = Math.round((dayStart(now) - dayStart(at)) / 86_400_000);
  if (days === 0) return `Today ${hm}`;
  if (days === 1) return `Yesterday ${hm}`;
  return `${MONTHS[d.getMonth()]} ${d.getDate()} ${hm}`;
}

/** Whole hours stay whole ("8"); fractions keep one decimal ("6.5"). */
export function fmtHours(h: number): string {
  if (!Number.isFinite(h)) return "—";
  return Number.isInteger(h) ? String(h) : h.toFixed(1);
}

export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "a, b and c". */
export function listJoin(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** The run to open when nothing is picked: the run selected in the console, else the latest finished one. */
export function defaultRunId(runs: RunSummary[], selected: string | null): string | null {
  if (selected && runs.some((r) => r.id === selected)) return selected;
  return runs.find((r) => r.status !== "running")?.id ?? runs[0]?.id ?? selected ?? null;
}

export function pageLabel(url: string): string {
  return shortPath(url) || url;
}

export interface OverlayPage {
  url: string;
  label: string;
  count: number;
}

/**
 * Pages the overlay can show: the site root plus every page an issue points at, root first.
 * Counts are page-specific problems only; site-wide ones are counted separately, as the overlay does.
 */
export function overlayPages(siteUrl: string, issues: PrioritizedIssue[]): OverlayPage[] {
  const root = normalizeUrl(siteRootUrl(siteUrl));
  const byUrl = new Map<string, OverlayPage>();
  const add = (url: string) => {
    const key = normalizeUrl(url);
    let p = byUrl.get(key);
    if (!p) {
      p = { url: key, label: pageLabel(key), count: 0 };
      byUrl.set(key, p);
    }
    return p;
  };
  add(root);
  for (const i of issues) if (!isSiteWide(i)) add(i.pageUrl).count += 1;
  return [...byUrl.values()].sort((a, b) => (a.url === root ? -1 : b.url === root ? 1 : a.label.localeCompare(b.label)));
}

export function overlaySrc(runId: string, pageUrl: string): string {
  return `/api/overlay?runId=${encodeURIComponent(runId)}&page=${encodeURIComponent(pageUrl)}`;
}

/** Copies text, falling back to a hidden textarea where the async clipboard is unavailable. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
