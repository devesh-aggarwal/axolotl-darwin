// Saves the rankings to data/rankings.json so they can be committed. Asks the running dev server to
// write it (the server owns the database); with no server running, reads the database directly.
// Usage: npm run rankings:save [-- http://localhost:3000]
const base = process.argv[2] ?? "http://localhost:3000";

async function saveRankingsCli() {
  try {
    const res = await fetch(`${base}/api/stats/snapshot`, { method: "POST" });
    const body = (await res.json()) as { agents?: number; results?: number; data?: { agents: number; results: number } };
    if (!res.ok) throw new Error(`server answered ${res.status}`);
    const r = body.data ?? body;
    console.log(`Saved ${r.agents} agent scores and ${r.results} results to data/rankings.json (via ${base}).`);
    return;
  } catch (err) {
    if (!/fetch failed|ECONNREFUSED/i.test(String((err as Error).cause ?? err))) throw err;
  }
  const path = await import("node:path");
  const { getDb } = await import("@/lib/db");
  const { env } = await import("@/lib/env");
  const { saveRankings, snapshotPath } = await import("@/lib/engine/rankingsSnapshot");
  const r = saveRankings(getDb(), snapshotPath(path.resolve(process.cwd(), env.dataDir)));
  console.log(`Saved ${r.agents} agent scores and ${r.results} results to data/rankings.json (server not running; read the database directly).`);
}

saveRankingsCli().catch((err) => {
  console.error(`Couldn't save rankings: ${(err as Error).message}`);
  process.exit(1);
});
