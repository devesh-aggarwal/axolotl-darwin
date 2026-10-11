// Durable state in SQLite (spec section 7.1): runs, node instances, attempts, agent stats,
// trust checks, pools, LLM cache. Synchronous better-sqlite3; one connection per process.
import Database from "better-sqlite3";
import { loadRankings, snapshotPath } from "@/lib/engine/rankingsSnapshot";
import fs from "node:fs";
import path from "node:path";
import { env } from "@/lib/env";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  config_json TEXT NOT NULL,
  stats_json TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);

CREATE TABLE IF NOT EXISTS node_instances (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  template_id TEXT NOT NULL,
  view_json TEXT NOT NULL,
  state TEXT NOT NULL,
  output_json TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nodes_run ON node_instances(run_id);

CREATE TABLE IF NOT EXISTS attempts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  attempt_no INTEGER NOT NULL,
  view_json TEXT NOT NULL,
  outcome TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_attempts_node ON attempts(node_id);
CREATE INDEX IF NOT EXISTS idx_attempts_run ON attempts(run_id);

CREATE TABLE IF NOT EXISTS agent_stats (
  agent_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  name TEXT NOT NULL,
  source TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  successes INTEGER NOT NULL DEFAULT 0,
  failures_json TEXT NOT NULL DEFAULT '{}',
  total_latency_ms INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (agent_id, capability)
);

CREATE TABLE IF NOT EXISTS agent_score_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  score REAL NOT NULL,
  attempts INTEGER NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_history_agent ON agent_score_history(agent_id, capability, id);

-- Every scored attempt with a one-line note (what it got right, or why it failed), for the agent panel on Rankings.
CREATE TABLE IF NOT EXISTS agent_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  success INTEGER NOT NULL,
  failure_type TEXT,
  note TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_results_agent ON agent_results(agent_id, capability, id);

-- Trust checks (src/lib/trust): the listing an agent was found with, its trials, and what it did in runs.
CREATE TABLE IF NOT EXISTS agent_listings (
  agent_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  listing_json TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (agent_id, capability)
);

CREATE TABLE IF NOT EXISTS agent_trials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  result_json TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trials_agent ON agent_trials(agent_id, capability, id);

CREATE TABLE IF NOT EXISTS agent_incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL,
  run_id TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_incidents_agent ON agent_incidents(agent_id, capability);

CREATE TABLE IF NOT EXISTS pools (
  template_id TEXT NOT NULL,
  client TEXT NOT NULL,
  pool_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (template_id, client)
);

CREATE TABLE IF NOT EXISTS llm_cache (
  hash TEXT PRIMARY KEY,
  purpose TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS adapter_cache (
  agent_id TEXT NOT NULL,
  template_id TEXT NOT NULL,
  mapping_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (agent_id, template_id)
);
`;

const g = globalThis as unknown as { __axolotlDb?: Database.Database };

export function getDb(): Database.Database {
  if (g.__axolotlDb) return g.__axolotlDb;
  const dir = path.resolve(process.cwd(), env.dataDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "axolotl.db");
  const fresh = !fs.existsSync(file);
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = NORMAL");
  db.exec(SCHEMA);
  // A new database starts from the committed rankings; an existing one (even after Reset) is left alone.
  if (fresh) loadRankings(db, snapshotPath(dir));
  g.__axolotlDb = db;
  return db;
}

export function json<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}
