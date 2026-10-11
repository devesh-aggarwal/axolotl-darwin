// Rankings snapshot: scores, score history and result notes saved to data/rankings.json, which is
// committed, so a fresh clone (or a deleted axolotl.db) starts with the team's rankings instead of
// empty boards. Saved on demand with `npm run rankings:save`; loaded only into a newly created database.
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";

type Row = Record<string, string | number | null>;

interface Snapshot {
  savedAt: number;
  agent_stats: Row[];
  agent_score_history: Row[];
  agent_results: Row[];
}

const TABLES = ["agent_stats", "agent_score_history", "agent_results"] as const;

export function snapshotPath(dataDir: string): string {
  return path.join(dataDir, "rankings.json");
}

export function saveRankings(db: Database.Database, file: string): { agents: number; results: number } {
  const snap: Snapshot = {
    savedAt: Date.now(),
    agent_stats: db.prepare(`SELECT * FROM agent_stats ORDER BY agent_id, capability`).all() as Row[],
    // Ids are local row numbers; order is all that matters, and a fresh database assigns new ones.
    agent_score_history: (db.prepare(`SELECT * FROM agent_score_history ORDER BY id`).all() as Row[]).map(({ id: _, ...r }) => r),
    agent_results: (db.prepare(`SELECT * FROM agent_results ORDER BY id`).all() as Row[]).map(({ id: _, ...r }) => r),
  };
  fs.writeFileSync(file, JSON.stringify(snap, null, 1) + "\n");
  return { agents: snap.agent_stats.length, results: snap.agent_results.length };
}

/** Fills empty ranking tables from the snapshot, if there is one. */
export function loadRankings(db: Database.Database, file: string): void {
  if (!fs.existsSync(file)) return;
  const empty = TABLES.every((t) => (db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n === 0);
  if (!empty) return;
  let snap: Snapshot;
  try {
    snap = JSON.parse(fs.readFileSync(file, "utf8")) as Snapshot;
  } catch {
    return; // A broken snapshot just means empty boards, never a database that won't open.
  }
  db.transaction(() => {
    for (const t of TABLES) {
      for (const r of snap[t] ?? []) {
        const cols = Object.keys(r);
        db.prepare(`INSERT INTO ${t} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...cols.map((c) => r[c]));
      }
    }
  })();
}
