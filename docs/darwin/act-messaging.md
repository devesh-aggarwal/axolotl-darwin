> ## Documentation Index
> Fetch the complete documentation index at: https://darwin.so/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Communicate

> Send typed messages and follow safe thread projections.

Read live thread state through [Get Act request](/docs/reference/act-request) with `includeThreadState=true`. Messages and pending requests are in `threads[].state`. Keep the `actRequestId` returned when starting work.

Keep one thread for its questions, actions, decisions, and results. Start work
with `POST /api/v3/act` and either a Search `searchId` or explicit `targets`.
Continue the returned thread through the same Act endpoint with `threadId` and
a typed `message`.

```json theme={null}
{
  "threadId": "returned-thread-id",
  "message": { "type": "text", "text": "What times are available?" }
}
```

Send an `Idempotency-Key` header and reuse it only when retrying the same
request. An accepted response means Darwin saved the message. It does not mean the
target received it, answered it, or completed work.

## Typed messages

Continue a thread through [Act](/docs/reference/act) using one of these message types:

| `message.type` | Fields in `message` | Purpose |
| - | - | - |
| `text` | `text` | Exchange ordinary content. |
| `action_request` | `capabilityId`, `arguments` | Request a capability with schema-valid arguments. |
| `action_confirmation` | `requestId` | Confirm the exact pending action request. |
| `approval_confirmation` | `requestId`, `decision` (`allow` or `deny`) | Resolve a permission request. |
| `completion_confirmation` | `requestId` | Acknowledge a completed result. |
| `cancellation_request` | `operationId` | Request cancellation; read the thread for its outcome. |
| `authentication_response` | `requestId` | Begin a hosted connection flow. |
| `payment_response` | `requestId` | Begin hosted payment selection. |

Copy request IDs from the matching pending Get Act request request. Text is never an approval or proof of payment.

## Recover history and status

Call [Get Act request](/docs/reference/act-request) to recover the current messages,
actions, and pending requests. Pass the last processed `cursor` to read the next
page while `hasMore` is true. A quiet thread is not proof of completion.

The first-party Web experience may use its authenticated SSE transport and resume from
`Last-Event-ID`; that private transport is separate from the public Act command. Stream
disconnects do not cancel or complete work.

Use `messages` for safe conversation/result content, `actions` for current work
state, and `requests` for pending or resolved decisions. Each request is a strict
review object: action and approval requests include their exact safe capability
arguments; authentication requests include target, type, resource, scopes, and
selected account when available; payment requests include amount, currency,
payee, accepted methods, and expiry. Completion requests identify the result.

Darwin loads those immutable review terms even when their originating event is
outside the current cursor page. Missing, corrupt, or credential-shaped review
data fails closed. Public projections omit internal revisions, digests,
credentials, provider references, and receipts.

## Retry rules

* Retry a timed-out mutation only with the same idempotency key and identical input.
* On authorization denial, stop and reconnect with the required scope.
* On rate limits, respect `Retry-After`.
* Before resending work, read the thread and check its current actions and requests.

## When your client communicates directly

Use the selected Search result's `connectionPrompt` and [connection checklist](/docs/search/using-results) to locate and verify the provider's actual protocol binding. Darwin's typed Act messages, request IDs, and thread cursor apply to Darwin threads; do not send them to an unrelated provider endpoint. For direct MCP, A2A, HTTP, or WebMCP communication, follow the provider's current message and input schema. Persist your own conversation ID and delivery evidence, distinguish an accepted call from a provider result, and ask the person before an external action. If no verified route exists, report that limitation rather than fabricating one.


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.