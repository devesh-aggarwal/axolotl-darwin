// Rankings from real MCP calls: what gets scored, the note kept with every result, the agent panel's
// breakdown, and that nothing simulated reaches the boards. No network.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Before any project import: env.ts reads this at load time.
process.env.AXOLOTL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "axolotl-agent-results-test-"));

import type { Attempt } from "@/lib/mcp/failover";

const checks: { name: string; pass: boolean; detail?: string }[] = [];
const expect = (name: string, pass: boolean, detail?: string) => checks.push({ name, pass, detail });

const at = (a: Partial<Attempt> & Pick<Attempt, "step" | "agent" | "outcome">): Attempt => ({ source: "public-api", reason: "", ms: 120, ...a });

async function main() {
  const { scoreAddressAttempts, scoreDeliveryRoute } = await import("@/lib/mcp/scoring");
  const { getAllStats, getResults, recordAttemptOutcome, resetStats } = await import("@/lib/engine/stats");
  const { breakdownResults, notePattern } = await import("@/lib/engine/resultBreakdown");
  const { buildBoards, sourceLabel } = await import("@/components/evolution/leaderboard");
  const { failover } = await import("@/lib/mcp/failover");
  const stat = (name: string) => getAllStats().find((s) => s.name === name);

  // failover's describe hook: a passing answer says what it found.
  const f = await failover("resolve address", [{ name: "Map", source: "public-api", run: async () => ["1 Main St"] }], () => null, { describe: (v) => `found ${v[0]}` });
  expect("a passing attempt says what it found", f.attempts[0].reason === "found 1 Main St", f.attempts[0].reason);

  // A real lookup trace: saved place, Photon caught out, Nominatim finds it.
  scoreAddressAttempts([
    at({ step: "resolve address", agent: "Your saved places", outcome: "ok", ms: 0 }),
    at({ step: "locate saved address", agent: "Photon geocoder (komoot, OpenStreetMap)", outcome: "rejected", reason: '"A162 - DHL Express" has no house number' }),
    at({ step: "locate saved address", agent: "OpenStreetMap Nominatim", outcome: "ok", reason: "found 1025 Sansome Street, San Francisco, CA 94111" }),
    at({ step: "build cart", agent: "DoorDash agent", source: "simulated", outcome: "ok" }),
  ]);
  const photon = stat("Photon geocoder");
  const nominatim = stat("OpenStreetMap Nominatim");
  expect("map services are scored", photon?.attempts === 1 && nominatim?.successes === 1, JSON.stringify(getAllStats().map((s) => s.name)));
  expect("saved places and simulated platforms are not", !stat("Your saved places") && !getAllStats().some((s) => s.name.includes("DoorDash")));
  expect("a pass keeps what it found", getResults(nominatim!.agentId, "address")[0]?.note === "found 1025 Sansome Street, San Francisco, CA 94111");
  expect("a failure keeps why", getResults(photon!.agentId, "address")[0]?.note.includes("no house number") === true);

  // Delivery routes keep the cart check's verdict.
  scoreDeliveryRoute("uber-eats-search-browser", false, "cart delivers to 1 Hacker Way, not the resolved address");
  scoreDeliveryRoute("uber-eats-search-browser", true, "right item, delivering to 685 Escondido Road, $15.99");
  const route = getAllStats().find((s) => s.capability === "delivery")!;
  const routeResults = getResults(route.agentId, "delivery");
  expect("a delivery route keeps each verdict", routeResults.length === 2 && routeResults[0].success && !routeResults[1].success, JSON.stringify(routeResults));

  // The panel's breakdown.
  scoreAddressAttempts([
    at({ step: "resolve address", agent: "Photon geocoder (komoot, OpenStreetMap)", outcome: "rejected", reason: '"Castro St 12" has no house number' }),
    at({ step: "resolve address", agent: "Photon geocoder (komoot, OpenStreetMap)", outcome: "failed", reason: "timed out after 12s" }),
    at({ step: "resolve address", agent: "Photon geocoder (komoot, OpenStreetMap)", outcome: "ok", reason: "found 685 Escondido Road, Stanford, CA 94305" }),
  ]);
  const p = stat("Photon geocoder")!;
  const bd = breakdownResults(p.attempts, getResults(p.agentId, "address"));
  expect("wins list the passing answers, newest first", bd.wins.recorded === 1 && bd.wins.recent[0].note.startsWith("found 685"), JSON.stringify(bd.wins));
  expect("most common failure type comes first", bd.losses.groups[0].failureType === "verification" && bd.losses.groups[0].count === 2, JSON.stringify(bd.losses));
  expect("same-shape failures group with a count", bd.losses.groups[0].patterns[0].count === 2 && bd.losses.groups[0].patterns[0].example.includes("Castro"));
  expect("names and numbers fold out of a note", notePattern('"A162" has no house number') === notePattern('"B 7" has no house number'));
  expect("every result is accounted for", bd.unrecorded === 0 && bd.wins.recorded + bd.losses.recorded === p.attempts);
  expect("results from before notes are counted, not invented", breakdownResults(p.attempts + 3, getResults(p.agentId, "address")).unrecorded === 3);

  // Simulated agents are ranked, labelled Simulated; Axolotl's own test agents stay off.
  recordAttemptOutcome({ agent: { agentId: "mock:crawl:a", capabilityId: "x", name: "Sim crawler", source: "mock" }, capability: "crawl", success: true, latencyMs: 5 });
  const stats = getAllStats().map((s) => (s.agentId === "map:openstreetmap-nominatim" ? { ...s, testAgent: true } : s));
  const shown = buildBoards(stats, []).flatMap((b) => b.rows.map((r) => r.name));
  expect("simulated agents appear on the boards", shown.includes("Sim crawler"), shown.join(", "));
  const sim = buildBoards(stats, []).flatMap((b) => b.rows).find((r) => r.name === "Sim crawler");
  expect("and say they are simulated", Boolean(sim) && sourceLabel(sim!) === "Simulated");
  expect("Axolotl's own test agents never appear either", !shown.includes("OpenStreetMap Nominatim"), shown.join(", "));
  expect("real agents do", shown.includes("Photon geocoder"), shown.join(", "));

  // Snapshot round trip: saved rankings fill a new, empty database exactly.
  const { saveRankings, loadRankings } = await import("@/lib/engine/rankingsSnapshot");
  const { getDb } = await import("@/lib/db");
  const Database = (await import("better-sqlite3")).default;
  const snapFile = path.join(process.env.AXOLOTL_DATA_DIR!, "rankings.json");
  const saved = saveRankings(getDb(), snapFile);
  const copy = new Database(":memory:");
  copy.exec(fs.readFileSync("src/lib/db.ts", "utf8").split("const SCHEMA = `")[1].split("`;")[0]);
  loadRankings(copy, snapFile);
  const count = (t: string) => (copy.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n;
  expect("snapshot restores every agent and result", count("agent_stats") === saved.agents && count("agent_results") === saved.results && saved.results > 0);
  loadRankings(copy, snapFile);
  expect("snapshot never loads twice", count("agent_stats") === saved.agents);

  resetStats();
  expect("reset clears scores and notes", getAllStats().length === 0 && getResults(p.agentId, "address").length === 0);
}

main()
  .catch((err) => checks.push({ name: "uncaught", pass: false, detail: String((err as Error)?.stack ?? err) }))
  .finally(() => {
    const failed = checks.filter((c) => !c.pass);
    for (const c of checks) console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}${c.detail && !c.pass ? `  (${c.detail})` : ""}`);
    console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
    process.exit(failed.length ? 1 : 0);
  });
