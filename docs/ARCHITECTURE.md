# Axolotl architecture

Axolotl runs a multi-step agent workflow (a DAG) on top of Darwin and repairs it automatically: on a hard failure or a silent failure (bad output) it swaps in a pre-approved backup agent, adapts the input, reruns, verifies, and continues. Branches that didn't fail keep running.

The product spec is `speedhacks-project.md`. This file is the engineering contract between modules. **Shared types live in `src/lib/types.ts`; do not redefine them.**

```
src/
  config/workflow.ts        node templates (capability query, contract, fan-out rule) + DEFAULTS
  lib/types.ts              shared domain types
  lib/contracts.ts          zod output contracts (verification layer 1)
  lib/rng.ts                seeded randomness (mulberry32, rngFor, pickWeighted, sampleLatency)
  lib/env.ts                server config from env (.env). Never log secrets.
  lib/db.ts                 SQLite schema + getDb()
  lib/events.ts             in-process event bus (publish/subscribe EngineEvent)
  lib/audit/                local auditing toolkit: fetcher, analyzers, rules, ground truth, spot checks, demo-site serving
  lib/darwin/types.ts       DarwinClient interface
  lib/darwin/mock.ts        MockDarwinClient (fake agents with configurable behavior)
  lib/darwin/mockCatalog.ts mock agent catalog + default pools
  lib/darwin/real.ts        RealDarwinClient (public Search + Act v3)
  lib/llm/gateway.ts        the ONLY place that calls OpenAI; hard budget caps + cache
  lib/llm/judge.ts          verification layer 4 (mock judge + live judge)
  lib/llm/adapter.ts        input adapter (template instruction, LLM argument mapping)
  lib/llm/fixplan.ts        fix plan (template, or one LLM call)
  lib/verify/index.ts       verification layers 1–4
  lib/engine/*              DAG engine, failover, chaos, stats, pools, store, timelapse
  app/api/*                 route handlers (runs, SSE events, chaos, setup, stats, timelapse)
  app/demo-site/[[...path]] serves demo-site/ locally with NO security headers
  components/*              UI
demo-site/                  static demo target site with planted issues + ground-truth.json
fixtures/darwin-search/     saved real Darwin Search responses (for offline tests)
docs/darwin/                Darwin OpenAPI specs and docs snapshots
scripts/                    tsx test / smoke scripts
```

## Hard rules for all code

- **OpenAI is only called through `src/lib/llm/gateway.ts`.** Every call is budget-guarded. Tests must stub `fetch`; they never hit the network.
- Default LLM mode is `mock`. Live calls only when a run's `llmMode === "live"`. The time-lapse and chaos runs always use the mock judge.
- Never log or return secrets (`OPENAI_API_KEY`, `DARWIN_ACCESS_TOKEN`, `DARWIN_API_KEY`, search tokens).
- Do not invent Darwin API fields: code against `docs/darwin/openapi-v3.json`.
- Code style: TypeScript strict, double quotes, 2-space indent, short comments only where they add information.

## Module contracts

### `lib/audit` — local auditing toolkit

Used by (a) the mock agents to produce realistic outputs ("perfect agent" output, which the mock then degrades), and (b) verification layer 3 to spot-check claims independently.

Rule codes (`rules.ts`, `RULES: Record<string, RuleDef>`):

| rule | category | default severity | scope |
|---|---|---|---|
| image-alt | accessibility | high | page |
| color-contrast | accessibility | medium | page |
| label | accessibility | high | page |
| button-name | accessibility | high | page |
| html-has-lang | accessibility | medium | page |
| oversized-image | performance | high | page |
| unsized-image | performance | medium | page |
| render-blocking-script | performance | medium | page |
| meta-description | seo | medium | page |
| document-title | seo | high | page |
| multiple-h1 | seo | low | page |
| robots-txt | seo | low | site |
| sitemap | seo | low | site |
| missing-csp | security | high | site |
| missing-x-frame-options | security | medium | site |
| missing-x-content-type-options | security | medium | site |
| missing-referrer-policy | security | low | site |
| missing-hsts | security | high | site |
| insecure-form-action | security | critical | page |
| broken-link | links | medium (internal) / low (external) | page |

```ts
interface RuleDef { rule: string; category: AuditCategory; severity: Severity; title: string; recommendation: string; effort: "small" | "medium" | "large"; scope: "page" | "site" }

// fetcher.ts — in-memory cache (TTL ~60s), timeouts, never throws for HTTP errors
fetchPage(url: string): Promise<FetchedPage>     // { url, finalUrl, status, headers (lower-cased), html, bytes }
checkUrl(url: string): Promise<UrlCheck>          // { url, status: number | null, ok, error?, bytes?: number | null }; HEAD then GET fallback; DNS failure ⇒ status null
clearFetchCache(): void

// analyzers.ts
crawlSite(input: CrawlInput): Promise<CrawlOutput>                                  // BFS same-origin <a href>, only status 200 pages, cap maxPages, home first
auditPage(category: "accessibility" | "performance", input: PageAuditInput): Promise<AuditOutput>
auditSite(category: "seo" | "security" | "links", input: SiteAuditInput): Promise<AuditOutput>

// index.ts
runCapability(capability: Capability, input: AgentNodeInput): Promise<CrawlOutput | AuditOutput>

// spotcheck.ts — independent re-verification of specific claims (layer 3)
spotCheckIssues(issues: Issue[], opts: { sample: number; seed: number }): Promise<SpotCheckResult>
// SpotCheckResult = { checked, confirmed, refuted, unverifiable, samples: { issue, verdict: "confirmed" | "refuted" | "unverifiable", note }[] }

// groundTruth.ts — demo-site/ground-truth.json
loadGroundTruth(): GroundTruth
isDemoSite(siteUrl: string): boolean
expectedIssues(siteUrl: string, filter?: { category?: AuditCategory; pageUrl?: string }): ResolvedGroundTruthIssue[]   // pageUrl resolved to absolute
matchesGroundTruth(gt: ResolvedGroundTruthIssue, issue: Issue): boolean
measureRecall(siteUrl: string, issues: Issue[], filter?: { category?: AuditCategory; pageUrl?: string }): { found: number; expected: number; ratio: number; missing: ResolvedGroundTruthIssue[] }

// demoSite.ts — shared by the Next route and scripts/serve-demo-site.ts
readDemoSiteFile(relPath: string): { status: number; contentType: string; body: Buffer }   // traversal-safe; "" ⇒ index.html; missing ⇒ 404 HTML page
```

Issue conventions:
- `pageUrl` is absolute. Site-wide issues (headers, robots.txt, sitemap) use the site root URL (e.g. `http://localhost:3000/demo-site/`).
- URL normalization: strip hash and query, and a trailing `index.html` (`…/demo-site/index.html` ≡ `…/demo-site/`).
- `broken-link`: `selector` = `a[href="<href exactly as written>"]`, `evidence` contains the resolved absolute URL and the status (or DNS error).
- `oversized-image`: evidence contains the image URL and byte size. Threshold 500 KB.
- `color-contrast`: computed from inline `color` and nearest inline `background-color` (default `#ffffff`); fail below 4.5:1.
- Missing security headers are checked on the site root response.
- On the demo site, `runCapability` must reproduce **exactly** the non-optional issues in `ground-truth.json` (plus `missing-hsts` when the header is absent), and nothing else.

### `lib/darwin` — clients

`DarwinClient` interface in `lib/darwin/types.ts`. Engine flow per attempt: `startTask` → poll `pollTask` every `pollIntervalMs × timeScale` until completed / error / blocked, or the engine's timeout or stall detector fires → `cancelTask`.

**MockDarwinClient** (`mock.ts`, `mockCatalog.ts`)
- Catalog: 5 agents per capability with distinct names, providers and behavior profiles: mean latency, jitter, failure weights (`error`, `timeout`, `stall`, `auth_block`, `bad_output`), corruption weights, `recall` (fraction of true issues it reports), a transport-glitch rate, and `healthy` (one agent per capability is down so health checks mark it not ready).
- Default pool per capability: a well-known but flaky primary plus two steadier backups, so failover and the evolution leaderboard are interesting even without chaos.
- `startTask` is idempotent per `idempotencyKey` (same key ⇒ same task). A transport glitch throws `TransportError` once; the retry with the same key succeeds.
- Behavior is fully determined by `rngFor(seed, nodeInstanceId, agentId, attemptNo)` unless `context.forcedFault` is set.
- Outputs come from `runCapability` (cached per input), then degraded by recall, then optionally corrupted: `hallucinated_pages`, `empty`, `refusal`, `schema`, `fabricated`.
- `oracle` on completed polls reports whether the output was corrupted (never read by verification).
- All latencies scale with `context.timeScale`.

**RealDarwinClient** (`real.ts`)
- Search: `POST {apiBase}/v3/search` `{ query, maxResults }` (public, no key; optional `x-api-key` or bearer). Map `response.agents[]` to `AgentCandidate`. Keep `searchToken` in memory only.
- Act v3 (pilot preview, allowlisted credentials only): `POST {apiBase}/v3/act` with `Authorization: Bearer <DARWIN_ACCESS_TOKEN>`, `Idempotency-Key`, body `{ targets: [{ agentId, capabilityId, arguments? }], message }`. Read with `GET {apiBase}/v3/act/requests/{actRequestId}?includeThreadState=true&threadId=…&cursor=…`.
- Thread state → `TaskPoll`: pending `authentication_request` / `authentication_required` ⇒ blocked authentication; `payment_request` ⇒ blocked payment; `approval_request` ⇒ blocked approval; non-retryable `errors[]` or failed/cancelled actions ⇒ error; an agent `result` message ⇒ completed (`data`, else JSON parsed from text content).
- `ACT_PREVIEW_ACCESS_REQUIRED` (403) and missing credentials are hard errors with a clear message; 5xx / network ⇒ `TransportError`.
- Health check: without Act credentials ⇒ `unverified`, not ready.

### `lib/llm` — guarded LLM use (OpenAI Responses API, model `gpt-5.6-luna`)

```ts
// gateway.ts
class LlmUnavailableError extends Error { reason: "disabled" | "no_key" | "budget_process" | "budget_day" | "budget_run" | "http" | "timeout" | "parse" }
interface RunLlmBudget { limit: number; used: number }
callLlmJson<T>(opts: { purpose: "judge" | "adapter" | "fixplan" | "test"; system: string; user: string; schemaName: string; schema: Record<string, unknown>; maxOutputTokens?: number; runBudget?: RunLlmBudget; cache?: boolean }): Promise<{ data: T; cached: boolean; usage?: { input: number; output: number } }>
getLlmUsage(): LlmUsage   // counts, limits, model, keyPresent (boolean only), token totals
```
- Caps checked **before** every call: per-process, per-day (persisted in `data/llm-usage.json`), per-run (`runBudget`). Counters increment before the request so failures count too.
- One request per call: no automatic retries, `AbortController` timeout, `max_output_tokens` cap.
- Cache identical prompts in SQLite `llm_cache`; cache hits cost nothing and don't count.

```ts
// judge.ts — layer 4
mockJudge(j: JudgeInput): LayerResult
liveJudge(j: JudgeInput, budget?: RunLlmBudget): Promise<LayerResult>   // falls back to mockJudge (source "budget_fallback") on LlmUnavailableError
// adapter.ts
adaptInput(a: { agent: AgentRef & { argumentSchema?: Record<string, unknown> | null }; template: NodeTemplate; input: AgentNodeInput; llmMode: "mock" | "live"; budget?: RunLlmBudget }): Promise<AdaptedInput>
// AdaptedInput = { instruction: string; arguments?: Record<string, unknown>; method: "template" | "llm" | "cache" }
// fixplan.ts
buildFixPlan(a: { prioritized: PrioritizedOutput; siteUrl: string; partialBranches: { nodeId: string; label: string }[]; llmMode: "mock" | "live"; budget?: RunLlmBudget }): Promise<FixPlanOutput>
```

### `lib/verify` — output verification

```ts
interface VerifyContext { template: NodeTemplate; input: AgentNodeInput; output: unknown; siteUrl: string; crawledPages: string[]; seed: number; llmMode: "mock" | "live"; llmBudget?: RunLlmBudget }
verifyOutput(ctx: VerifyContext): Promise<VerificationResult>
```
1. **Schema** — zod contract for the template.
2. **Rules** — required fields non-empty; issue category matches the node; every `pageUrl` is a crawled page (or the site root for site-wide rules); page-scope outputs list the input page in `pagesChecked`; severities valid; no placeholder / refusal text; a zero-issue report where ground truth expects issues fails. Crawl outputs: same-origin pages, status 200.
3. **Spot-check** — re-verify a seeded sample of claims with our own fetches (`spotCheckIssues`); any refuted claim fails. On the demo site also measure recall against ground truth; below 0.5 fails.
4. **Judge** — fixed rubric `{ pass, reason, confidence }`; mock unless `llmMode === "live"`. Only runs when 1–3 pass.

A node passes only if every layer passes. Every verdict is stored on the attempt and shown in the inspector.

### `lib/engine`

- Templates from `config/workflow.ts` are instantiated as node instances; `page` templates fan out per crawled page once the crawl passes.
- Per agent node: walk the pool (primary, then ready backups ordered by reliability score). Each attempt gets a fresh idempotency key; a transport retry reuses it. Hard failures (error, timeout, stall, auth/payment block during unattended runs, killed) and silent failures (verification) move to the next backup. When every agent fails, the node is `failed`, an alert fires, and the branch stops; merge marks the run partial.
- Checkpoint after each node: passed outputs are stored, so `resume(runId)` restores them and continues.
- Chaos: per-attempt random faults at a configurable rate, plus manual kill / timeout / corrupt per node.
- Reliability: Beta-Bernoulli `(successes + 1) / (attempts + 2)`, latency as tiebreak.
- Baseline ("without Axolotl"): primary only, no verification, no failover. Used by the time-lapse for the split-screen comparison.
