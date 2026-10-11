# SpeedHacks Project: Axolotl

**Self-healing agent workflows, built on Darwin.**

Name: **Axolotl** (the animal that regrows lost limbs; fits self-healing and Darwin's evolution theme)

Team: Swarchis Kulkarni, Devesh Aggarwal, Gautam Anand

---

## 0. Instructions for the coding agent (read first)

- Never put secrets in code or logs. Read keys from `.env` only. Add `.env` to `.gitignore`.
- Darwin Act credentials are not available yet (Act is a pilot preview gated by an allowlist). Build against `MockDarwinClient` and the real public Darwin Search API (no key needed). Fully wire the real Act client so only credentials are missing.
- Do not invent Darwin API fields. Read the OpenAPI specs linked from https://darwin.so/docs/llms.txt and code against them.
- Work in milestones (section 9). After each milestone: make sure it runs, write a short note in `PROGRESS.md` (what works, what's stubbed, how to run it), then continue.
- Prefer working and demoable over clever. Every milestone should leave the app in a runnable state.

## 1. Event context

- **Event:** SpeedHacks, the official a16z speedrun hackathon and closing hackathon of SF Tech Week
- **When:** Sunday Oct 11, 2026, 9am to 9pm (12 hours)
- **Where:** 1005 Sansome St, San Francisco
- **Theme:** "Find ways to give people their time back."
- **Prizes:** grand prize is an expedited / final interview with the speedrun + speedrun Alpha investment team plus $1K; $1K "best use" prize per sponsor company
- **Sponsors:** Dial, Alike, Keewano, Darwin, Sparta
- **Our decision:** target **one sponsor only: Darwin**. Do not integrate other sponsors.
- **Unknowns to confirm at kickoff:** judging criteria, team size limits, submission format, and Darwin's exact track wording (we have not seen it).

## 2. What Darwin is

Darwin (darwin.so) is an "agent browser": a search engine over roughly 200K AI agents.

- **Search:** describe a capability in plain English and get ranked agents back. Each result has `agentId`, `capabilityId`, `reasons`, `uncertainties`, `readiness`, `canStartThread`, `requiredSetup`, `connectionPrompt`. Public, no API key needed.
- **Act:** start a thread with an agent (`start_thread`), send messages (`send_message`), read results (`get_thread` with a cursor). Requires Darwin authorization. Agents may return `authentication_request` or `payment_request` that a human must approve. Supports idempotency keys.
- **Interfaces:** REST API, MCP server (`https://mcp.darwin.so/mcp`), TypeScript SDK, Python SDK.
- **Docs:** https://darwin.so/docs/llms.txt, https://darwin.so/skill.md

```bash
curl -fsS https://api.darwin.so/api/v3/search \
  -H 'Content-Type: application/json' \
  --data '{"query":"AI agent that can research a company","maxResults":5}'
```

**What Darwin does NOT do (per their docs):** automatic failover between agents, output verification, or tracking agent success rates. Their only "recovery" is retrying the identical request after a transport failure. They deliberately keep humans in the loop for execution, auth, and payment. That is the gap Axolotl fills.

## 3. Problem and pitch

People leave agent workflows running overnight. When one step fails silently (an agent errors, a connection breaks, or the step "succeeds" but returns garbage), the whole run is ruined and nobody knows until morning.

**Pitch line:** "You leave an agent running overnight, one step fails silently, and you wake up to nothing. Axolotl makes agent workflows heal themselves."

## 4. Product

A supervisor that runs multi-step agent workflows (as a DAG) on top of Darwin and repairs them automatically.

It handles two failure types:
1. **Hard failure:** error, timeout, broken connection, stalled thread, or an unexpected auth/payment block during an unattended run.
2. **Silent failure:** the step completes but the output is wrong or unusable.

On failure it swaps in a **pre-approved backup agent** for that node, adapts the input, reruns, verifies, and continues. Branches that didn't fail keep running.

### Core design: pre-approved backup pool

A swap at 3am must never trigger a new approval.

**Setup (user awake):** define the workflow; for each node, search Darwin and show the top 3 to 5 agents; the user picks a primary and 2 backups and completes approvals up front; health-check each backup and mark it ready or not.

**Unattended run:** on failure, move to the next ready backup (no new search, no new approvals). If every backup fails, stop that branch cleanly and alert. Backups are ranked by observed reliability and rechecked on a schedule.

## 5. Demo workflow: overnight pre-launch website audit

**Why this workflow:** every branch needs a specialized tool (scanners, crawlers, auditors), not just text generation, so using Darwin agents is justified. Audit outputs are checkable against the real site, which makes verification genuine. And it replaces a day of developer work.

**Input:** a website URL. **Output:** a prioritized, deduplicated fix plan, ready in the morning.

```
                            ┌─> Accessibility audit (WCAG), per page ─┐
                            ├─> Performance audit, per page ──────────┤
Site URL ─> Crawl / map ────┼─> SEO audit ────────────────────────────┼─merge─> Prioritize ─> Fix plan
            (find pages)    ├─> Security headers / SSL scan ──────────┤        (dedupe,     (+ draft fixes
                            └─> Broken link check ────────────────────┘         severity)    for top issues)
```

- **Crawl node:** discovers the site's pages (cap at about 5 key pages for the live demo).
- **Fan-out:** accessibility and performance audits run once per page, in parallel (5 pages means 10+ live agent nodes, plus the site-wide nodes).
- **Site-wide audit nodes:** SEO, security headers/SSL, broken links.
- **Merge node:** waits for all branches; tolerates a branch that exhausted its backups (marks it partial in the report, doesn't kill the run).
- **Prioritize node:** dedupes overlapping findings and ranks by severity and effort.
- **Fix plan node:** final report; optionally drafts code fixes for the top issues (can be our own LLM call).

Each audit node outputs issues in a shared format: `{ category, severity, pageUrl, element/selector (if any), description, recommendation, evidence }`. Each node has a zod output contract. Keep node definitions (capability query, contract, fan-out rule) in a config file so the team can swap capabilities after the first-hour Darwin check.

### Demo target site with seeded issues

Build a small demo website (served locally or deployed) with **known, deliberately planted problems**: images missing alt text, low-contrast text, a form input with no label, broken internal and external links, missing meta description and title tags, missing security headers, an oversized unoptimized image. Keep a `ground-truth.json` listing every planted issue.

This gives verification real ground truth, makes the demo deterministic, and lets us show "the backup agent found the issues the dead agent missed." For the live demo we can also run it on a real site (like a team member's project).

**First-hour Darwin check (as soon as we have Darwin credits at the event):** deploy the demo site publicly so Darwin agents can reach it, then for each node's query confirm at least 2 Darwin agents return `canStartThread: true` and actually complete a thread against it. Replace capabilities that fail.

## 6. Visual design (the demo must look alive)

Use React Flow (or similar) for the main canvas.

1. **Live workflow graph.** Nodes are colored by state: idle, running (pulsing), verifying, passed, failed, swapping, partial. Edges animate as data flows. When a node fails, it flashes red, the replacement agent "grows in" on the node (axolotl regrowth metaphor), and the badge updates to the new agent's name.
2. **Node inspector.** Click any node to see its attempt history: which agent, input sent, raw output, verification layers with pass/fail and the judge's reason, latency.
3. **Agent pool sidebar.** For the selected node: primary and backups, readiness, reliability score bar, last health check.
4. **Chaos mode.** A toggle that randomly injects failures (errors, timeouts, corrupted outputs) across nodes at a configurable rate while the workflow runs. Plus manual buttons per node: kill, timeout, corrupt output.
5. **Overnight time-lapse (the hero shot).** Simulate a full night: run N workflow executions (for example 50) back to back with chaos mode on, compressed into about 60 seconds. Show two live counters side by side:
   - **Without Axolotl:** completion rate, wasted hours.
   - **With Axolotl:** completion rate, recoveries, zero human interventions.
   Render as a split-screen chart that fills in live. This is the "give people their time back" moment.
6. **Evolution view (Darwin tie-in).** A leaderboard per capability showing agents' reliability scores shifting across runs, so the best agents rise over time. Small sparkline per agent.
7. **Run report.** At the end: the prioritized fix plan, timeline of every failure and recovery, estimated human time saved.
8. **Issue overlay (nice to have).** Show the demo site with flagged issues highlighted on the page itself, so judges see real problems found.

The time-lapse and chaos mode should run on `MockDarwinClient` so they are fast and deterministic. The live single-run demo should use real Darwin where possible.

## 7. Technical components

1. **DAG workflow engine**
   - Topological execution with parallel nodes, fan-out per input item, and a merge node with partial-result tolerance.
   - Durable state in SQLite: runs, nodes, attempts, agent stats. Checkpoint after each node so a crashed run resumes from the last good node.
   - Idempotency keys for Darwin calls: reuse the same key only when retrying the identical request after a transport failure; new key for a new attempt or a different agent.
   - Concurrency limit configurable.

2. **Failure detection**
   - Hard: HTTP errors, thread error events, timeouts, no cursor progress for N seconds, auth/payment requests during unattended runs.
   - Silent: verification (below).

3. **Output verification**
   - Layer 1: zod schema against the node's output contract.
   - Layer 2: rule checks (required fields non-empty, every `pageUrl` is a page we actually crawled, severities valid, no placeholder or refusal text, a "zero issues" report on a page with known planted issues fails).
   - Layer 3: spot-check against our own lightweight checks. Fetch the page HTML ourselves and confirm a sample of reported issues are real (for example, the flagged `<img>` really has no alt, the flagged link really 404s). Also measure recall against `ground-truth.json` on the demo site.
   - Layer 4: LLM judge with a fixed rubric returning `{ pass, reason, confidence }`.
   - A node passes only if all layers pass. Every verdict and reason is stored and shown in the inspector.

4. **Input adapter**
   - If Darwin exposes the capability's argument schema, map the node input to it with an LLM call, validate, and cache the mapping per agent.
   - Otherwise generate a precise natural-language instruction from the node input plus its output contract.

5. **Reliability scoring**
   - Per agent per capability: attempts, verified successes, failure types, latency.
   - Score with Beta-Bernoulli `(successes + 1) / (attempts + 2)`, latency as tiebreak. Backup order uses this score.
   - Pitch to Darwin: "we generate outcome data that could make your ranking smarter."

6. **Health checks**
   - On setup, plus a scheduled recheck of backups. Mark stale backups not-ready.

7. **Live updates**
   - Server pushes node state changes over SSE or websockets to the graph.

## 8. Stack

- TypeScript end to end
- Next.js (UI plus API routes); a separate Node worker process for the engine if needed
- React Flow for the graph, Recharts (or similar) for charts, Tailwind for styling
- SQLite (better-sqlite3 or Prisma)
- zod
- LLM provider via env var (judge and input adapter); keep the provider swappable

### Darwin client abstraction

`DarwinClient` interface with:
- **RealDarwinClient:** real Search (public, no key) plus Act (works once Darwin Act credentials are added).
- **MockDarwinClient:** fake agents with configurable behavior per agent: success rate, latency distribution, failure modes (error, timeout, bad output, auth block). Realistic fake outputs for each capability. Seeded randomness so demos are reproducible.

Switch per run via a UI toggle and an env var default.

## 9. Milestones (build in this order)

1. **Skeleton:** Next.js app, SQLite schema, `DarwinClient` interface, MockDarwinClient with fake agents for every node capability (fake audit results derived from the demo site), RealDarwinClient Search working against the live API. Build the demo target site with seeded issues and `ground-truth.json`.
2. **Engine:** DAG execution with fan-out, parallel nodes, merge, checkpoints, failover to backups on hard failure.
3. **Verification:** all three layers, swap on silent failure, verdicts stored.
4. **Live graph UI:** React Flow canvas with state colors, animations, node inspector, agent pool sidebar.
5. **Setup flow:** search Darwin per node, pick primary plus backups, health checks.
6. **Chaos mode:** random and manual fault injection.
7. **Reliability scoring and evolution view.**
8. **Overnight time-lapse with split-screen with/without comparison.**
9. **Run report.**
10. **Polish:** input adapter, scheduled health rechecks, crash-resume demo, visual polish, README with run instructions.

If time runs short, milestones 1 to 6 plus 8 are the priority.

## 10. Demo script (about 3 minutes)

1. **Hook (20s):** the overnight pitch line.
2. **Setup (25s):** workflow graph, Darwin results per node, backups picked, approvals done up front.
3. **Live run (70s):** start the audit on the demo site; the graph lights up across parallel branches. Hit "kill" on an accessibility node, watch it go red and regrow with a backup. Hit "corrupt output" on the SEO node (it reports issues on pages that don't exist), show verification catching it in the inspector, watch the swap.
4. **Overnight time-lapse (40s):** turn on chaos mode, run a simulated night, split-screen fills in: without Axolotl most runs die, with Axolotl nearly all complete with zero human interventions.
5. **Evolution view (15s):** best agents rising on the leaderboard; "this data makes Darwin smarter."
6. **Close (10s):** the fix plan and time saved.

## 11. Risks

| Risk | Mitigation |
|---|---|
| Darwin agents for our capabilities aren't executable | First-hour Darwin check; swap capabilities via config; MockDarwinClient fallback |
| Act requires auth or payment | Do approvals during setup; skip payment-gated agents |
| Darwin threads are slow | Timeouts plus polling; cap the live run at about 5 pages; time-lapse on mock |
| Darwin audit agents can't reach a localhost site | Deploy the demo site publicly (for example Vercel) as the first step at the event |
| Live demo flakiness | Seeded mock runs; deterministic fault buttons; recorded backup video |
| Darwin's track wants something else | Confirm track wording at kickoff |
| Looks like a retry script | Lead with backup pools, verification, reliability scoring, time-lapse |

## 12. Competitive angle

Portkey and OpenRouter do model-level fallbacks (same prompt, different model). Temporal-style engines retry the same step. Axolotl swaps the **whole agent**, to a different provider with the same capability, found through Darwin, pre-approved so it works unattended, and **verifies the output**, not just the HTTP status.

## 13. Open questions for the team

- Final node capabilities after the first-hour Darwin check
- How strict the LLM judge should be
- Whether the fix plan node is a Darwin agent or our own LLM call
- Which real site (if any) to audit live alongside the demo site
