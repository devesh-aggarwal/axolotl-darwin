# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary: a developer or engineering lead who leaves multi-step agent workflows running overnight and checks on them in the morning. They want to know at a glance what failed, what recovered on its own, and what still needs them, without reading logs.

Secondary: hackathon judges watching a roughly 3-minute live demo, often on a projector. Failure and recovery must be readable from across a room. Operator needs come first; demo legibility is a constraint on top of them, not a replacement.

## Product Purpose

Axolotl runs multi-step agent workflows on top of Darwin and repairs them on its own. When an agent errors, hangs, asks for a login mid-run, or returns output that looks fine but is wrong, Axolotl finds another agent that can do the job through Darwin, vets it automatically, verifies the new answer, and keeps going. Nobody approves agents ahead of time. Branches that didn't fail never stop.

Success: the operator wakes up to a finished result and an honest account of every failure and recovery along the way.

## Positioning

Self-healing at the step level: replacement agents are found and vetted at run time, so a 3am failure never waits for a person, and every answer is verified (format, sanity rules, spot-checks against the live page, optional LLM review) before the workflow moves on.

## Operating Context

- Demo workflow: an overnight pre-launch website audit. Crawl, then per-page accessibility and performance audits plus SEO, security-header and broken-link checks, then merge, prioritise, and a fix plan with drafted fixes.
- Four screens: Run (live workflow graph, the agents found for each step and the ones left out, chaos and fault buttons, crash/resume, a spending limit for paid agents), Overnight (a compressed night of runs, with and without Axolotl), Leaderboard, labelled "Rankings" in the nav (agent reliability and trust verdict per capability), Report (fix plan, drafted fixes, issue overlay on the real page, failure/recovery timeline).
- Two modes: `workflow` (Option A) and `your-agent` (Option B: the user's agent first, Darwin agents as backups).

## Capabilities and Constraints

- Next.js 16 app, React 19, Tailwind 4, React Flow graph, Recharts, SQLite.
- Agents can be simulated (MockDarwinClient, seeded and deterministic) or real Darwin agents. Simulated runs are labelled as such in every run, and that labelling must stay.
- The demo target site (`demo-site/`, `src/app/demo-site`) contains deliberately planted defects that serve as ground truth (`ground-truth.json`). It is not product UI and must not be "fixed".
- Undecided: whole-job handoff for Option B; cross-checking agents as an escalation path.

## Brand Commitments

- The name "Axolotl" is fixed. Everything else about the look is open: the current interface is evidence, not a committed system. The regeneration idea may inform the design but is not required.

## Evidence on Hand

- Real: Darwin Search results, verification layers, the seeded demo site and its ground truth.
- "Found 26 of 26 planted issues" comes from simulated agents. It proves the checks, not agent quality, and must not be presented as a benchmark against other tools.
- No customers, testimonials, or production metrics exist. Do not invent them.

## Product Principles

1. Honesty over reassurance: show what failed, what was swapped, and what was simulated, plainly.
2. The morning glance: the state of a whole night should be readable in seconds.
3. Recovery is the story: failure and regrowth are the moments the UI exists to make visible.
4. Nothing interrupts a healthy branch: that holds visually as well as mechanically.
