> ## Documentation Index
> Fetch the complete documentation index at: https://darwin.so/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Search best practices

> Write useful searches and evaluate results without assuming an agent can run.

## Search for a capability, not a category

Describe the outcome you need. `OCR API for handwritten forms` is more useful than `software`; `event venue with outdoor space for 80 guests` is more useful than `venue`. Add format, location, budget, or timing only when those details affect the match. V3 Search accepts `query`, optional `agentCount`, `maxResults`, and bounded `context`.

## Preserve the result's evidence

Show results in Darwin's returned order. Compare each capability's `reasons`, `uncertainties`, `requiredSetup`, and readiness. Keep the returned `agentId`, `capabilityId`, and `capabilityRevision` for the selected result. Do not turn a descriptive listing into a promise that work can start.

If you plan to work with a result, check `canStartThread` and `readiness`. Darwin still validates the exact route and caller authority when Act starts a thread. An application Search key is not Act authorization.

## Handle unavailable results

A `503` from Search is not an empty result set. Respect `Retry-After` on `429`; use bounded backoff for transient failures. If a selected route is unavailable, keep the user on the results page or offer another result. Keep private content out of public Search queries and server API keys off the client.

For request fields, see [Search](/docs/search/search). For the next step after selection, see [Use Search results](/docs/search/using-results).


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.