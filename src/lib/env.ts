// Server-side configuration. Secrets are read from process.env (Next loads .env; scripts use --env-file) and never logged.

function num(name: string, fallback: number): number {
  const v = process.env[name];
  const n = v === undefined || v === "" ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export const env = {
  /** Default Darwin client for new runs: "mock" | "real". */
  defaultClient: (process.env.AXOLOTL_CLIENT === "real" ? "real" : "mock") as "mock" | "real",
  darwinApiBase: process.env.DARWIN_API_BASE_URL || "https://api.darwin.so/api",
  /** Darwin user OAuth access token with `human:actions` (Act). Optional. */
  darwinAccessToken: process.env.DARWIN_ACCESS_TOKEN || "",
  /** Darwin application API key (Search only). Optional. */
  darwinApiKey: process.env.DARWIN_API_KEY || "",

  openaiApiKey: process.env.OPENAI_API_KEY || "",
  openaiModel: process.env.OPENAI_MODEL || "gpt-5.6-luna",
  /** Hard ceilings on real OpenAI usage. */
  llmMaxCallsPerProcess: num("LLM_MAX_CALLS_PER_PROCESS", 25),
  llmMaxCallsPerDay: num("LLM_MAX_CALLS_PER_DAY", 100),
  llmMaxOutputTokens: num("LLM_MAX_OUTPUT_TOKENS", 900),
  llmTimeoutMs: num("LLM_TIMEOUT_MS", 45_000),

  dataDir: process.env.AXOLOTL_DATA_DIR || "data",
  /** Base URL this server is reachable at (used to build the local demo-site URL). */
  publicBaseUrl: process.env.AXOLOTL_BASE_URL || `http://localhost:${process.env.PORT || 3000}`,
};

export function demoSiteUrl(): string {
  return process.env.DEMO_SITE_URL || `${env.publicBaseUrl}/demo-site/`;
}
