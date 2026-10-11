// The demo workflow: overnight pre-launch website audit (spec section 5).
// Node definitions live here so the team can swap capability queries after the
// Darwin check without touching the engine.
import type { AuditCategory, BuiltinStep, Capability } from "@/lib/types";
import type { ContractId } from "@/lib/contracts";

export interface NodeTemplate {
  id: string;
  label: string;
  kind: "agent" | "builtin";
  capability?: Capability;
  builtin?: BuiltinStep;
  /** Natural-language Darwin Search query for this capability. */
  query?: string;
  contract?: ContractId;
  dependsOn: string[];
  /** "page" templates fan out: one instance per page from the crawl output. */
  scope: "site" | "page" | "run";
  fanOutFrom?: string;
  description: string;
  /** Category for audit nodes (issues must carry this category). */
  category?: AuditCategory;
}

export const WORKFLOW: NodeTemplate[] = [
  {
    id: "crawl",
    label: "Crawl",
    kind: "agent",
    capability: "crawl",
    query: "crawl a website and list its pages",
    contract: "crawl",
    dependsOn: [],
    scope: "run",
    description: "Find the site's key pages.",
  },
  {
    id: "a11y",
    label: "Accessibility",
    kind: "agent",
    capability: "accessibility",
    category: "accessibility",
    query: "WCAG accessibility audit of a web page",
    contract: "audit",
    dependsOn: ["crawl"],
    scope: "page",
    fanOutFrom: "crawl",
    description: "Per-page WCAG 2.2 AA audit: alt text, contrast, labels, names, language.",
  },
  {
    id: "perf",
    label: "Performance",
    kind: "agent",
    capability: "performance",
    category: "performance",
    query: "web page performance audit lighthouse",
    contract: "audit",
    dependsOn: ["crawl"],
    scope: "page",
    fanOutFrom: "crawl",
    description: "Per-page performance: heavy images, layout shift, render-blocking resources.",
  },
  {
    id: "seo",
    label: "SEO",
    kind: "agent",
    capability: "seo",
    category: "seo",
    query: "SEO audit of a website",
    contract: "audit",
    dependsOn: ["crawl"],
    scope: "site",
    description: "Site-wide SEO: titles, meta descriptions, headings, robots.txt, sitemap.",
  },
  {
    id: "security",
    label: "Security headers",
    kind: "agent",
    capability: "security",
    category: "security",
    query: "check security headers and SSL of a website",
    contract: "audit",
    dependsOn: ["crawl"],
    scope: "site",
    description: "Response headers, HSTS, CSP, insecure form actions.",
  },
  {
    id: "links",
    label: "Broken links",
    kind: "agent",
    capability: "links",
    category: "links",
    query: "find broken links on a website",
    contract: "audit",
    dependsOn: ["crawl"],
    scope: "site",
    description: "Internal and external links that 404 or don't resolve.",
  },
  {
    id: "merge",
    label: "Merge",
    kind: "builtin",
    builtin: "merge",
    dependsOn: ["a11y", "perf", "seo", "security", "links"],
    scope: "run",
    description: "Waits for every branch. A branch where every agent found failed is marked partial, not fatal.",
  },
  {
    id: "prioritize",
    label: "Prioritize",
    kind: "builtin",
    builtin: "prioritize",
    dependsOn: ["merge"],
    scope: "run",
    description: "Dedupe overlapping findings and rank by severity and effort.",
  },
  {
    id: "fixplan",
    label: "Fix plan",
    kind: "builtin",
    builtin: "fixplan",
    dependsOn: ["prioritize"],
    scope: "run",
    description: "Final report with drafted fixes for the top issues.",
  },
];

export const AGENT_TEMPLATES = WORKFLOW.filter((t) => t.kind === "agent");

export function getTemplate(id: string): NodeTemplate {
  const t = WORKFLOW.find((n) => n.id === id);
  if (!t) throw new Error(`Unknown workflow node template: ${id}`);
  return t;
}

/**
 * Timing for real Darwin agents. Darwin's thread cursor only advances when new messages arrive,
 * so a slow but healthy agent can show no progress for a long time; stall detection is loose.
 */
export const REAL_TIMING = {
  attemptTimeoutMs: 240_000,
  stallMs: 120_000,
  pollIntervalMs: 2_000,
};

/** Defaults for the live single run and the time-lapse. */
export const DEFAULTS = {
  maxPages: 5,
  concurrency: 6,
  /** Per-attempt timeout at timeScale 1. */
  attemptTimeoutMs: 14_000,
  /** No cursor progress for this long (timeScale 1) = stalled thread. */
  stallMs: 6_000,
  pollIntervalMs: 400,
  /** Estimated developer hours one full audit replaces (drives "time saved"). */
  manualAuditHours: 6,
  /** Hard cap on live LLM calls per run (judge + adapter + fix plan). */
  llmCallsPerRun: 20,
};
