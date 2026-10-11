# Axolotl UI guide

Axolotl is demoed live to investors. The UI should read like a friendly, well-made product: light, calm, simple. Someone who has never seen it should understand each screen in a few seconds.

## Rules

- **Light theme.** Off-white page, white surfaces, soft gray hairlines. Use only the tokens in `src/app/globals.css` (Tailwind classes like `bg-panel`, `text-ink`, `text-muted`, `border-line`, or `var(--s-passed)` etc.). Never hardcode hex colors in components.
- **One accent.** Axolotl pink (`--regrow`) marks recovery (a backup taking over) and the brand. State colors only carry meaning: running blue, checking amber, done green, failed red, partial orange.
- **Regular font everywhere** (Inter). No monospace for UI text, names, or numbers. `font-mono` only inside code blocks. Numbers use the `tabular` class.
- **Less information.** Each view leads with one headline and at most three key numbers. Plain words ("Switched to a backup", "Bad output caught", "Hours saved"), not codes. IDs, idempotency keys, seeds, raw outputs, layer reasons and rule codes go behind a "Details" disclosure.
- **No uppercase letter-spaced micro-labels.** Labels are normal-case, 12–13px, `text-muted`.
- **Shape**: 8–10px radii on cards, 1px `border-line`, a very soft shadow at most. No gradients, glassmorphism, emoji, or decorative grids.
- **Motion with meaning**: things running pulse, failures flash, a backup "regrows" in pink, numbers count up. Use the keyframes in `globals.css` (`anim-pulse`, `anim-flash`, `anim-regrow`, `anim-rise`, `scanbar`).
- Layout fills the viewport below the top bar with internal scrolling. Must work from ~800px wide (the in-app preview) up to 1440px.

## Building blocks

- `src/components/ui/primitives.tsx`: `Button` (tones default/primary/danger/ghost/regrow), `Segmented`, `Toggle`, `Chip`, `SectionLabel`, `Meter`, `Empty`, `Stat`, `Details`.
- `src/components/ui/tokens.ts`: state/outcome/severity colors and plain-language labels, `fmtMs`, `fmtClock`, `shortPath`.
- `src/components/store.tsx`: `useAxolotl()` → `{ state, actions }`.
- `src/components/api.ts`: typed fetch wrappers for every route in `src/app/api`.
- Reference: `src/components/run/*`.

## Charts

Recharts 3 is installed. Minimal: light gridlines in `--line`, 11px `--muted` axis text, at most two series, direct labels instead of legends.
