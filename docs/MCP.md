# Axolotl MCP server

Axolotl runs as an MCP server at `<base>/api/mcp`. Any MCP host (ChatGPT, Codex, Claude Code) can hand it
a failing step. It is stateless JSON-RPC over Streamable HTTP and needs no extra dependencies.

## Tools

| Tool | What it does | Real or simulated |
|---|---|---|
| `axolotl_resolve_place` | "Salesforce Tower" → 415 Mission Street, San Francisco, CA 94105, confirmed by two map services. When the maps don't know a place, it has the host run a web search and checks the result on the map (`address_hint`) | Real (Photon, Nominatim, the host's web search) |
| `axolotl_add_to_cart` | Resolves the delivery place, then returns an ordered plan that uses the host's OWN tools (pass them in `host_tools`): a delivery plugin with a cart tool, then plugin search + the host's browser, then delivery sites in the browser. `simulate: true` uses Axolotl's simulated agents instead (demos only) | Real: the host builds a real cart. Axolotl can't call other plugins itself, so it plans and verifies |
| `axolotl_verify_cart` | Checks the cart the host read back: right item, delivering to the resolved address, under budget, not checked out. Fail = take the next route | Real |
| `axolotl_checkout` | Marks a simulated cart as ordered. Real carts are checked out by the person | Simulated only |
| `axolotl_recover` | Takes a goal and a failure text; returns the failure type, the next step and Darwin alternatives | Real (rules plus Darwin Search) |
| `axolotl_find_agents` | Darwin Search vetted by the engine's routing rules (`discover` + `orderRoute`): agents that can run now in try order, plus the ones left out and why. Takes `budget_cents` | Real |
| `axolotl_start_site_audit` / `axolotl_get_run` | Starts and reports on the self-healing website audit. The live graph is on the Run screen | Same as the app (simulated agents by default) |

Providers run cheapest reliable first: free, then Darwin, then simulated. Every answer lists each provider tried, how it ended, and why.
Recent calls with their traces: `GET /api/mcp/calls`.

## Hosting

The server runs inside the Next app, so whatever serves the app also serves MCP.

**Local (Claude Code, Codex):** `npm run dev`, then connect to `http://localhost:3000/api/mcp`.

- Claude Code: `.mcp.json` in this repo already registers it. Restart Claude Code here and approve `axolotl`.
- Codex: add to `~/.codex/config.toml`:
  ```toml
  [mcp_servers.axolotl]
  url = "http://localhost:3000/api/mcp"
  ```

**Public (ChatGPT, or a judge's laptop):** ChatGPT connectors need public HTTPS. Use a Cloudflare quick tunnel:

```bash
export AXOLOTL_MCP_TOKEN=$(openssl rand -hex 16)   # set in .env, restart npm run dev
cloudflared tunnel --url http://localhost:3000
```

Use `https://<random>.trycloudflare.com/api/mcp?key=<token>` as the connector URL. In ChatGPT, turn on developer mode, add a connector, choose "No authentication", and paste that URL.
The tunnel exposes the whole app, not just `/api/mcp`, so only run it while you demo. The quick-tunnel URL changes on every restart.

Vercel isn't a good fit today: the engine keeps live runs in memory and uses SQLite (better-sqlite3).

## Auto-trigger (hooks)

`integrations/hooks/axolotl-stop-hook.mjs` is a Stop hook for Claude Code and Codex. When the agent ends a turn by giving up
("I can't add items to your cart") or by asking for something a lookup could answer ("what's your street address?"),
the hook blocks the stop once and tells the agent to call `axolotl_recover`. It never loops (it respects `stop_hook_active`) and never breaks the host.

Claude Code (`~/.claude/settings.json` or a project's `.claude/settings.json`):
```json
{ "hooks": { "Stop": [ { "hooks": [ { "type": "command", "command": "node /ABS/PATH/integrations/hooks/axolotl-stop-hook.mjs" } ] } ] } }
```
Codex (`~/.codex/hooks.json`): add the same command under `"Stop"`.

## Tests

```bash
npx tsx --tsconfig tsconfig.json scripts/test-mcp.ts          # fake map sources
npx tsx --tsconfig tsconfig.json scripts/test-mcp.ts --live   # real Photon / Nominatim / Darwin
```
