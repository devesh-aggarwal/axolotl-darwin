<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## UI work uses Impeccable

All frontend changes go through the Impeccable skill (`.claude/skills/impeccable`, from https://impeccable.style). Product context lives in `PRODUCT.md`.

- Before editing UI, load the skill and run `.claude/skills/impeccable/scripts/impeccable context`; read `reference/craft-floor.md` before the first edit.
- After UI changes, run `.claude/skills/impeccable/scripts/impeccable detect <changed files>` once and fix what it finds.
- `demo-site/` and `src/app/demo-site/` are deliberately broken audit targets. They are excluded in `.impeccable/config.json`; never "fix" them.
