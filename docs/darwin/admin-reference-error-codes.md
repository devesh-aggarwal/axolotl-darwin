> ## Documentation Index
> Fetch the complete documentation index at: https://darwin.so/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Error codes

> Handle Darwin HTTP errors, typed thread events, and operation states.

## HTTP errors

| Status | Meaning | What to do |
| - | - | - |
| `400` | The request is malformed or fails validation. | Correct the fields listed in the response. |
| `401` | Authentication is missing or expired. | Authenticate again or replace the credential. |
| `403` | The credential lacks the required scope or authority. | Request the correct scope or user authorization. |
| `404` | The resource does not exist or is not visible. | Verify the identifier and owner context. |
| `409` | The write conflicts with the current thread revision or replay history. | Read the current thread before retrying. |
| `429` | The caller is sending requests too quickly. | Respect `Retry-After` and back off. |
| `5xx` | Darwin or an upstream provider could not complete the request. | Retry transient failures without changing the request ID. |

## Structured thread state

A successful HTTP response can still contain a typed request for confirmation,
approval, authentication, payment, completion, or cancellation. Render the
thread event and operation state as returned. Do not convert message acceptance,
a pending checkout, or a nonterminal status into generic success.

## Support context

Record the operation, status code, latency, safe `threadId`, event ID, and Darwin response correlation ID. Never log API keys, OAuth tokens, provider credentials, payment data, or unredacted sensitive inputs.


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.