// Run persistence. SqliteStore checkpoints every node and attempt so a crashed run can
// resume from its last good node; NullStore is used by the in-memory time-lapse.
import { getDb, json } from "@/lib/db";
import type { AttemptView, NodeView, RunStats, RunStatus, RunSummary } from "@/lib/types";

export interface RunRecord {
  run: RunSummary;
  nodes: NodeView[];
  attempts: AttemptView[];
}

export interface RunStore {
  createRun(run: RunSummary): void;
  updateRun(run: RunSummary): void;
  upsertNode(node: NodeView): void;
  /** Drops a node that no longer exists (a fan-out placeholder replaced by its instances). */
  deleteNode(nodeId: string): void;
  upsertAttempt(attempt: AttemptView): void;
  loadRun(runId: string): RunRecord | null;
}

export class NullStore implements RunStore {
  createRun(): void {}
  updateRun(): void {}
  upsertNode(): void {}
  deleteNode(): void {}
  upsertAttempt(): void {}
  loadRun(): RunRecord | null {
    return null;
  }
}

/** failureDetail prefix of attempts cut off because the run itself stopped, not because the agent failed. */
export const INTERRUPTED_PREFIX = "Interrupted:";

export function isInterruptedAttempt(a: AttemptView): boolean {
  return a.outcome === "hard_failure" && a.failureType === "killed" && Boolean(a.failureDetail?.startsWith(INTERRUPTED_PREFIX));
}

/** Closes an attempt that was still in flight when its run stopped. Never counts against the agent. */
export function markInterrupted(a: AttemptView, status: RunStatus, at = Date.now()): void {
  const why = status === "cancelled" ? "the run was cancelled" : status === "crashed" ? "the run crashed" : "the run stopped";
  a.outcome = "hard_failure";
  a.failureType = "killed";
  a.failureDetail = `${INTERRUPTED_PREFIX} ${why} while this attempt was in flight`;
  a.finishedAt = at;
  a.latencyMs = at - a.startedAt;
}

const ACTIVE_NODE_STATES = new Set<NodeView["state"]>(["idle", "queued", "running", "verifying", "swapping"]);

/** A run that is not running cannot have nodes or attempts in flight (e.g. the process died mid-run). */
function closeStoppedRecord(rec: RunRecord): RunRecord {
  if (rec.run.status === "running") return rec;
  const at = rec.run.finishedAt ?? Date.now();
  for (const n of rec.nodes) if (ACTIVE_NODE_STATES.has(n.state)) n.state = "cancelled";
  for (const a of rec.attempts) {
    if (a.outcome === "running" || a.outcome === "verifying") markInterrupted(a, rec.run.status, at);
  }
  return rec;
}

/** Node views travel over SSE; outputs can be large, so they are stored separately. */
export function stripNode(node: NodeView): NodeView {
  if (node.output === undefined) return node;
  const { output: _output, ...rest } = node;
  return rest;
}

export class SqliteStore implements RunStore {
  createRun(run: RunSummary): void {
    getDb()
      .prepare(
        `INSERT OR REPLACE INTO runs (id, status, config_json, stats_json, created_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(run.id, run.status, JSON.stringify(run.config), run.stats ? JSON.stringify(run.stats) : null, run.createdAt, run.finishedAt ?? null);
  }

  updateRun(run: RunSummary): void {
    getDb()
      .prepare(`UPDATE runs SET status = ?, stats_json = ?, finished_at = ? WHERE id = ?`)
      .run(run.status, run.stats ? JSON.stringify(run.stats) : null, run.finishedAt ?? null, run.id);
  }

  upsertNode(node: NodeView): void {
    const output = node.output === undefined ? null : JSON.stringify(node.output);
    getDb()
      .prepare(
        `INSERT INTO node_instances (id, run_id, template_id, view_json, state, output_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET view_json = excluded.view_json, state = excluded.state,
           output_json = COALESCE(excluded.output_json, node_instances.output_json), updated_at = excluded.updated_at`,
      )
      .run(node.id, node.runId, node.templateId, JSON.stringify(stripNode(node)), node.state, output, Date.now());
  }

  deleteNode(nodeId: string): void {
    getDb().prepare(`DELETE FROM node_instances WHERE id = ?`).run(nodeId);
  }

  upsertAttempt(a: AttemptView): void {
    getDb()
      .prepare(
        `INSERT INTO attempts (id, run_id, node_id, agent_id, attempt_no, view_json, outcome, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET view_json = excluded.view_json, outcome = excluded.outcome, finished_at = excluded.finished_at`,
      )
      .run(a.id, a.runId, a.nodeId, a.agent.agentId, a.attemptNo, JSON.stringify(a), a.outcome, a.startedAt, a.finishedAt ?? null);
  }

  loadRun(runId: string): RunRecord | null {
    const db = getDb();
    const row = db.prepare(`SELECT * FROM runs WHERE id = ?`).get(runId) as RunRow | undefined;
    if (!row) return null;
    const nodes = (db.prepare(`SELECT view_json, output_json FROM node_instances WHERE run_id = ?`).all(runId) as NodeRow[]).map(
      (n) => {
        const view = json<NodeView>(n.view_json, {} as NodeView);
        if (n.output_json) view.output = json<unknown>(n.output_json, undefined);
        return view;
      },
    );
    const attempts = (
      db.prepare(`SELECT view_json FROM attempts WHERE run_id = ? ORDER BY started_at, attempt_no`).all(runId) as { view_json: string }[]
    ).map((a) => json<AttemptView>(a.view_json, {} as AttemptView));
    return closeStoppedRecord({ run: rowToRun(row), nodes, attempts });
  }
}

interface RunRow {
  id: string;
  status: string;
  config_json: string;
  stats_json: string | null;
  created_at: number;
  finished_at: number | null;
}
interface NodeRow {
  view_json: string;
  output_json: string | null;
}

function rowToRun(row: RunRow): RunSummary {
  return {
    id: row.id,
    status: row.status as RunStatus,
    config: JSON.parse(row.config_json),
    createdAt: row.created_at,
    finishedAt: row.finished_at ?? undefined,
    stats: row.stats_json ? (JSON.parse(row.stats_json) as RunStats) : undefined,
  };
}

export function listRuns(limit = 20): RunSummary[] {
  const rows = getDb().prepare(`SELECT * FROM runs ORDER BY created_at DESC LIMIT ?`).all(limit) as RunRow[];
  return rows.map(rowToRun);
}

export function loadNodeOutput(nodeId: string): unknown {
  const row = getDb().prepare(`SELECT output_json FROM node_instances WHERE id = ?`).get(nodeId) as { output_json: string | null } | undefined;
  return row?.output_json ? json<unknown>(row.output_json, null) : null;
}

/** Runs left "running" by a process that died are crashed; they can be resumed. */
export function markOrphanedRunsCrashed(): number {
  const res = getDb().prepare(`UPDATE runs SET status = 'crashed' WHERE status = 'running'`).run();
  return res.changes;
}
