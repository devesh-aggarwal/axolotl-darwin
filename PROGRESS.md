# Axolotl — progress

## Morning checklist

**Run it**

```bash
export PATH="$HOME/.nvm/versions/node/v22.23.3/bin:$PATH"
npm run dev                                                                 # http://localhost:3000
npx tsx --tsconfig tsconfig.json scripts/test-direct.ts                     # newest suite, no network
npx tsx --tsconfig tsconfig.json --env-file=.env scripts/darwin-smoke.ts    # dry run of the event-day check
```

**Real vs simulated today**

| Piece | State |
|---|---|
| Darwin Search | Real (public API) |
| Running agents through Darwin Act | Coded, untested: needs an allowlisted user token |
| Running agents directly at their MCP address | Real, tested end to end against our local test agents; real Darwin agents need a verified endpoint |
| Translation of real agents' answers | Real; rules for six formats, plus one capped GPT call when the rules find nothing (tested: 2 calls) |
| Verification (format, sanity rules, spot-check against the live page, review) | Real |
| Agents in the default demo | Simulated (labelled as such in every run) |
| "Found 26 of 26 planted issues" | Comes from simulated agents, so it proves the checks, not agent quality. Don't compare it with ChatGPT. |

**Needs Darwin credentials:** Act runs (`DARWIN_ACCESS_TOKEN`, allowlisted). Everything else works without them. Steps: `docs/EVENT-DAY.md`.

**Switch A/B:** set `AXOLOTL_MODE=your-agent` in `.env` for Option B (restart). To commit to one, the prompt is: "We picked A (or B): make it the only story and remove the other mode's wording."

**Open decisions for kickoff:** whole-job handoff for B (today B hands over step by step), cross-checking agents as an escalation (not built), and the three questions for the Darwin rep in `docs/EVENT-DAY.md`.

---

Status of each milestone from `speedhacks-project.md` section 9: what works, what's stubbed, how to run it.

## How to run

```bash
export PATH="$HOME/.nvm/versions/node/v22.23.3/bin:$PATH"
npm install
npm run dev
```

Open http://localhost:3000. The demo target site is served at http://localhost:3000/demo-site/.

> This Mac's `/usr/local/bin/node` is an Intel build that can't run. Always put the nvm Node first on `PATH` (as above). The in-app preview uses `.claude/launch.json`, which does this for you.

Tests (none of them call OpenAI or Darwin):

```bash
npx tsx --tsconfig tsconfig.json scripts/test-audit.ts         # analyzers vs ground-truth.json
npx tsx --tsconfig tsconfig.json scripts/test-llm.ts           # budget caps, caching, judge, adapter, fix plan
npx tsx --tsconfig tsconfig.json scripts/test-darwin-real.ts   # real client against saved fixtures
npx tsx --tsconfig tsconfig.json scripts/test-darwin-mock.ts   # simulated agents
npx tsx --tsconfig tsconfig.json scripts/test-verify.ts        # verification layers
npx tsx --tsconfig tsconfig.json scripts/test-engine.ts        # failover, faults, crash/resume, cancel, baseline
npx tsx --tsconfig tsconfig.json scripts/test-direct.ts        # translation, direct MCP agents, runtime discovery, Option B
npx tsx --tsconfig tsconfig.json scripts/test-discovery.ts     # discovery rules, order, spending limit
npx tsx --tsconfig tsconfig.json scripts/darwin-smoke.ts       # event-day access check (dry run; add --live on the day)
npx tsx --tsconfig tsconfig.json scripts/calibrate-timelapse.ts 30 0.1   # simulated nights, with vs without
npx tsx --tsconfig tsconfig.json scripts/llm-usage.ts          # OpenAI usage counters (makes no calls)
```

## Milestones

| # | Milestone | State |
|---|---|---|
| 1 | Skeleton: Next.js, SQLite, DarwinClient, mock + real clients, demo site + ground truth | Done |
| 2 | Engine: DAG, per-page fan-out, parallel branches, partial-tolerant merge, checkpoints, failover | Done |
| 3 | Verification: 4 layers (format, sanity rules, spot-check, review), swap on silent failure | Done |
| 4 | Live graph UI, step inspector, agents found per step | Done |
| 5 | ~~Setup flow: pick and approve agents up front~~ replaced by runtime discovery: agents found and vetted when a step runs, spending limit for paid agents | Done (Darwin Search path tested with saved results and fakes only) |
| 6 | Chaos mode: random rate + per-step Crash / Hang / Corrupt buttons | Done |
| 7 | Reliability scoring + leaderboard | Done |
| 8 | Overnight time-lapse, with vs without | Done |
| 9 | Run report: fix plan, drafted fixes, issues outlined on the page, timeline | Done |
| 10 | Polish: input adapter, scheduled health checks, crash-resume, README | Done |
| + | Real-agent readiness: translation step, direct MCP connection, simulated fallback, Option B switch, event-day check | Done (see `docs/EVENT-DAY.md`) |

### Verified

- All seven test suites pass (824 checks): audit toolkit vs ground truth (recall and precision 1.0 on the demo site), LLM gateway caps, real Darwin client against saved responses, mock agents, verification layers, the engine (failover, injected faults, crash/resume, cancellation, baseline, concurrency), and real-agent readiness (translation, direct MCP, mixed pools, Option B).
- Independent reviews of every module found and fixed real bugs (e.g. crash/cancel not stopping in-flight branches, resume reusing request keys, an open proxy and script injection in the page overlay, the daily OpenAI cap racing across processes).
- State-changing API requests from other websites are refused (403), so a web page can't make this server start a GPT-reviewed run.
- Crash and resume: a run killed mid-way restored 11 finished steps from checkpoints, re-ran the other 6, and completed.
- Time-lapse calibration (50 nights, 3 pages each, 10% injected failures): without Axolotl 2–7 of 50 reports usable, and about half of the "finished" ones were silently wrong. With Axolotl 49–50 of 50.
- One end-to-end run with GPT review on (2 pages): 9 calls, about 9.5k tokens; every verdict and the GPT-written fix plan came back well-formed.

### Real-agent readiness

- **Translation step** (`src/lib/translate`): reads real agents' answers (axe-core and Lighthouse JSON, Markdown lists and tables, prose, ad-hoc JSON) into the step's format. Findings that match none of the step's checks are dropped and counted, never invented. Tested on six formats with nothing lost or added, and on refusals, mixed categories, injected instructions and secrets. When the rules find nothing, one capped GPT call reads the answer: 2 real calls tested, both exact.
- **Direct connection** (`src/lib/darwin/mcp.ts`): calls an agent's own MCP endpoint (initialize, tools/list, tools/call) when Darwin Search publishes a verified one, or your agent's address (`YOUR_AGENT_MCP_URL`). No Act needed. Refuses plain http, private networks and URLs with credentials; follows no redirects; caps answers at 4 MB. Sign-in or payment walls are reported as blocked, like Act.
- **Local test agents** (`/test-agents/<id>/mcp`): six MCP agents that answer in other tools' formats, for trying all of this without Darwin. They only audit the demo site.
- **Simulated fallback**: a Darwin run tries real agents first, then simulated ones (Settings → Simulated backups). Every step says how its agent ran.
- **Option B** behind `AXOLOTL_MODE=your-agent`: "Your agent" goes first, Darwin agents back it up.
- **Event-day check** (`scripts/darwin-smoke.ts`): tells us within minutes whether Act, direct calls or only Search work.
- **Routing you can explain**: every attempt records why its agent was picked ("Next most reliable free agent found (94% verified over 31 runs)"), shown in the step details. Scores are per capability and start neutral; 10% of the time a less-tested agent goes second, so an early lucky streak doesn't fix the order forever.
- **Reviewed**: an independent review of this work found 8 issues, all fixed and covered by tests: passing answers read as findings, three regexes that could stall the server on huge answers, long direct calls cut off as stalls, gaps in the private-address checks (including names that resolve to private addresses), agent addresses that could reach this app's own API, finished calls kept in memory, no tool picker for agents with several tools, and the event-day script's search cap.
- **Context handoff**: a backup's instruction says which agents failed before it and why, so it doesn't repeat the mistake. Argument mapping ignores the handoff, so it costs no extra GPT calls.

### Known limits

- Real Darwin agents are untested end-to-end (Act needs allowlisted credentials; direct calls need agents with published endpoints). The direct path is tested end to end against the local test agents. Anonymous Darwin Search always reports "unavailable", so discovery ignores readiness for real agents unless Act credentials are set. Darwin takes payment through a hosted checkout a person must complete, so with real agents a spending limit can't actually pay yet: a paid agent that asks for payment is skipped like a sign-in wall. Only simulated paid agents show the full free-then-paid flow.
- The spot-check reads static HTML only; on JavaScript-rendered sites a correct finding whose element isn't in the served HTML can be rejected.
- In dev mode, the stylesheet sometimes doesn't hot-reload; restart `npm run dev` if colors look stale.

## Darwin

- Search works against the public API (no key). Anonymous results always show `readiness: unavailable`; Darwin only checks routes for authorized callers.
- Act is wired to the v3 API (`POST /v3/act` with `targets`, `GET /v3/act/requests/{id}`). It needs `DARWIN_ACCESS_TOKEN` in `.env`, and Darwin must add that credential to its Act pilot allowlist (otherwise `ACT_PREVIEW_ACCESS_REQUIRED`). Details: `docs/darwin/API-NOTES.md`.

## OpenAI usage guardrails

All LLM calls go through `src/lib/llm/gateway.ts` (model `gpt-5.6-luna`):
- caps: 25 calls per server process, 100 per day (persisted in `data/llm-usage.json`), 20 per run;
- one request per call, no retries, 45 s timeout, output token cap;
- identical prompts are cached in SQLite;
- the default judge is rule-based; GPT review only runs when you pick it under Settings. The time-lapse never calls GPT.

## Things only the team can do

- Deploy `demo-site/` publicly so real Darwin agents can reach it: `npx vercel demo-site` (the folder's `.vercelignore` keeps `ground-truth.json` private; check that `<deployed-url>/ground-truth.json` returns 404). Then set `DEMO_SITE_URL=<deployed-url>/` in `.env`. Note Vercel adds HSTS on `*.vercel.app`, which is why that planted issue is marked optional.
- Add Darwin credentials to `.env` and ask Darwin for Act pilot access. Then run the event-day check (`docs/EVENT-DAY.md`).

## MCP server (Oct 11)

Axolotl is also an MCP server at `/api/mcp`, so ChatGPT, Codex or Claude Code can hand it a failing step. Details and hosting: `docs/MCP.md`.

- **Real:** address resolution (Photon, then Nominatim, cross-checked; "castano stanford" → 685 Escondido Road), failure triage, Darwin Search, and the audit run tools.
- **Simulated (labelled in every answer):** food-delivery platforms and carts. Nothing is ever ordered or charged.
- **Tested:** `scripts/test-mcp.ts` (16 checks, fake and `--live`). One real `claude -p` run with only this MCP connected took the one-shot crêpe prompt to a verified cart. A single call takes about 2 s.
- **Auto-trigger:** `integrations/hooks/axolotl-stop-hook.mjs`, a Stop hook for Claude Code and Codex. Not installed anywhere yet.
- **Pending:** switch `findAgents` to `engine/discovery.ts` (`discover` + `orderRoute`) once the `runtime-discovery` branch is merged.
