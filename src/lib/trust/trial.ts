// Trial run: before an agent is trusted with real work, give it one task on the demo site, where
// every planted issue is known, and measure what it gets right. Same path as a real attempt
// (input adapter, translation for real agents, all four verification layers), but never GPT,
// never a payment, and nothing touches run history.
import { AGENT_TEMPLATES, DEFAULTS, REAL_TIMING, type NodeTemplate } from "@/config/workflow";
import { expectedPages, unmatchedIssues } from "@/lib/audit/groundTruth";
import { normalizeUrl } from "@/lib/audit/url";
import { TransportError, type TaskHandle, type TaskPoll } from "@/lib/darwin/types";
import { getDarwinClient } from "@/lib/engine/clients";
import { demoSiteUrl } from "@/lib/env";
import { adaptInput } from "@/lib/llm/adapter";
import { translateOutput } from "@/lib/translate";
import { answerHijacks } from "@/lib/trust/signals";
import { recordIncident, recordTrial } from "@/lib/trust/store";
import { verifyOutput } from "@/lib/verify";
import type { AgentNodeInput, AuditOutput, Capability, CrawlOutput, FailureType, PoolMember, TrialResult } from "@/lib/types";

/** Simulated agents run at this time scale during a trial, so it takes a second or two. */
const MOCK_TIME_SCALE = 0.25;

export type TrialAgent = Pick<PoolMember, "agentId" | "capabilityId" | "name" | "source" | "provider" | "searchId" | "argumentSchema" | "endpoint">;

function templateFor(capability: Capability): NodeTemplate {
  const t = AGENT_TEMPLATES.find((x) => x.capability === capability);
  if (!t) throw new Error(`No workflow step for capability "${capability}"`);
  return t;
}

function trialInput(t: NodeTemplate, siteUrl: string, pages: string[]): AgentNodeInput {
  if (t.id === "crawl") return { siteUrl, maxPages: DEFAULTS.maxPages };
  if (t.scope === "page") return { siteUrl, pageUrl: pages[0] ?? siteUrl };
  return { siteUrl, pages };
}

/** A dropped connection is retried once with the same request, as in a run; it isn't the agent's fault. */
async function withTransportRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof TransportError)) throw err;
    await new Promise((r) => setTimeout(r, 250));
    return fn();
  }
}

export async function runTrial(agent: TrialAgent, capability: Capability, opts: { seed?: number } = {}): Promise<TrialResult> {
  const started = Date.now();
  const result = await attempt(agent, capability, opts.seed ?? Math.floor(Math.random() * 1_000_000), started);
  recordTrial(agent.agentId, capability, result);
  return result;
}

async function attempt(agent: TrialAgent, capability: Capability, seed: number, started: number): Promise<TrialResult> {
  const t = templateFor(capability);
  const siteUrl = demoSiteUrl();
  const pages = expectedPages(siteUrl).slice(0, DEFAULTS.maxPages);
  const input = trialInput(t, siteUrl, pages);
  const client = getDarwinClient(agent.source);
  const real = client.kind !== "mock";
  const timeScale = real ? 1 : MOCK_TIME_SCALE;
  const deadline = started + (real ? REAL_TIMING.attemptTimeoutMs : DEFAULTS.attemptTimeoutMs * timeScale * 2);
  const pollMs = real ? REAL_TIMING.pollIntervalMs : Math.max(50, DEFAULTS.pollIntervalMs * timeScale);
  const fail = (failureType: FailureType, detail: string): TrialResult => ({ passed: false, failureType, detail, latencyMs: Date.now() - started, at: Date.now() });

  const adapted = await adaptInput({ agent, template: t, input, llmMode: "mock" });
  let handle: TaskHandle;
  try {
    handle = await withTransportRetry(() => client.startTask({
      agent,
      instruction: adapted.instruction,
      arguments: adapted.arguments,
      idempotencyKey: `axl:trial:${agent.agentId}:${started}`,
      searchId: agent.searchId,
      context: { runId: "trial", nodeInstanceId: `trial:${t.id}`, capability, input, seed, attemptNo: 1, timeScale, knownPages: pages },
    }));
  } catch (err) {
    return fail(err instanceof TransportError ? "transport" : "error", `Couldn't start: ${(err as Error).message}`);
  }

  let poll: TaskPoll;
  let cursor: string | undefined;
  while (true) {
    if (Date.now() > deadline) {
      await client.cancelTask(handle).catch(() => undefined);
      return fail("timeout", "No answer before the trial timed out");
    }
    try {
      poll = await withTransportRetry(() => client.pollTask(handle, cursor));
    } catch (err) {
      return fail(err instanceof TransportError ? "transport" : "error", (err as Error).message);
    }
    if (poll.status !== "running") break;
    cursor = poll.cursor;
    await new Promise((r) => setTimeout(r, pollMs));
  }

  if (poll.status === "error") return fail("error", `${poll.code}: ${poll.message}`);
  if (poll.status === "blocked") {
    await client.cancelTask(handle).catch(() => undefined);
    if (poll.kind === "payment") recordIncident(agent.agentId, capability, "payment", poll.message, "trial");
    else if (poll.kind === "authentication") recordIncident(agent.agentId, capability, "sign_in", poll.message, "trial");
    const asked = { payment: "payment", authentication: "a sign-in", approval: "a person's approval" }[poll.kind];
    return fail(poll.kind === "payment" ? "payment_block" : "auth_block", `Stopped to ask for ${asked}`);
  }

  if (answerHijacks(poll.raw) || answerHijacks(poll.output)) {
    recordIncident(agent.agentId, capability, "hijack", "Trial answer tried to override the caller's instructions", "trial");
    return fail("verification", "Its answer tried to override Axolotl's instructions");
  }

  let output = poll.output;
  if (real) output = (await translateOutput(output, { template: t, input, llmMode: "mock" })).output;
  const verification = await verifyOutput({
    template: t,
    input,
    output,
    siteUrl,
    crawledPages: t.id === "crawl" ? [] : pages,
    seed,
    llmMode: "mock",
  });
  const latencyMs = Date.now() - started;
  const recall = t.contract === "crawl" ? pageRecall(output, pages) : verification.recall?.ratio;
  const issues = (output as Partial<AuditOutput> | null)?.issues;
  const falseFindings = t.contract !== "crawl" && Array.isArray(issues) ? unmatchedIssues(siteUrl, issues).length : undefined;
  if (!verification.pass) {
    const failed = verification.layers.find((l) => !l.pass && !l.skipped);
    return { passed: false, failureType: "verification", detail: failed ? `${failed.name} check: ${failed.reason}` : "Answer failed verification", recall, falseFindings, latencyMs, at: Date.now() };
  }
  return { passed: true, detail: "Answer passed every check", recall, falseFindings, latencyMs, at: Date.now() };
}

/** Share of the demo site's pages (up to the page cap) the crawl listed. */
function pageRecall(output: unknown, expected: string[]): number | undefined {
  const listed = (output as Partial<CrawlOutput> | null)?.pages;
  if (!Array.isArray(listed) || !expected.length) return undefined;
  const found = new Set(listed.map((p) => (typeof p?.url === "string" ? normalizeUrl(p.url) : "")));
  return expected.filter((u) => found.has(normalizeUrl(u))).length / expected.length;
}
