# Darwin integration notes

Source of truth: `docs/darwin/openapi-v3.json` (server `https://api.darwin.so/api`).
Client: `src/lib/darwin/real.ts`. Payload mapping: `src/lib/darwin/normalize.ts`.
Offline tests (no network, saved responses in `fixtures/darwin-search/`): `npx tsx --tsconfig tsconfig.json scripts/test-darwin-real.ts`.

## Endpoints used

| Purpose | Request | Auth |
|---|---|---|
| Search | `POST /v3/search` with `{ query, maxResults }` (+ `previousResponseId` when refining) | none required |
| Start a thread | `POST /v3/act` with `{ targets: [{ agentId, capabilityId, arguments? }], message }` and an `Idempotency-Key` header (`arguments` only when non-empty) | `Authorization: Bearer` |
| Read a thread | `GET /v3/act/requests/{actRequestId}?includeThreadState=true&threadId=…&cursor=…&limit=100` | `Authorization: Bearer` |
| Cancel | `POST /v3/act` with `{ threadId, message: { type: "cancellation_request", operationId } }` (best effort) | `Authorization: Bearer` |

Not used: `GET /v3/search/{searchId}` and the `searchId` handoff to Act. The `targets` start opens a thread with a pre-approved pool agent without a fresh search, so it needs neither the search owner's credential nor `X-Search-Token`.

## Auth model

- **Search is public.** Anonymous responses carry a `searchToken`. The client keeps it in an in-memory map keyed by `searchId` (server side only) and never logs it or sends it to the browser.
- Search credentials, in order: `DARWIN_ACCESS_TOKEN` as a bearer token (so readiness reflects the caller Act will run as), else anonymous. `DARWIN_API_KEY` is not sent: Darwin says application keys aren't working yet. A 401 on Search, or a 403 outside a `previousResponseId` continuation, is retried once anonymously.
- **Act is a pilot preview.** It needs a credential whose ID is on Darwin's Act allowlist: an OAuth access token with a live `human:actions` grant (the spec also allows a user API key with `agent:write`; we only use the bearer token for Act). Everyone else gets `403 ACT_PREVIEW_ACCESS_REQUIRED`.

## Search result mapping

- `response.agents[]` → `AgentCandidate`, in Darwin's order, capped at `maxResults` (default 8; the spec allows 1–20).
- `readiness`, `canStartThread`, `providerCheck`, `reasons`, `uncertainties`, `requiredSetup` and `connectionPrompt` pass through unchanged.
- `provider`: v3 has no provider or publisher field. The display label comes from the `agentId` prefix (`mcp-agent:`, `protocol-agent:`, `a2a…`), then `executionRequirements.runtime.kind`, then `connectionMethods[0].protocol`, else "Darwin listing".
- `argumentSchema` is always `null`. The spec only reports whether a schema exists (`executionRequirements.providerContract.inputSchema` is `CONCRETE | DIGEST_ONLY | MISSING | UNKNOWN`); it never returns the schema itself.
- `capability` comes from the caller, otherwise it is inferred from the query.
- `note`: for `no_match`, `noMatchReason` (else `assessment.explanation`); for `needs_input`, the explanation plus Darwin's question; otherwise `assessment.explanation`.

## Thread state → task status

The client keeps each thread's state across reads: messages keyed by id and errors keyed by event accumulate. Actions and requests are current state (Darwin loads them regardless of the cursor page), so each poll replaces them with what its pages return; a request that disappears no longer blocks. Each poll reads every page while `hasMore` is true, up to 5 pages. The first matching rule below decides the status:

| # | Thread state | `TaskPoll` |
|---|---|---|
| 1 | thread `errorCode` | `error` (that code) |
| 2 | pending `authentication_request` / `authentication_required` | `blocked: authentication` |
| 3 | pending `payment_request` | `blocked: payment` |
| 4 | pending `approval_request` or `action_request` | `blocked: approval` (Axolotl never auto-confirms or pays) |
| 5 | `errors[]` entry with `retryable: false` | `error` (its `code`; the message names the event and action) |
| 6 | action `failed` / `cancelled` / `withdrawn` | `error` `ACTION_<STATUS>` |
| 7 | latest `result` message from `agent` | `completed`; output = `data` (JSON inside a string `data` is parsed), else JSON in the text (first fenced block that parses, else the whole text, else the longest balanced object/array), else the text |
| 8 | our message `failed`, thread `archived`, request status `failed` | `error` (`MESSAGE_DELIVERY_FAILED`, `THREAD_ARCHIVED`, `ACT_REQUEST_FAILED`) |
| 9 | anything else | `running` (progress = latest action status or agent reply) |

`raw` on a completed poll is the accumulated thread state with any secret-looking keys removed.

## Errors

| Condition | Result |
|---|---|
| No `DARWIN_ACCESS_TOKEN` | `DarwinApiError` `ACT_NOT_CONFIGURED` (no request is sent) |
| Empty or over-32,000-character instruction | `DarwinApiError` `INSTRUCTION_EMPTY` / `INSTRUCTION_TOO_LONG` (no request is sent) |
| `403 ACT_PREVIEW_ACCESS_REQUIRED` | `DarwinApiError` explaining the allowlist |
| 400 / 401 / 403 / 404 / 409 | `DarwinApiError` with `code` from the `{ code, message }` body |
| `errorCode` on the start receipt | `DarwinApiError` with that code |
| 429 | `DarwinTransportError` (message includes `Retry-After`) |
| 5xx, 408, network failure, 20 s timeout, non-JSON success body | `DarwinTransportError` (the engine retries once with the same `Idempotency-Key`) |

While polling, non-transport errors come back as `error` polls and are not thrown. Error messages are redacted: configured credentials, search tokens, and bearer-, JWT- or key-shaped strings are removed.

## Configuration

- `DARWIN_ACCESS_TOKEN`: an allowlisted OAuth token with `human:actions`. Real runs (Act) require it.
- `DARWIN_API_KEY`: currently ignored; Search runs anonymously until Darwin's application keys work.
- `DARWIN_API_BASE_URL`: optional. The default is `https://api.darwin.so/api`.
- `AXOLOTL_CLIENT=real` makes the real client the default for new runs.

`healthCheck` reports configuration only. Without a token it returns `unverified` and not ready. With a token it returns `unverified` and ready, because Act checks route readiness when a thread starts and v3 has no readiness endpoint.

## Without Act: direct MCP connections

Darwin's docs (`search-using-results.md`) allow connecting to a provider outside Act when the client verifies the route itself. Axolotl does this only for:

- `connectionMethods[]` entries with `protocol: "MCP"`, `environment: "remote_client"`, `endpointStatus: "verified"` and an https `endpointUrl` (`verifiedMcpEndpoint` in `normalize.ts`). `not_published` endpoints, A2A and WebMCP (browser-only) are ignored;
- addresses entered by hand in Setup (a provider's documented MCP URL), and Axolotl's local test agents.

`McpDirectClient` (`src/lib/darwin/mcp.ts`) follows the documented sequence: `initialize`, `notifications/initialized`, `tools/list`, then `tools/call` with arguments mapped onto the tool's `inputSchema`. It handles JSON and SSE responses, keeps the `Mcp-Session-Id`, and closes the session afterwards. HTTP 401/403 is reported as an authentication block and 402 as a payment block (Axolotl never pays); 5xx and network errors are transport errors (retried once). It refuses plain http (except this app's own address), private networks and URLs with credentials, and follows no redirects. Unlike Act, direct agents get a real health check (connect and list tools).

Real agents answer in their own formats, so every real or direct answer goes through the translation step (`src/lib/translate`) before verification.

## Known gaps and inconsistencies

- **`filters`.** The Search docs mention `filters.requiresExecutableRoute`, and SDK docs describe `filters` and `startThread`-style shapes. The v3 REST schemas are closed: the live API answers `filters` with `400 SEARCH_REQUEST_INVALID`, and Act takes exactly one of `searchId`, `targets` or `threadId`. We send only spec'd fields.
- **Anonymous readiness.** Anonymous searches return `readiness: "unavailable"`, `canStartThread: false` and `providerCheck: "not_attempted"` for every agent, because readiness is only checked for authorized callers. Pool approval must not rely on these values for anonymous results.
- **No argument schema.** Structured arguments can't be validated, so threads open text-only and results arrive as text that we parse.
- **Action confirmation.** When `arguments` are sent, Darwin creates an `action_request` that needs an `action_confirmation`. Axolotl reports it as blocked (approval) and does not confirm it.
- **Untyped Act error bodies.** The spec doesn't type Act 400/403/503 bodies. We read the shared `Error` schema (`{ code, message }`).
- **Cancellation id.** For `cancellation_request`, `operationId` is the pending action's id (`actions[].action`). The spec doesn't spell out this mapping.
- **Cursor scope.** The cursor pages messages (and `errors`, which the spec calls "error events in this page"). Actions and requests are treated as current state: the first page of each poll replaces them, later pages of the same poll add to them.
- **v2 spec.** `openapi-act-v2.json` points at a non-routable placeholder server. We don't use it.
