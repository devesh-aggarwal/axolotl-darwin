import type { AttemptOutcome, FailureType, NodeState, Severity } from "@/lib/types";

export const STATE_COLOR: Record<NodeState, string> = {
  idle: "var(--s-idle)",
  queued: "var(--s-queued)",
  running: "var(--s-running)",
  verifying: "var(--s-verifying)",
  swapping: "var(--s-swapping)",
  passed: "var(--s-passed)",
  failed: "var(--s-failed)",
  partial: "var(--s-partial)",
  cancelled: "var(--s-idle)",
};

export const STATE_LABEL: Record<NodeState, string> = {
  idle: "Waiting",
  queued: "Queued",
  running: "Running",
  verifying: "Checking output",
  swapping: "Switching to backup",
  passed: "Done",
  failed: "Failed",
  partial: "Done (partial)",
  cancelled: "Stopped",
};

export const OUTCOME_COLOR: Record<AttemptOutcome, string> = {
  running: "var(--s-running)",
  verifying: "var(--s-verifying)",
  passed: "var(--s-passed)",
  hard_failure: "var(--s-failed)",
  silent_failure: "var(--s-partial)",
};

export const OUTCOME_LABEL: Record<AttemptOutcome, string> = {
  running: "Running",
  verifying: "Checking",
  passed: "Passed",
  hard_failure: "Failed",
  silent_failure: "Bad output",
};

/** How a failure reads in a sentence: "<agent> <phrase>". */
export const FAILURE_PHRASE: Record<FailureType, string> = {
  error: "crashed",
  timeout: "timed out",
  stall: "stopped responding",
  auth_block: "asked for a login",
  payment_block: "asked for a payment",
  transport: "lost its connection",
  killed: "was stopped",
  verification: "returned bad output",
};

export const FAILURE_LABEL: Record<FailureType, string> = {
  error: "Crashed",
  timeout: "Timed out",
  stall: "Stopped responding",
  auth_block: "Asked for a login",
  payment_block: "Asked for a payment",
  transport: "Lost connection",
  killed: "Stopped",
  verification: "Bad output caught",
};

export const LAYER_NAME: Record<number, string> = {
  1: "Format",
  2: "Sanity rules",
  3: "Spot-check",
  4: "Review",
};

export const SEVERITY_COLOR: Record<Severity, string> = {
  critical: "var(--s-failed)",
  high: "var(--s-partial)",
  medium: "var(--s-verifying)",
  low: "var(--s-running)",
};

export const CATEGORY_LABEL: Record<string, string> = {
  crawl: "Crawl",
  accessibility: "Accessibility",
  performance: "Performance",
  seo: "SEO",
  security: "Security",
  links: "Links",
};

export function fmtMs(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function fmtClock(at: number): string {
  const d = new Date(at);
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

export function shortPath(url: string | undefined): string {
  if (!url) return "";
  try {
    const u = new URL(url);
    const p = u.pathname.replace(/\/demo-site\//, "/");
    if (p === "/" || p === "") return "home";
    return p.replace(/^\//, "").replace(/\.html$/, "");
  } catch {
    return url;
  }
}
