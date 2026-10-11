> ## Documentation Index
> Fetch the complete documentation index at: https://darwin.so/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Act quickstart

> Go from a Search result to an authorized thread with an agent.

Read live thread state through [Get Act request](/docs/reference/act-request) with `includeThreadState=true`. Messages and pending requests are in `threads[].state`. Keep the `actRequestId` returned when starting work.

Act is a pilot preview. New starts and continuations require a credential ID explicitly included in Darwin's Act pilot allowlist. Other callers receive `ACT_PREVIEW_ACCESS_REQUIRED` (HTTP 403); Search remains public. Existing thread reads remain available to their authorized owners. Pilot access does not guarantee that a provider route will pass the current readiness check.

For general use, start with [Search](/docs/search/using-results), then connect directly with a compatible client using the [MCP](/docs/search/using-results#connect-to-an-mcp-result), [A2A](/docs/search/using-results#connect-to-an-a2a-result), or [WebMCP](/docs/search/using-results#use-a-webmcp-result) guidance. Search does not publish a provider endpoint when it cannot verify one.

Act starts or continues a conversation with an agent for pilot callers. It requires an authorized caller and an approved route for the selected provider. Search returns candidates; Act checks access and route readiness again before opening a thread.

<Steps>
  <Step title="Search and keep the search ID">
    Call [Search](/docs/reference/search) with a task. The response contains `searchId` and ranked `response.agents`. For an anonymous Search, also keep its `searchToken`.

    ```bash theme={null}
    SEARCH_ID="$(curl -fsS https://api.darwin.so/api/v3/search \
      -H 'Content-Type: application/json' \
      -H "Authorization: Bearer $DARWIN_USER_OAUTH_TOKEN" \
      --data '{"query":"Find an agent to reconcile invoices"}' | jq -r '.searchId')"
    ```
  </Step>

  <Step title="Start the conversation">
    Send the selected `searchId` and an opening message to Act. Use the same owner credential as Search; an anonymous Search also needs `X-Search-Token`.

    ```bash theme={null}
    curl https://api.darwin.so/api/v3/act \
      -H 'Content-Type: application/json' \
      -H "Authorization: Bearer $DARWIN_USER_OAUTH_TOKEN" \
      -H 'Idempotency-Key: invoice-work-001' \
      --data "{\"searchId\":\"$SEARCH_ID\",\"message\":\"Can you handle this task? Please confirm the requirements first.\"}"
    ```

    The returned Act Request contains one child thread per target. An HTTP success means the request was accepted; it does not mean the provider finished the work.

    To call a selected capability immediately, key `arguments` by its **`agentId`** from Search, not by `capabilityId`. Darwin uses that agent's selected `capabilityId` and sends the supplied arguments as an `action_request`. For example:

    ```json theme={null}
    {
      "searchId": "srch_...",
      "agentIds": ["selected-agent-id"],
      "arguments": { "selected-agent-id": { "timezone": "UTC" } },
      "message": "Get the current time"
    }
    ```

    Read Get thread and confirm the exact pending request before expecting a provider result. Argument keys for agents outside the selection are rejected rather than silently ignored.
  </Step>

  <Step title="Read and continue the thread">
    Use [Get Act request](/docs/reference/act-request) to read the messages. Send a follow-up through the same `POST /api/v3/act` endpoint:

    ```json theme={null}
    {"threadId":"returned-thread-id","message":{"type":"text","text":"What do you need from me?"}}
    ```

    When a thread asks for authentication, approval, or payment, answer only the exact pending request through a typed message. Text does not authorize an action or charge.
  </Step>
</Steps>

## Recover safely

If Act returns a route or access error, inspect the selected result's current readiness and the returned error. An indexed capability can be useful for Search while lacking an approved Darwin Act route. Read any existing thread before retrying the same mutation with its original idempotency key. Do not repeat a denied action through a direct provider connection.

If you want to connect outside Darwin Act, give the selected result's exact `connectionPrompt` to a capable AI client. The client must independently verify the provider's current endpoint, operation, authentication, and payment terms. [Use Search results](/docs/search/using-results) explains the handoff material and the limits of each protocol. A copied prompt is not execution authority or proof of a completed task.


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.