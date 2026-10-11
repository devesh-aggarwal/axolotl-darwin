---
target: all five screens
total_score: 25
max_score: 40
na_heuristics: 
p0_count: 1
p1_count: 5
target_identity: "file:/Users/devesh/code/axolotl-darwin/src/app/page.tsx"
target_fingerprint: "sha256:f98143e70079a1d33f7d8ca71d6f08449744b1eccd5852ce0793eb3f8ff69bad"
target_path: /Users/devesh/code/axolotl-darwin/src/app/page.tsx
timestamp: 2026-10-11T18-57-35Z
slug: src-app-page-tsx
---
# Critique: Axolotl app, all five screens (Run, Setup, Overnight, Leaderboard, Report)

Method: dual-agent (A: design review, B: detector + browser overlay)

## Design Health Score
| # | Heuristic | Score | Key Issue |
|---|---|---|---|
| 1 | Visibility of System Status | 2 | Stale "Running" shown while live updates are disconnected; only a 7px dot says Offline |
| 2 | Match System / Real World | 3 | Plain failure phrases; engine terms leak in details |
| 3 | User Control and Freedom | 3 | No way to stop a live run |
| 4 | Consistency and Standards | 2 | "Simulated" / "Mock catalog" / "Simulated backup"; three different Stat components |
| 5 | Error Prevention | 3 | Site URL never validated |
| 6 | Recognition Rather Than Recall | 3 | Simulated vs real hidden in Settings popover |
| 7 | Flexibility and Efficiency | 1 | No shortcuts; nodes not keyboard reachable |
| 8 | Aesthetic and Minimalist Design | 3 | Calm, but hierarchy too flat for a morning glance or projector |
| 9 | Error Recovery | 3 | Good messages; error toasts vanish in 4.5s |
| 10 | Help and Documentation | 2 | Score formulas and hints live only in title tooltips |
| **Total** | | **25/40** | **Acceptable** |

## Design Specificity Verdict
Mostly category-interchangeable devtool dashboard (Inter + JetBrains Mono, warm grey, 10px soft-shadow cards, dotted React Flow canvas). Authored moments: pink regrow accent, clip-path regrow animation, night-strip regrowth ticks, plain story copy. The brand colour is spent twice: --s-swapping === --regrow (#e2559b), so "in trouble" and "healed" look identical.
Detector: 1 CLI finding (side-tab, ReportHeader.tsx:151). Browser overlay: systemic contrast failures (--faint #a3a29b at 2.4-2.6:1; idle #c4c2bb status text at 1.8:1; pink, green, orange status text 2.8-3.6:1 on white; --muted 4.2-4.47:1 on off-white panels), overused-font Inter, flat type hierarchy on Setup and Rankings, body text 14px from viewport edge on Rankings.

## Priority Issues
1. [P0] Simulated runs unlabelled on Run, Overnight headline and Leaderboard (PRODUCT.md requires labelling). Fix: persistent run-source badge, qualify recall line, label leaderboard pools. clarify, harden.
2. [P1] Morning glance not designed: "Human interventions" is a binary third stat; needs-you is buried. Fix: needs-you first and largest, count stuck steps. layout, distill.
3. [P1] Failure/recovery not legible at distance; swapping and recovered share one colour; recovery leaves no trace. Fix: separate swapping colour, persistent healed mark, bigger card type. bolder, colorize, animate.
4. [P1] Stale live state when disconnected. Fix: paused banner, stop live animations, refetch run on reconnect. harden.
5. [P1] 390px: two tabs unreachable; Report category control overflows. adapt.
6. [P2] Overnight reads as staged: without side always red; hours are an assumption shown as measurement. clarify.
7. [P1] Contrast failures across all screens (detector). colorize, polish.

## Persona Red Flags
Alex: no shortcuts, nodes not in tab order. Sam: colour-only status, faint text at 2.5:1, hints only in title. Morning operator: lands on Live run, may see stale Running, cannot tell simulated from real.

## Minor Observations
"Proof" label reads disabled; × glyph sizes vary; Report px-8 vs px-4 elsewhere; vendor model name exposed; sparkline always muted.

## Questions to Consider
- Should a healed node stay visibly scarred for the rest of the run and in the Report?
- Should the app open on last night's result rather than the live graph?
- Would you defend "7 h saved" and a red 96% to a sceptical judge?
