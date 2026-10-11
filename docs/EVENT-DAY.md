# Event day

Everything below is built and tested. On the day we plug in what Darwin gives us and pick a story.

## 1. Pick the story (one setting)

| | Option A (default) | Option B |
|---|---|---|
| Story | A workflow built from Darwin agents; when one fails, Axolotl finds and vets another through Darwin | Your own agent goes first; Darwin agents take over when it fails |
| Setting | nothing (or `AXOLOTL_MODE=workflow`) | `AXOLOTL_MODE=your-agent` in `.env`, then restart |
| Tried first | the most reliable agent Darwin finds for the step | "Your agent" (a simulated stand-in), or your real agent at `YOUR_AGENT_MCP_URL` |

Both use the same engine, discovery, checks, failover and screens; only the wording and the first agent change. Wording lives in `src/config/mode.ts`.

To fully commit to one later, ask: "We picked A (or B): make it the only story and remove the other mode's wording."

## 2. Find out what Darwin's access actually allows (5 minutes)

Put what Darwin gives you in `.env`:

| Darwin gives us | Variable | Unlocks |
|---|---|---|
| Application API key | `DARWIN_API_KEY` | Search only (Search already works without it) |
| User token with `human:actions`, on the Act allowlist | `DARWIN_ACCESS_TOKEN` | Running Darwin agents through Act |
| Credits | none | Paying for usage; doesn't unlock Act by itself |

Then run:

```bash
npx tsx --tsconfig tsconfig.json --env-file=.env scripts/darwin-smoke.ts --live --act --call
```

It runs 6 searches, starts at most one Act thread and makes at most one direct tool call, then says which path works. It never prints credentials. Without `--live` it does a dry run on this machine.

Ask the Darwin rep at kickoff:

1. Does Assist handle a failed agent today (swap, retry elsewhere, check the result)?
2. Would they rather see a reliability layer for Darwin workflows (A) or a fallback that brings outside agents' work to Darwin (B)?
3. Can we get Act access and a user token? An application or search key alone can't run agents. If not: which agents have verified MCP endpoints we can call directly?

If we only get Search, say so if judges ask: runs search live Darwin, and execute on our own harness.

## 3. Three ways real agents can run

1. **Act works:** start a run with Agents = Darwin. Each step searches Darwin and runs what it finds through Act.
2. **No Act, but agents with endpoints:** search results marked "can run directly" run over MCP at their own address, without Act. You can also paste a provider's documented MCP address under "Add an agent by its address".
3. **Search only:** each step shows the real Darwin results it found and why it couldn't call them; runs use simulated agents and say so on every step ("Simulated agent").

In every case, turn on **Simulated backups** (Live run → Settings, on by default): real agents go first, and simulated ones finish a step only if all the real ones fail. If a real agent fails on stage, the backup takes over, which is the pitch.

## 4. Before any real agent runs

- Deploy the demo site so real agents can reach it: `npx vercel demo-site`, check `<url>/ground-truth.json` returns 404, then set `DEMO_SITE_URL=<url>/` in `.env` and restart.
- Real agents answer in their own formats. The translation step reads axe-core and Lighthouse JSON, Markdown, tables, prose and ad-hoc JSON. When its rules find nothing, it asks GPT once (only when "GPT review" is on, within the usual caps). Each step shows how the answer was read.

## 5. Try it now, without Darwin

Axolotl ships six local test agents (one per step, at `/test-agents/<id>/mcp`) that speak MCP and answer in other tools' formats. `scripts/test-direct.ts` runs the whole workflow on them as if Darwin Search had found them. There's no screen for adding agents by hand any more (agents are found at run time); for Option B, `YOUR_AGENT_MCP_URL` points "Your agent" at any MCP address.

## Checks

```bash
npx tsx --tsconfig tsconfig.json scripts/test-direct.ts       # translation, direct MCP, runtime discovery, Option B (no network)
npx tsx --tsconfig tsconfig.json --env-file=.env scripts/llm-translate-smoke.ts   # 2 real GPT calls, cached after
```
