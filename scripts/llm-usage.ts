// Prints the LLM gateway's usage and limits. Makes no LLM calls and never prints the key.
// Run: npx tsx --tsconfig tsconfig.json scripts/llm-usage.ts
import fs from "node:fs";
import path from "node:path";

async function main(): Promise<void> {
  // Load .env (if present) before env.ts is imported, so keyPresent and limits match the app.
  const envFile = path.resolve(process.cwd(), ".env");
  if (fs.existsSync(envFile) && typeof process.loadEnvFile === "function") {
    try {
      process.loadEnvFile(envFile);
    } catch {
      console.warn("Could not parse .env; showing defaults.");
    }
  }
  const { getLlmUsage } = await import("@/lib/llm/gateway");
  const { env } = await import("@/lib/env");
  const usage = getLlmUsage();
  console.log(JSON.stringify(usage, null, 2));
  console.log(`\nPer-day counter file: ${path.resolve(process.cwd(), env.dataDir, "llm-usage.json")}`);
  console.log(
    `Today (${usage.day}): ${usage.dayCalls}/${usage.limits.perDay} calls, ${usage.dayInputTokens} input + ${usage.dayOutputTokens} output tokens.`,
  );
  console.log("Process counters reset when the server restarts; this script runs in its own process, so they read 0 here.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
