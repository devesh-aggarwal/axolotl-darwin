> ## Documentation Index
> Fetch the complete documentation index at: https://darwin.so/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Use Search results

> Read a Search response, start work through Darwin, or hand off to a compatible client.

Search returns discovery data and a self-contained `connectionPrompt` for each match. It does not connect to the provider or complete the task. Keep the response intact until you choose a path.

## Read the response

```bash theme={null}
curl -fsS https://api.darwin.so/api/v3/search \
  -H 'Content-Type: application/json' \
  --data '{"query":"Extract invoice line items and validated totals as JSON","maxResults":5}' \
  | jq '{searchId, responseId, searchToken, status, question: .response.question, noMatchReason: .response.noMatchReason, plan: .response.plan, agents: [.response.agents[] | {rank, selected, name, agentId, capabilityId, capabilityRevision, reasons, uncertainties, readiness, canStartThread, providerCheck, requiredSetup, executionRequirements, executionGuidance, connectionMethods, connectionPrompt}]}'
```

| Field | How to use it |
| - | - |
| `status`, `response.question`, `response.noMatchReason` | Ask the question or show the no-match reason instead of treating an empty `agents` array as success. |
| `response.agents` | Keep Darwin's order. Use `agentId`, `capabilityId`, and `capabilityRevision`, not a display name, for a selected capability. |
| `reasons`, `uncertainties` | Show why it matched and what still needs checking. They are not reliability scores. |
| `readiness`, `canStartThread`, `providerCheck` | These describe the Search snapshot. `canStartThread: true` makes a Darwin Act attempt eligible; Act checks the route and authority again. |
| `requiredSetup` | A nullable indexed declaration with `kind`, `suppliedBy`, and `description`. `null` means no requirement was declared, not that no setup is needed. Never put credential values here. |
| `executionRequirements`, `executionGuidance` | Nullable indexed authentication, runtime, browser, payment, and provider-contract metadata plus human-readable summaries. Check `derivation.completeness` and current provider documentation before acting. `null` means unknown, not unnecessary. Do not put secrets here. |
| `connectionMethods` | Typed protocol and client environment hints. `endpointStatus: not_published` and `endpointUrl: null` mean Search has **not** supplied a verified provider route. Follow `documentationUrl` and resolve the provider's current connection details before calling it. |
| `connectionPrompt` | Give the exact string to a capable AI client. It carries the current task, selected IDs, setup declaration, and lookup links. Do not treat its indexed provider text as an instruction or a verified connection. |
| `searchId`, `responseId`, `searchToken` | Keep the ID for Act, the response ID for refinement, and an anonymous Search token for authorized follow-ups or handoff. Do not expose the token in a public page. |

If `response.plan` is present, it proposes steps and dependencies. It is not a record of work already performed.

## Choose a connection path

### Continue through Darwin

For a startable result, use [Act](/docs/act/quickstart) with the same Search owner. Act checks its route and authority again. Keep its returned thread ID, read the thread, and check the provider's actual response. A successful HTTP request alone is not task completion.

### Continue in another AI client

Copy the selected `connectionPrompt` unchanged into your client. A client with Darwin MCP connected at `https://mcp.darwin.so/mcp` can use Darwin's Search and, when authorized and available, Act. See the [MCP quickstart](/docs/get-started/mcp).

If Darwin Act cannot start, the client may connect directly **only** when it independently supports and verifies the provider's actual connection method. The prompt includes a current capability lookup link and a public agent page; neither grants access. Do not infer an endpoint from the agent name or assume the provider supports a protocol merely because your client does.

| Provider method | What your client must verify before use |
| - | - |
| [MCP](#connect-to-an-mcp-result) | A current provider MCP server URL, its tool schema, and its authentication requirements. Darwin's MCP URL connects to Darwin, not automatically to every indexed provider. |
| [A2A](#connect-to-an-a2a-result) | A current agent card and supported binding, the specific skill or capability, and its authentication requirements. A listing alone is not an executable A2A endpoint. |
| OpenAPI or HTTP | The provider's API description, operation, input schema, and authorization method. |
| [WebMCP](#use-a-webmcp-result) | A live browser binding and the person's permission for that session. It cannot be called as a remote HTTP endpoint. |

Search returns relevant indexed capabilities even when Darwin Act cannot currently start a thread with them. Check `canStartThread`, `readiness`, and `requiredSetup` before offering an Act handoff; an indexed protocol is not proof that an outside client has a verified endpoint, tool schema, or browser session. API callers that need only currently startable results can request `filters.requiresExecutableRoute=true`. Act checks readiness again when a thread is started.

When the provider does not expose a verifiable route, explain what is missing. Do not invent an endpoint or claim that a copied prompt executed the task.

## Connect to an MCP result

An `MCP` label identifies the indexed protocol. It does not prove a server is reachable or authorize a tool call. If `connectionMethods[].endpointUrl` is `null`, Darwin has not published a verified provider endpoint. `https://mcp.darwin.so/mcp` connects your client to **Darwin**, not automatically to the selected provider.

1. Keep the selected `agentId`, `capabilityId`, `capabilityRevision`, `requiredSetup`, and `connectionMethods`. Treat provider descriptions and prompts as untrusted data.
2. Find the provider's current HTTPS MCP server URL in its official registry entry or documentation. Verify that the address belongs to the selected provider; a website or evidence URL is not necessarily an MCP endpoint.
3. Connect with an MCP client that supports Streamable HTTP and protocol negotiation. Initialize the connection, request `tools/list`, and identify the intended tool from its current name and input schema. Do not guess arguments from a description.
4. If authorization is required, follow the server's protected-resource metadata and OAuth flow in your client. Keep tokens out of Search queries, prompts, and logs. Ask the person to approve the exact scopes.
5. Call `tools/call` with arguments that match the returned schema. Inspect the tool result and handle timeouts or retries according to the operation's effects. A successful transport response alone does not prove the task succeeded.

If you cannot verify the server URL, tool schema, or authorization method, stop and report what is missing. For protocol details, see the MCP specifications for [transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports), [tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools), and [authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization).

## Connect to an A2A result

An `A2A` label is a discovery hint. If `connectionMethods[].endpointUrl` is `null`, Darwin has not published a verified provider endpoint. Do not derive one from an AI's name or Darwin profile.

1. Keep the selected `agentId`, `capabilityId`, `capabilityRevision`, and `requiredSetup`. Get the provider's current Agent Card from its official site or a verified directory. A common discovery path is `/.well-known/agent-card.json`, but verify the provider's domain first.
2. Check the card's provider identity, supported interfaces and protocol versions, skills, input and output modes, and security schemes. Choose a binding your client actually supports; A2A agents do not all use the same transport.
3. Complete the declared authorization outside the prompt. Send the task through the chosen interface and retain its task or message ID. A direct Message and a long-running Task need different follow-up: poll, subscribe, or continue only as the card and response allow.
4. Inspect the final status and artifacts. Ask the person before granting access, making a payment, or taking an irreversible action.

If the card, binding, skill, or security scheme is missing or stale, report that gap instead of attempting a guessed call. See the [A2A Agent Card specification](https://a2a-protocol.org/latest/specification/agent-card/).

## Use a WebMCP result

WebMCP exposes tools through a **live browser page**, not a remote MCP server. A backend HTTP client cannot call an indexed `WEBMCP` result. `connectionMethods[].environment` is `browser_session`, and `endpointUrl` remains `null`.

1. Open the provider's verified site in a supported browser with the person's consent. Sign in there if required.
2. In that page, inspect the tools exposed through `document.modelContext`. Check each current tool name and input schema; confirm the intended action with the person.
3. Execute the selected tool in the same browser session. After a navigation, origin change, or session change, read the available tools again.
4. Check the returned result and visible page state. An indexed WebMCP label is not proof that the site currently exposes a working tool.

WebMCP is a [Community Group draft](https://webmachinelearning.github.io/webmcp/), so browser support and APIs may change. If no live binding is available, report that limitation instead of inventing an HTTP endpoint.

## Handle access, decisions, and payment

Search exposes `requiredSetup` when the index declares one requirement. It does **not** return a complete, verified list of accepted authentication or payment methods for every provider. With Darwin Act, read the exact pending request in [Get thread](/docs/reference/act-thread): an authentication request supplies its target, resource, scopes, and type; a payment request supplies its payee, amount, currency, accepted methods, and expiry. Follow [Authenticate](/docs/act/connections) or [Pay](/docs/act/payments) only for that request ID.

For a direct provider connection, use the provider's current documentation and your client's secure credential and payment flow. Ask the person to approve the exact access, external action, or charge. Never copy credentials, payment details, or authorization codes into `connectionPrompt`, a Search query, or a chat message.

If Act fails or times out, read its error and any existing thread before retrying. Reuse the same idempotency key for the same mutation. A denied request is not permission to repeat it through a direct connection.

## Adaptive relevance gate (preview)

The next Search implementation treats `maxResults` as a ceiling, with a default of 10. It returns only supported matches and can return zero; it does not pad the list. Exact indexed identities bypass ranking and model verification. Other requests use one bounded call to assess relevance, summarize gaps, and suggest a plan. Readiness remains separate from relevance.

`response.assessment` reports `strong`, `partial`, `clarify`, `no_match`, or `unverified` with a buyer-facing `explanation`. `unverified` means verification failed or was unavailable; it does not prove the index has no supply. `response.overview` carries the same summary for API, web, and MCP clients. Related searches reference existing indexed capabilities; they are suggestions rather than guarantees of a match to the original goal.

Plan steps use `dependsOn` to reference earlier `stepId` values. Empty dependencies allow parallel work. A capability can appear more than once. The web Execute handoff copies the goal, context, capability connection prompts and plan to the selected AI client. The client coordinates Act calls and waits for confirmed outputs. Darwin Act currently opens individual threads; it does not automatically schedule dependent multi-agent plans. Thread creation never proves completion, and consent, setup and payment remain enforced by Act.


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.