// Pre-approved backup pools (spec section 4): chosen and approved during setup, health-checked,
// then walked in reliability order during unattended runs. No new searches or approvals mid-run.
import { productMode } from "@/config/mode";
import { AGENT_TEMPLATES, getTemplate } from "@/config/workflow";
import { getDb, json } from "@/lib/db";
import { defaultMockPool } from "@/lib/darwin/mockCatalog";
import { getDarwinClient } from "@/lib/engine/clients";
import { shouldPromote } from "@/lib/engine/promotion";
import { getStatsMap } from "@/lib/engine/stats";
import { publish } from "@/lib/events";
import type { AgentPool, AgentSource, AgentStats, Capability, PoolMember } from "@/lib/types";

/** Backups older than this are considered stale and are rechecked before use. */
export const HEALTH_STALE_MS = 15 * 60_000;

/** Pools are stored per product mode, so Option A and Option B setups don't overwrite each other. */
function storeKey(client: AgentSource): string {
  return productMode() === "your-agent" ? `${client}:your-agent` : client;
}

function defaultPool(templateId: string): AgentPool {
  const t = getTemplate(templateId);
  const capability = t.capability as Capability;
  const { primary, backups } = defaultMockPool(capability, productMode());
  const now = Date.now();
  const toMember = (p: typeof primary, role: PoolMember["role"]): PoolMember => ({
    agentId: p.agentId,
    capabilityId: p.capabilityId,
    name: p.name,
    provider: p.provider,
    source: "mock",
    role,
    approved: true,
    ready: p.healthy,
    healthStatus: p.healthy ? "ready" : "not_ready",
    lastHealthCheck: now,
    healthDetail: p.healthy ? "Pre-approved default pool" : "Provider route unavailable",
  });
  return {
    templateId,
    capability,
    client: "mock",
    members: [toMember(primary, "primary"), ...backups.map((b) => toMember(b, "backup"))],
    updatedAt: now,
  };
}

export function getPool(templateId: string, client: AgentSource): AgentPool | null {
  const row = getDb().prepare(`SELECT pool_json FROM pools WHERE template_id = ? AND client = ?`).get(templateId, storeKey(client)) as
    | { pool_json: string }
    | undefined;
  if (row) return json<AgentPool | null>(row.pool_json, null);
  if (client === "mock") {
    const pool = defaultPool(templateId);
    savePool(pool);
    return pool;
  }
  return null;
}

export function getAllPools(client: AgentSource): AgentPool[] {
  return AGENT_TEMPLATES.map((t) => getPool(t.id, client)).filter((p): p is AgentPool => Boolean(p));
}

export function savePool(pool: AgentPool): void {
  pool.updatedAt = Date.now();
  getDb()
    .prepare(
      `INSERT INTO pools (template_id, client, pool_json, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(template_id, client) DO UPDATE SET pool_json = excluded.pool_json, updated_at = excluded.updated_at`,
    )
    .run(pool.templateId, storeKey(pool.client), JSON.stringify(pool), pool.updatedAt);
  publish({ type: "pool_updated", templateId: pool.templateId });
}

export function resetPools(client?: AgentSource): void {
  if (client) getDb().prepare(`DELETE FROM pools WHERE client = ?`).run(storeKey(client));
  else getDb().prepare(`DELETE FROM pools WHERE client IN (?, ?)`).run(storeKey("mock"), storeKey("darwin"));
  publish({ type: "pool_updated", templateId: "*" });
}

export async function healthCheckPool(pool: AgentPool, onlyStale = false): Promise<AgentPool> {
  const now = Date.now();
  await Promise.all(
    pool.members.map(async (m) => {
      if (onlyStale && m.lastHealthCheck && now - m.lastHealthCheck < HEALTH_STALE_MS) return;
      // Each member is checked by the client that will run it (a Darwin pool can hold direct agents).
      const h = await getDarwinClient(m.source).healthCheck(m);
      m.healthStatus = h.status;
      m.ready = h.ready && m.approved;
      m.lastHealthCheck = h.checkedAt;
      m.healthDetail = h.detail;
    }),
  );
  savePool(pool);
  return pool;
}

export interface OrderedPool {
  members: PoolMember[];
  skipped: { member: PoolMember; reason: string }[];
  promoted?: { member: PoolMember; over: PoolMember; score: number; overScore: number };
  /** A less-tested backup moved up this time, so an early lucky streak doesn't fix the order forever. */
  explored?: PoolMember;
  /** Why each member is where it is, by agentId ("Next most reliable backup: 94% verified over 31 runs"). */
  reasons: Map<string, string>;
}

/** Chance per step that a less-tested backup is tried before the most reliable one. */
export const EXPLORE_RATE = 0.1;
/** Backups with fewer attempts than this still count as less tested. */
const EXPLORE_MAX_ATTEMPTS = 5;

function trackRecord(s: AgentStats | undefined): string {
  if (!s || s.attempts === 0) return "no track record yet";
  return `${Math.round(s.score * 100)}% verified over ${s.attempts} run${s.attempts === 1 ? "" : "s"}`;
}

/**
 * Order for an unattended run: primary first, then ready backups by reliability score
 * (latency as tiebreak). A backup that has clearly out-performed the primary is promoted.
 */
export function orderPool(
  pool: AgentPool,
  capability: Capability,
  stats: Map<string, AgentStats> = getStatsMap(),
  /** Seeded random source; when given, a less-tested backup is sometimes tried first (EXPLORE_RATE). */
  rand?: () => number,
): OrderedPool {
  const skipped: OrderedPool["skipped"] = [];
  const usable: PoolMember[] = [];
  for (const m of pool.members) {
    if (!m.approved) skipped.push({ member: m, reason: "not approved during setup" });
    else if (!m.ready) skipped.push({ member: m, reason: `not ready (${m.healthDetail ?? m.healthStatus})` });
    else usable.push(m);
  }
  const st = (m: PoolMember) => stats.get(`${m.agentId}|${capability}`);
  const score = (m: PoolMember) => st(m)?.score ?? 0.5;
  const latency = (m: PoolMember) => st(m)?.avgLatencyMs || Number.MAX_SAFE_INTEGER;
  const byReliability = (a: PoolMember, b: PoolMember) => score(b) - score(a) || latency(a) - latency(b);

  const primary = usable.find((m) => m.role === "primary");
  const backups = usable.filter((m) => m !== primary).sort(byReliability);
  let ordered = primary ? [primary, ...backups] : backups;
  let promoted: OrderedPool["promoted"];

  if (primary && backups[0]) {
    const best = backups[0];
    const p = st(primary);
    const b = st(best);
    if (shouldPromote(p && { score: p.score, attempts: p.attempts }, b && { score: b.score, attempts: b.attempts })) {
      ordered = [best, primary, ...backups.slice(1)];
      promoted = { member: best, over: primary, score: score(best), overScore: score(primary) };
    }
  }

  let explored: PoolMember | undefined;
  const attemptsOf = (m: PoolMember) => st(m)?.attempts ?? 0;
  const firstBackup = ordered[1];
  if (rand && firstBackup && rand() < EXPLORE_RATE) {
    const fresh = ordered.slice(2).filter((m) => attemptsOf(m) < EXPLORE_MAX_ATTEMPTS && attemptsOf(m) < attemptsOf(firstBackup));
    if (fresh.length) {
      explored = fresh[Math.floor(rand() * fresh.length)];
      ordered = [ordered[0], explored, ...ordered.slice(1).filter((m) => m !== explored)];
    }
  }

  const reasons = new Map<string, string>();
  ordered.forEach((m, i) => {
    const record = trackRecord(st(m));
    if (promoted && m === promoted.member) reasons.set(m.agentId, `Promoted over ${promoted.over.name}: ${record}, vs ${trackRecord(st(promoted.over))}`);
    else if (m === explored) reasons.set(m.agentId, `Less-tested backup, tried early so the rankings stay fair (${record})`);
    else if (m.role === "primary" && promoted) reasons.set(m.agentId, `Approved first choice, tried after the promoted backup (${record})`);
    else if (i === 0 || m.role === "primary") reasons.set(m.agentId, `Approved as the first choice (${record})`);
    else reasons.set(m.agentId, `Next most reliable backup (${record})`);
  });
  return { members: ordered, skipped, promoted, explored, reasons };
}

/**
 * Order across tiers: every usable member of the first pool (real agents) before any of the next
 * (simulated backups). Promotion happens within a tier, so a simulated agent never jumps a real one.
 */
export function orderPools(
  pools: AgentPool[],
  capability: Capability,
  stats: Map<string, AgentStats> = getStatsMap(),
  rand?: () => number,
): OrderedPool {
  const seen = new Set<string>();
  const out: OrderedPool = { members: [], skipped: [], reasons: new Map() };
  pools.forEach((pool, tier) => {
    const ordered = orderPool(pool, capability, stats, tier === 0 ? rand : undefined);
    for (const m of ordered.members) {
      if (seen.has(m.agentId)) continue;
      seen.add(m.agentId);
      out.members.push(m);
      const why = ordered.reasons.get(m.agentId) ?? "";
      out.reasons.set(m.agentId, tier === 0 ? why : `Simulated backup, used only after every real agent (${trackRecord(stats.get(`${m.agentId}|${capability}`))})`);
    }
    out.skipped.push(...ordered.skipped);
    if (tier === 0) {
      out.promoted = ordered.promoted;
      out.explored = ordered.explored;
    }
  });
  return out;
}

/** Background recheck of every pool's backups (spec 7.6). Started once per process. */
export function startHealthScheduler(intervalMs = 5 * 60_000): void {
  const g = globalThis as unknown as { __axolotlHealthTimer?: NodeJS.Timeout };
  if (g.__axolotlHealthTimer) return;
  g.__axolotlHealthTimer = setInterval(() => {
    for (const pool of getAllPools("mock")) void healthCheckPool(pool, true).catch(() => undefined);
  }, intervalMs);
  g.__axolotlHealthTimer.unref?.();
}
