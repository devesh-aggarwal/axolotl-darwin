// Makes exactly ONE real OpenAI call through the guarded gateway to confirm the request shape works.
// Costs a few dozen tokens. Usage counters are printed before and after.
//   npx tsx --tsconfig tsconfig.json --env-file=.env scripts/llm-smoke.ts
async function main() {
  const { callLlmJson, getLlmUsage } = await import("@/lib/llm/gateway");
  console.log("before:", summary(getLlmUsage()));
  const res = await callLlmJson<{ ok: boolean; word: string }>({
    purpose: "test",
    system: "You are a connectivity check. Answer with the JSON requested and nothing else.",
    user: 'Return {"ok": true, "word": "axolotl"}.',
    schemaName: "smoke",
    schema: {
      type: "object",
      properties: { ok: { type: "boolean" }, word: { type: "string" } },
      required: ["ok", "word"],
      additionalProperties: false,
    },
    maxOutputTokens: 60,
    cache: false,
  });
  console.log("result:", res.data, "cached:", res.cached, "usage:", res.usage);
  console.log("after:", summary(getLlmUsage()));
}

function summary(u: { model: string; keyPresent: boolean; processCalls: number; dayCalls: number; limits: unknown }) {
  return { model: u.model, keyPresent: u.keyPresent, processCalls: u.processCalls, dayCalls: u.dayCalls, limits: u.limits };
}

main().catch((err) => {
  console.error("smoke failed:", (err as Error).message);
  process.exit(1);
});
