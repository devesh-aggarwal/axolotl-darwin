// Step-level failover for the MCP tools: try each provider in order, verify its answer, and keep
// an honest record of every attempt (who ran, how it ended, why). Same idea as the workflow engine,
// sized for one tool call.

export type ProviderSource = "darwin" | "public-api" | "simulated";

export type AttemptOutcome =
  | "ok" // answered and passed verification
  | "failed" // errored or timed out
  | "rejected" // answered, but verification caught a bad answer
  | "skipped" // not attempted (missing capability, no access)
  | "blocked"; // stopped on a login or payment wall

export interface Attempt {
  step: string;
  agent: string;
  source: ProviderSource;
  outcome: AttemptOutcome;
  reason: string;
  ms: number;
}

export interface Provider<T> {
  name: string;
  source: ProviderSource;
  /** Checked before running: a reason here skips the provider without calling it. */
  precheck?: () => string | null | Promise<string | null>;
  run: (signal: AbortSignal) => Promise<T>;
}

/** Thrown by a provider to report a login/payment wall instead of a plain failure. */
export class BlockedError extends Error {}

export interface FailoverResult<T> {
  value: T | null;
  provider: Provider<T> | null;
  attempts: Attempt[];
}

export async function failover<T>(
  step: string,
  providers: Provider<T>[],
  verify: (value: T) => string | null,
  /** describe: a few words on what a passing answer was, for the trace and Rankings ("found 1 Main St"). */
  opts: { timeoutMs?: number; now?: () => number; describe?: (value: T) => string } = {},
): Promise<FailoverResult<T>> {
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? 12_000;
  const attempts: Attempt[] = [];
  for (const p of providers) {
    const started = now();
    const record = (outcome: AttemptOutcome, reason: string) =>
      attempts.push({ step, agent: p.name, source: p.source, outcome, reason, ms: now() - started });
    const skip = p.precheck ? await p.precheck() : null;
    if (skip) {
      record("skipped", skip);
      continue;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const value = await Promise.race([
        p.run(ctrl.signal),
        new Promise<never>((_, reject) => ctrl.signal.addEventListener("abort", () => reject(new Error(`timed out after ${timeoutMs / 1000}s`)))),
      ]);
      const problem = verify(value);
      if (problem) {
        record("rejected", problem);
        continue;
      }
      record("ok", opts.describe ? opts.describe(value) : "answer passed verification");
      return { value, provider: p, attempts };
    } catch (err) {
      record(err instanceof BlockedError ? "blocked" : "failed", short((err as Error)?.message ?? String(err)));
    } finally {
      clearTimeout(timer);
    }
  }
  return { value: null, provider: null, attempts };
}

function short(s: string): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > 200 ? `${one.slice(0, 197)}...` : one;
}

const ICON: Record<AttemptOutcome, string> = { ok: "✓", failed: "✗", rejected: "✗", skipped: "–", blocked: "⏸" };
const VERB: Record<AttemptOutcome, string> = { ok: "passed", failed: "failed", rejected: "caught bad answer", skipped: "skipped", blocked: "blocked" };

/** Plain-text trace for the calling model (and the person reading over its shoulder). */
export function renderAttempts(attempts: Attempt[]): string {
  return attempts
    .map((a) => {
      const tag = a.source === "simulated" ? " [simulated]" : a.source === "darwin" ? " [Darwin]" : "";
      return `${ICON[a.outcome]} ${a.step}: ${a.agent}${tag} ${VERB[a.outcome]} - ${a.reason}`;
    })
    .join("\n");
}
