// Setup view state: the pool draft a user builds from search results before saving it.
import { DEFAULTS, type NodeTemplate } from "@/config/workflow";
import type { AgentCandidate, AgentEndpoint, AgentKind, AgentPool, AgentSource, Capability, PoolMember, Readiness } from "@/lib/types";

export const MAX_BACKUPS = DEFAULTS.backupsPerNode;

export const SOURCE_LABEL: Record<AgentKind, string> = { mock: "Mock catalog", darwin: "Darwin Search", direct: "Direct connection" };

export interface DraftMember {
  agentId: string;
  capabilityId: string;
  name: string;
  provider?: string;
  source: AgentKind;
  approved: boolean;
  searchId?: string;
  argumentSchema?: Record<string, unknown> | null;
  endpoint?: AgentEndpoint;
  /** The search result this member was picked from, when it came from a search in this session. */
  candidate?: AgentCandidate;
}

export interface Draft {
  primary: DraftMember | null;
  backups: DraftMember[];
}

export type DraftRole = { role: "primary" } | { role: "backup"; index: number } | null;

export const memberKey = (m: { agentId: string; capabilityId: string }) => `${m.agentId}|${m.capabilityId}`;
export const slotKey = (client: AgentSource, templateId: string) => `${client}:${templateId}`;

function fromPoolMember(m: PoolMember): DraftMember {
  return {
    agentId: m.agentId,
    capabilityId: m.capabilityId,
    name: m.name,
    provider: m.provider,
    source: m.source,
    approved: m.approved,
    searchId: m.searchId,
    argumentSchema: m.argumentSchema ?? null,
    endpoint: m.endpoint,
  };
}

export function fromCandidate(c: AgentCandidate, saved: AgentPool | null, searchId?: string): DraftMember {
  const prior = saved?.members.find((m) => memberKey(m) === memberKey(c));
  return {
    agentId: c.agentId,
    capabilityId: c.capabilityId,
    name: c.name,
    provider: c.provider,
    source: c.source,
    // An agent already approved in the saved pool keeps its approval.
    approved: prior?.approved ?? false,
    searchId: c.searchId ?? searchId,
    argumentSchema: c.argumentSchema ?? null,
    endpoint: c.endpoint,
    candidate: c,
  };
}

export function draftFromPool(pool: AgentPool | null): Draft {
  if (!pool) return { primary: null, backups: [] };
  const primary = pool.members.find((m) => m.role === "primary") ?? null;
  return {
    primary: primary ? fromPoolMember(primary) : null,
    backups: pool.members.filter((m) => m !== primary).map(fromPoolMember),
  };
}

export function draftMembers(d: Draft): DraftMember[] {
  return d.primary ? [d.primary, ...d.backups] : d.backups;
}

export function sameAsPool(d: Draft, pool: AgentPool | null): boolean {
  const a = draftMembers(d);
  if (!pool) return a.length === 0;
  const primary = pool.members.find((m) => m.role === "primary");
  const b = primary ? [primary, ...pool.members.filter((m) => m !== primary)] : pool.members;
  return a.length === b.length && a.every((m, i) => memberKey(m) === memberKey(b[i]) && m.approved === b[i].approved);
}

export function roleOf(d: Draft, key: string): DraftRole {
  if (d.primary && memberKey(d.primary) === key) return { role: "primary" };
  const index = d.backups.findIndex((m) => memberKey(m) === key);
  return index === -1 ? null : { role: "backup", index };
}

export function removeMember(d: Draft, key: string): Draft {
  return {
    primary: d.primary && memberKey(d.primary) === key ? null : d.primary,
    backups: d.backups.filter((m) => memberKey(m) !== key),
  };
}

/** A backup promoted to primary swaps places with the old primary; a new agent replaces it. */
export function assignPrimary(d: Draft, m: DraftMember): Draft {
  const key = memberKey(m);
  const current = roleOf(d, key);
  if (current?.role === "primary") return d;
  if (current?.role === "backup") {
    const existing = d.backups[current.index];
    const backups = d.backups.slice();
    if (d.primary) backups[current.index] = d.primary;
    else backups.splice(current.index, 1);
    return { primary: existing, backups };
  }
  return { primary: m, backups: d.backups };
}

export function assignBackup(d: Draft, m: DraftMember): Draft {
  const key = memberKey(m);
  const current = roleOf(d, key);
  if (current?.role === "backup") return d;
  const base = current?.role === "primary" ? { ...d, primary: null } : d;
  if (base.backups.length >= MAX_BACKUPS) return d;
  return { primary: base.primary, backups: [...base.backups, current?.role === "primary" && d.primary ? d.primary : m] };
}

/** Moves a member one place towards the front: backup 1 swaps with the primary, backup 2 with backup 1. */
export function moveUp(d: Draft, key: string): Draft {
  const r = roleOf(d, key);
  if (r?.role !== "backup") return d;
  if (r.index === 0) return assignPrimary(d, d.backups[0]);
  const backups = d.backups.slice();
  [backups[r.index - 1], backups[r.index]] = [backups[r.index], backups[r.index - 1]];
  return { ...d, backups };
}

export function setApproved(d: Draft, key: string, approved: boolean): Draft {
  const set = (m: DraftMember) => (memberKey(m) === key ? { ...m, approved } : m);
  return { primary: d.primary ? set(d.primary) : null, backups: d.backups.map(set) };
}

export function toSavePayload(d: Draft): Partial<PoolMember>[] {
  return draftMembers(d).map((m) => ({
    agentId: m.agentId,
    capabilityId: m.capabilityId,
    name: m.name,
    provider: m.provider,
    approved: m.approved,
    searchId: m.searchId,
    argumentSchema: m.argumentSchema ?? null,
    // Direct agents keep their address; Darwin results keep a verified one, used when Act isn't connected.
    ...(m.endpoint ? { endpoint: m.endpoint, source: m.source } : {}),
  }));
}

export function newestPool(a: AgentPool | null | undefined, b: AgentPool | null | undefined): AgentPool | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return b.updatedAt > a.updatedAt ? b : a;
}

export type PoolStatus = "ready" | "partial" | "down" | "none";

export interface PoolHealth {
  status: PoolStatus;
  total: number;
  ready: number;
  unapproved: number;
}

/** `ready` on a member already means approved and healthy, which is what the engine will use. */
export function poolHealth(pool: AgentPool | null): PoolHealth {
  if (!pool || pool.members.length === 0) return { status: "none", total: 0, ready: 0, unapproved: 0 };
  const total = pool.members.length;
  const ready = pool.members.filter((m) => m.ready).length;
  const unapproved = pool.members.filter((m) => !m.approved).length;
  const status: PoolStatus = ready === total ? "ready" : ready === 0 ? "down" : "partial";
  return { status, total, ready, unapproved };
}

export const POOL_STATUS_COLOR: Record<PoolStatus, string> = {
  ready: "var(--s-passed)",
  partial: "var(--s-partial)",
  down: "var(--s-failed)",
  none: "var(--faint)",
};

export const POOL_STATUS_LABEL: Record<PoolStatus, string> = {
  ready: "every member ready",
  partial: "some members not ready",
  down: "no member ready",
  none: "no pool",
};

export interface ReadinessView {
  label: string;
  color: string;
  title: string;
}

/**
 * Plain label for a search result's readiness. Anonymous Darwin searches report "unavailable"
 * for every agent because Darwin only checks routes for authorized callers.
 */
export function readinessView(r: Readiness | string, source: AgentKind): ReadinessView {
  switch (r) {
    case "ready":
      return { label: "Ready", color: "var(--s-passed)", title: "Route checked and ready" };
    case "not_ready":
      return { label: "Not ready", color: "var(--s-failed)", title: "Route reported not ready" };
    case "unverified":
      return { label: "Unverified", color: "var(--s-verifying)", title: "Readiness not confirmed yet" };
    case "unavailable":
      return source === "darwin"
        ? { label: "Unverified", color: "var(--muted)", title: "Darwin reported readiness unavailable: unverified until Darwin Act is authorized" }
        : { label: "Unavailable", color: "var(--muted)", title: "Readiness unavailable" };
    default:
      return { label: String(r || "Unknown").replace(/_/g, " "), color: "var(--muted)", title: String(r) };
  }
}

/** Health of a saved member, as the engine will see it at run time. */
export function memberHealthView(m: PoolMember): ReadinessView {
  if (m.ready) return { label: "Ready", color: "var(--s-passed)", title: m.healthDetail ?? "Ready" };
  if (m.healthStatus === "ready" && !m.approved) return { label: "Not approved", color: "var(--s-failed)", title: "Healthy, but not approved: skipped at run time" };
  if (m.healthStatus === "unverified") return { label: "Unverified", color: "var(--s-verifying)", title: m.healthDetail ?? "Unverified" };
  return { label: "Not ready", color: "var(--s-failed)", title: m.healthDetail ?? "Not ready" };
}

function hasSetup(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true;
}

/** Human steps a Darwin agent needs before it can run unattended, read from what Search reported. */
export function approvalFlags(c: AgentCandidate | undefined): string[] {
  if (!c) return [];
  const text = c.uncertainties.join(" ");
  const flags: string[] = [];
  if (/payment|x402|per-call|pricing|\bpaid\b/i.test(text)) flags.push("payment terms");
  if (/\b(oauth|authenticat\w*|log ?in|sign[- ]?in|api[- ]?key|credentials?)\b/i.test(text)) flags.push("provider sign-in");
  if (hasSetup(c.requiredSetup)) flags.push("setup required");
  return flags;
}

/** Darwin's assessment text arrives as light markdown; the panel shows it as one plain paragraph. */
export function plainNote(note: string | undefined): string {
  if (!note) return "";
  return note
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s*[*-]\s+/gm, "")
    .replace(/\s*\n+\s*/g, " ")
    .trim();
}

/** Short plain step names used across the app ("Crawl", "Accessibility", …). Falls back to the template label. */
const STEP_NAME: Record<Capability, string> = {
  crawl: "Crawl",
  accessibility: "Accessibility",
  performance: "Performance",
  seo: "SEO",
  security: "Security headers",
  links: "Broken links",
};

export function stepName(t: Pick<NodeTemplate, "capability" | "label">): string {
  return (t.capability && STEP_NAME[t.capability]) || t.label;
}

/** An agent's own description without the trailing "Params: …" list. */
export function plainDescription(description: string | undefined): string {
  if (!description) return "";
  return description
    .replace(/\s*\bParams?:[\s\S]*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** First sentence of an agent's own description, without the "Params: …" list. */
export function shortDescription(description: string | undefined): string {
  const text = plainDescription(description);
  return (text.split(/(?<=[.!?])\s+(?=[A-Z(])/)[0] ?? "").trim();
}

/** Match reasons that say more than "this agent does the thing you searched for". */
export function informativeReasons(c: AgentCandidate): string[] {
  const desc = shortDescription(c.description).toLowerCase();
  return c.reasons
    .map((r) => r.trim())
    .filter((r) => r && !/\b(directly )?fulfil+s the request\b/i.test(r) && !(desc && r.toLowerCase().includes(desc)));
}

/** Health detail in plain words; the raw text stays available as a tooltip. */
export function plainHealthDetail(m: PoolMember): string {
  if (!m.approved) return "Not approved, so runs skip it";
  const detail = m.healthDetail ?? "";
  const answered = /answered in (\d+)\s*ms/i.exec(detail);
  if (answered) return `Answered a test request in ${answered[1]} ms`;
  if (/pre-approved default/i.test(detail)) return "Included in the default setup";
  if (m.ready) return detail || "Ready";
  if (m.healthStatus === "unverified") return "Readiness not confirmed yet";
  if (/unavailable|\b5\d\d\b|unreachable/i.test(detail)) return "Not answering right now";
  return detail || "Not ready";
}
