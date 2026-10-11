// Runs simulated nights headlessly (no server, no LLM, no Darwin) and prints how often each side
// finishes, plus a breakdown of failure types. Used to tune chaos rates and mock agent profiles.
//   npx tsx --tsconfig tsconfig.json scripts/calibrate-timelapse.ts [runs] [chaosRate] [timeScale] [maxPages]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AXOLOTL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "axolotl-calib-"));
process.env.OPENAI_API_KEY = ""; // never call the LLM from here

async function main() {
  const runs = Number(process.argv[2] ?? 30);
  const chaosRate = Number(process.argv[3] ?? 0.1);
  const timeScale = Number(process.argv[4] ?? 0.03);
  const maxPages = Number(process.argv[5] ?? 3);

  const { startDemoServer } = await import("./serve-demo-site");
  const { RunEngine } = await import("@/lib/engine/engine");
  const { NullStore } = await import("@/lib/engine/store");
  const { MockDarwinClient } = await import("@/lib/darwin/mock");
  const { DEFAULT_CHAOS } = await import("@/lib/engine/runtime");

  const server = await startDemoServer(0);
  const siteUrl = `${server.origin}/demo-site/`;
  const client = new MockDarwinClient();
  const tally = {
    with: { completed: 0, corrupt: 0, failures: {} as Record<string, number>, lost: 0, recoveries: 0 },
    without: { completed: 0, corrupt: 0, failures: {} as Record<string, number>, lost: 0, recoveries: 0 },
  };
  const t0 = Date.now();
  for (let i = 0; i < runs; i++) {
    const mk = (baseline: boolean) =>
      new RunEngine(
        {
          id: `calib_${baseline ? "b" : "a"}_${i}`,
          status: "running",
          createdAt: Date.now(),
          config: {
            siteUrl,
            maxPages,
            client: "mock",
            simulatedBackups: false,
            budgetCents: 0,
            chaos: { enabled: chaosRate > 0, rate: chaosRate, weights: { ...DEFAULT_CHAOS.weights } },
            llmMode: "mock",
            seed: 1000 + i * 7919,
            timeScale,
            concurrency: 12,
            baseline,
            persist: false,
            recordStats: !baseline,
          },
        },
        { client, store: new NullStore(), publish: () => undefined },
      );
    const eb = mk(true);
    const ea = mk(false);
    const [b, a] = await Promise.all([eb.execute(), ea.execute()]);
    for (const [side, run, engine] of [
      ["without", b, eb],
      ["with", a, ea],
    ] as const) {
      const t = tally[side];
      const corrupt = Boolean(run.stats?.acceptedCorruptOutput);
      if (run.status === "completed" && !corrupt) t.completed++;
      if (corrupt) t.corrupt++;
      t.lost += run.stats?.failedBranches ?? 0;
      t.recoveries += run.stats?.recoveries ?? 0;
      for (const at of engine.attempts) if (at.failureType) t.failures[at.failureType] = (t.failures[at.failureType] ?? 0) + 1;
    }
    process.stdout.write(".");
  }
  await server.close();
  console.log(`\n${runs} nights, ${maxPages} pages, chaos ${chaosRate}, timeScale ${timeScale}, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  for (const side of ["without", "with"] as const) {
    const t = tally[side];
    console.log(
      `${side.padEnd(8)} usable ${t.completed}/${runs}  corrupt-accepted ${t.corrupt}  branches lost ${t.lost}  recoveries ${t.recoveries}  failures ${JSON.stringify(t.failures)}`,
    );
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
