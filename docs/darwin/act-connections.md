> ## Documentation Index
> Fetch the complete documentation index at: https://darwin.so/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Authenticate

> Connect an external account when a thread requires it.

Read live thread state through [Get Act request](/docs/reference/act-request) with `includeThreadState=true`. Messages and pending requests are in `threads[].state`. Keep the `actRequestId` returned when starting work.

Authentication gives your Darwin account a scoped external connection. It does
not approve an action or authorize payment. Never put credentials in messages
or API arguments. This account-owned flow remains release-gated.

## Start from a request

When Get Act request returns a pending authentication request, review its target,
authentication type, resource, scopes, and expiry. Then call [Act](/docs/reference/act) with the thread ID and an
`authentication_response` containing the exact `requestId`. The person chooses a supported method or a matching saved
credential in the hosted flow. Darwin checks saved credentials against the
target and scopes before reuse.

Darwin has fixed hosted flows for `oauth`, `bearer`, `api_key`, `password`, and
`username_password`. A provider may also use a namespaced method such as
`vendor.oauth_pkce`, but only when Darwin has an exact reviewed OAuth redirect
handler for that target, resource, scopes, and binding revision. An arbitrary
method name or redirect URL never creates an authentication flow.

```json theme={null}
{
  "threadId": "returned-thread-id",
  "message": { "type": "authentication_response", "requestId": "returned-request-id" }
}
```

Use an `Idempotency-Key` header for retries. The response’s typed `result` contains `authentication`, `status`, and, when consent is needed,
a first-party `url` and `expiresAt`. Open only that URL. Its presence does not
prove the connection succeeded.

## Save a credential

If the hosted flow offers saved access, the account holder can choose it after
reviewing the target and scopes. The provider secret stays in the hosted flow;
the Account API returns only safe metadata and a Darwin `credentialId`. There
is no public standalone credential-setup endpoint yet, so connecting a service
ahead of a thread is not supported by this API.

## Check the outcome

Read the same thread for the verified connection or failure. Do not start a
second authentication attempt merely to check whether the first succeeded.

Status remains distinct across `awaiting_consent`, `authorizing`, `exchanging`,
`connected`, `expired`, `denied`, and `failed`. Only `connected`, backed by the
server's verified receipt, is success.

## Failure and safety

Do not retry an uncertain authorization-code exchange. Start a new attempt when
Darwin says the old one expired or failed. Account-list APIs expose only safe
metadata; tokens, passwords, provider state, and credentials never enter Act.
Provider adapters remain individually release-gated until live verification.

## If your client connects to a provider directly

`requiredSetup` in Search is an indexed, nullable description; it is not a credential challenge or a complete list of supported methods. Verify the provider's current MCP, A2A, HTTP, or WebMCP security declaration and the exact account, resource, and scopes before opening a connection. Your client must implement that provider's actual flow and store secrets securely. Darwin's hosted `authentication_response` and saved `credentialId` apply only to a Darwin Act thread; they cannot be reused as a generic provider token. Ask the person to approve access and treat only the provider's verified completion as connected. See [Use Search results](/docs/search/using-results).


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.