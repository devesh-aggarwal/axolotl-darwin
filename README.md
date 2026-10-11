# Axolotl

**Self-healing agent workflows, built on Darwin.**

You leave an agent workflow running overnight, one step fails silently, and you wake up to nothing. Axolotl runs multi-step agent workflows on top of [Darwin](https://darwin.so) and repairs them on its own: when an agent errors, hangs, asks for a login mid-run, or returns output that looks fine but is wrong, Axolotl finds another agent that can do the job through Darwin, vets it automatically, checks the new answer, and keeps going. Nobody approves agents ahead of time. Branches that didn't fail never stop.

The demo workflow is an overnight pre-launch website audit: crawl the site, run accessibility and performance audits per page plus SEO, security-header and broken-link checks, merge and deduplicate the findings, and produce a prioritized fix plan with drafted fixes.

Team: Swarchis Kulkarni, Devesh Aggarwal, Gautam Anand.

## Run it

Requires Node 22 (Apple Silicon build on this Mac; see `PROGRESS.md`).

```bash
export PATH="$HOME/.nvm/versions/node/v22.23.3/bin:$PATH"
npm install
npm run dev
```

Open http://localhost:3000. The demo target site is served at http://localhost:3000/demo-site/.

Optional `.env` settings:

| Variable | Purpose |
|---|---|
| `OPENAI_API_KEY` | Enables the optional GPT review (layer 4 judge) and GPT-written fix plans. Model `gpt-5.6-luna`. |
| `DARWIN_ACCESS_TOKEN` | Darwin user OAuth token with `human:actions`, allowlisted for the Act pilot. Needed to run real Darwin agents. |
| `DARWIN_API_KEY` | Currently ignored. Darwin application keys aren't working yet, so Search runs anonymously. |
| `DEMO_SITE_URL` | Public URL of the deployed demo site, so real Darwin agents can reach it. |
| `AXOLOTL_CLIENT` | `mock` (default) or `real`: which agents new runs use. |
| `AXOLOTL_MODE` | `workflow` (default, Option A) or `your-agent` (Option B: your agent first, Darwin agents as backups). |
| `YOUR_AGENT_MCP_URL` | Option B only: your own agent's MCP address. Without it, a simulated stand-in plays your agent. |

## The four screens

- **Run**: the live workflow graph. Open a step to see which agents Axolotl found for it, in the order it will try them, and which it left out and why. *Settings* sets a spending limit per run for paid agents (none by default). Turn on Chaos, or open any step and press *Crash agent*, *Make it hang* or *Corrupt output*, and watch the step flash red and a backup agent grow in. *Simulate crash* kills the engine mid-run; *Resume from checkpoint* restores every finished step and continues.
- **Overnight**: a full night of runs compressed into a minute, with and without Axolotl, side by side.
- **Leaderboard**: every agent's reliability score per capability, with its trust verdict. Agents that prove reliable are tried first next time.
- **Report**: the prioritized fix plan, drafted fixes, the issues highlighted on the real page, and a timeline of every failure and recovery.

## How it works

```
                            ┌─> Accessibility audit, per page ─┐
                            ├─> Performance audit, per page ───┤
Site URL ─> Crawl / map ────┼─> SEO audit ─────────────────────┼─> Merge ─> Prioritize ─> Fix plan
                            ├─> Security headers ──────────────┤
                            └─> Broken links ──────────────────┘
```

- **Engine** (`src/lib/engine`): runs the DAG with per-page fan-out, parallel branches and a concurrency limit. A merge waits for every branch and tolerates a branch where every agent failed. Every finished step is checkpointed in SQLite, so a crashed run resumes from its last good step.
- **Failure detection**: hard failures (errors, timeouts, stalled threads with no progress, connection drops, login or payment requests during an unattended run) and silent failures (verification).
- **Verification** (`src/lib/verify`), four layers; a step passes only if all pass:
  1. *Format*: the output matches the step's zod contract.
  2. *Sanity rules*: every finding is the right category, on a page that was actually crawled, with real text (no refusals or placeholders); "no problems found" on a page with known problems fails.
  3. *Spot-check*: Axolotl re-checks a sample of the findings itself (does that image really lack alt text? does that link really 404?) and measures recall against the planted issues on the demo site.
  4. *Review*: a fixed rubric, rule-based by default, or GPT when enabled.
- **Runtime discovery** (`src/lib/engine/discovery.ts`): when a step starts, Axolotl searches Darwin (or the simulated catalog) for agents that can do it, once per step per run, and vets every result with nobody in the loop:
  - unsafe listings (trust verdict *avoid*) are never used;
  - agents that need a sign-in or setup are skipped, since nobody is awake to sign in;
  - paid agents are skipped unless the run has a spending limit; with one, every free agent is tried first, and a paid one only while its price still fits;
  - agents that can't be called (no Darwin Act access and no verified direct address) or aren't answering are skipped.

  Each step records what it searched, what it will try and what it left out (`NodeView.route`).
- **Failover**: tries the agents found in order: your agent (Option B), then free, then paid, then simulated. Within a tier, by verified reliability, then trust score, then Darwin's rank. Each attempt gets a fresh idempotency key; a dropped connection is retried once with the same key.
- **Trust check** (`src/lib/trust`): every agent Axolotl finds gets a 0–100 trust score answering three questions. *Safety*: does its listing (description, connection text, MCP tool descriptions) try to override the caller, ask for keys, send data elsewhere or run shell commands? Unsafe agents are never used. *Cost*: does Darwin's listing say it charges (payment required, x402) or needs an account? *Quality*: a trial (`POST /api/trust/trial`) runs one task on the demo site, where every planted issue is known, and real runs keep updating it. Runs also record incidents against an agent (asked for payment or a sign-in, answer tried to hijack the caller). `GET /api/trust` lists every agent seen with its report: the record of which agents actually deliver.
- **Reliability**: per agent per capability, `(successes + 1) / (attempts + 2)`, latency breaking ties. 10% of the time a less-tested agent goes second, so an early lucky streak doesn't fix the order forever.
- **Darwin client** (`src/lib/darwin`): `RealDarwinClient` uses public Search and the v3 Act API; `McpDirectClient` calls an agent's own MCP endpoint when Darwin has verified one, so agents can run without Act; `MockDarwinClient` simulates 30 agents with seeded, realistic behavior (latency, crashes, hangs, login requests, and five kinds of bad output) so demos are reproducible.
- **Translation** (`src/lib/translate`): real agents answer in their own formats (axe-core, Lighthouse, Markdown, prose); this reads them into the step's format before the checks, dropping anything that fits no check rather than guessing.
- **Simulated fallback**: a Darwin run tries real agents first and keeps simulated ones as the last resort (Settings → Simulated backups), labelled as such.

Darwin finds agents and lets you talk to them. It deliberately does not fail over between agents, verify their output, or track their success rates. That's the gap Axolotl fills, and the outcome data it collects could make Darwin's own ranking smarter.

## Demo script (about 3 minutes)

1. **Hook**: "You leave an agent running overnight, one step fails silently, and you wake up to nothing."
2. **No setup**: start a run straight away. Open a step: Axolotl searched Darwin for it, shows the agents it will try in order, and the ones it left out (unsafe, needs a sign-in, paid with no spending limit).
3. **Live run**: start a run on the demo site. Press *Crash agent* on an accessibility step and watch it regrow with a backup. Press *Corrupt output* on SEO (the agent "finishes" but reports problems on pages that don't exist), open the step to show the sanity check catching it, and watch the swap.
4. **Overnight**: start the time-lapse. Without Axolotl most nights end with no usable report; with Axolotl nearly all of them finish, with nobody stepping in.
5. **Leaderboard**: the steadier agents rise. "This data makes Darwin smarter."
6. **Close**: the report, with the issues outlined on the real page, and the hours saved.

## Tests

None of these call OpenAI or Darwin.

```bash
npx tsx --tsconfig tsconfig.json scripts/test-audit.ts
npx tsx --tsconfig tsconfig.json scripts/test-llm.ts
npx tsx --tsconfig tsconfig.json scripts/test-darwin-real.ts
npx tsx --tsconfig tsconfig.json scripts/test-darwin-mock.ts
npx tsx --tsconfig tsconfig.json scripts/test-verify.ts
npx tsx --tsconfig tsconfig.json scripts/test-engine.ts
npx tsx --tsconfig tsconfig.json scripts/test-direct.ts
npx tsx --tsconfig tsconfig.json scripts/test-trust.ts
npx tsx --tsconfig tsconfig.json scripts/test-discovery.ts
npx tsx --tsconfig tsconfig.json scripts/calibrate-timelapse.ts 50 0.1
```

More: `docs/EVENT-DAY.md` (plugging in Darwin access, picking Option A or B), `docs/ARCHITECTURE.md` (module contracts), `docs/UI.md` (design rules), `docs/darwin/API-NOTES.md` (Darwin integration).
