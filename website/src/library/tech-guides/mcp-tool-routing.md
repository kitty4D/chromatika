# MCP tool-call routing and correlation

an MCP `tools/call` lands on the native host's HTTP listener but the actual tool execution happens **in the chromatika service worker**. this doc walks how a single agent call is routed: HTTP request → native host → native messaging frame → service worker → tRPC procedure → (popup if needed) → result frame → HTTP response.

## the correlation problem

the host needs to:

1. accept an HTTP MCP request
2. forward it to the extension
3. wait for the extension to respond
4. write the response back over HTTP

native messaging is a single bidirectional pipe. multiple in-flight tool calls can exist simultaneously (an agent might call `listVaults` while a previous `signMessage` is still waiting on user approval). we need to **correlate** which incoming response belongs to which outgoing request.

solution: **per-call correlation ids** plus a `pending` Map keyed by id.

## the envelope

extension ↔ host:

```jsonc
// host → extension (initiated by HTTP MCP request arrival)
{
  "type": "tool-call",
  "id": "<random-uuid>",
  "method": "tools/call",
  "params": { "name": "signMessage", "arguments": { ... } }
}

// extension → host (response after the SW handled it)
{
  "type": "tool-result",
  "id": "<same-uuid>",
  "result": { ... }
}
// or
{
  "type": "tool-result",
  "id": "<same-uuid>",
  "error": { "code": -32603, "message": "..." }
}
```

`id` is generated fresh per HTTP request via `randomUUID()`. it has nothing to do with the JSON-RPC `id` from the agent client - that's preserved separately so the HTTP response can echo it.

## the pending Map

```js
const pending = new Map();
// id → { resolve, timeoutId, ...metadata }

function dispatchToolCall(httpId, jsonRpcReq) {
  return new Promise((resolve, reject) => {
    const correlationId = randomUUID();
    const timeoutId = setTimeout(() => {
      if (pending.has(correlationId)) {
        pending.delete(correlationId);
        reject(new Error("tool call timed out"));
      }
    }, TOOL_CALL_TIMEOUT_MS); // 300_000 = 5 minutes

    pending.set(correlationId, { resolve, reject, timeoutId, httpId });

    sendFrame({
      type: "tool-call",
      id: correlationId,
      method: jsonRpcReq.method,
      params: jsonRpcReq.params,
    });
  });
}

function handleToolResult(msg) {
  const entry = pending.get(msg.id);
  if (!entry) return; // already timed out / unknown
  pending.delete(msg.id);
  clearTimeout(entry.timeoutId);
  if (msg.error) entry.resolve({ error: msg.error });
  else entry.resolve({ result: msg.result });
}
```

`pending` Map gets cleared by either the response arriving or the 5-minute timeout. the entry holds the resolve / reject so the awaiting HTTP handler can complete.

## the 5-minute timeout

```js
const TOOL_CALL_TIMEOUT_MS = 300_000;
```

300 seconds is long enough for the user to read an approval popup carefully (especially for transactions where they need to verify destination + amount). read-tier tools resolve in well under a second; the same cap applies to both because there's no harm in giving read-tier requests a long ceiling - they'll resolve on their own.

if a popup is dismissed without user action, the SW responds with an error frame; the timeout never fires. timeout only matters if the SW itself crashes mid-call.

## extension-side handling

```ts
// in the SW's MCP bridge handler
nativePort.onMessage.addListener(async (msg) => {
  if (msg.type !== 'tool-call') return;
  const { id, method, params } = msg;

  try {
    let result;
    if (method === 'tools/list') {
      result = await listMcpTools();
    } else if (method === 'tools/call') {
      result = await runMcpTool(params.name, params.arguments);
    } else if (method === 'initialize') {
      result = { protocolVersion: '2025-03-26', serverInfo: ..., capabilities: ... };
    } else {
      throw { code: -32601, message: `method not found: ${method}` };
    }
    nativePort.postMessage({ type: 'tool-result', id, result });
  } catch (e) {
    nativePort.postMessage({
      type: 'tool-result',
      id,
      error: e.code ? e : { code: -32603, message: e.message ?? String(e) },
    });
  }
});
```

`runMcpTool` dispatches to the right tool implementation. for read-tier, that's a direct tRPC call to `listVaults` etc. for approve-tier, it's an enqueue-and-wait pattern (see below).

## approve-tier wait pattern

```ts
async function runApproveTierTool(name, args) {
  // 1. enqueue the request in mcp-pending-queue
  const requestId = randomUUID();
  await mcpPendingQueue.enqueue({
    id: requestId,
    name,
    args,
    enqueuedAtMs: Date.now(),
  });

  // 2. open the appropriate popup
  if (name === "signMessage") {
    chrome.windows.create({
      url: chrome.runtime.getURL(`index.html?mcpapprove=${requestId}`),
      type: "popup",
      width: 400,
      height: 700,
    });
  } else if (name === "sendEvmTx" || name === "signTransaction") {
    chrome.windows.create({
      url: chrome.runtime.getURL(`index.html?txapprove=${requestId}&mcpMode=${name}`),
      type: "popup",
      width: 400,
      height: 700,
    });
  }

  // 3. await user resolution (popup calls approveMcpSign or rejectMcpSign)
  return new Promise((resolve, reject) => {
    mcpPendingQueue.onResolve(requestId, (outcome) => {
      if (outcome.kind === "approved") resolve(outcome.payload);
      else reject({ code: -32000, message: "user canceled", data: outcome.reason });
    });
  });
}
```

the popup `?mcpapprove=<id>` calls back via tRPC (`approvePendingMcpSign` / `rejectPendingMcpSign`), which writes the outcome to the pending queue. the awaiting promise resolves and the result frame goes back through native messaging to the host, which completes the HTTP response.

## the timing

```
0ms     agent calls POST /mcp with tools/call signMessage
+1ms    host validates auth, parses JSON-RPC
+2ms    host writes 'tool-call' frame to native messaging stdin/stdout
+5ms    extension SW receives, parses
+10ms   SW dispatches to runMcpTool('signMessage', args)
+15ms   SW enqueues pending request, opens popup window
... user reads, clicks approve ...
+45_000ms   popup calls approvePendingMcpSign tRPC
+45_001ms   tRPC handler signs via ika MPC (~300-1000ms)
+45_500ms   sign completes, popup resolves promise
+45_502ms   SW posts 'tool-result' frame back to host
+45_504ms   host pops pending entry, resolves HTTP awaiter
+45_510ms   host writes JSON-RPC response with the signature
+45_550ms   agent receives the HTTP response
```

most of the wall-clock time is **user reading the popup**. the actual MCP machinery is sub-second.

## list-changed notifications (not implemented)

MCP spec defines a server-to-client notification `notifications/tools/list_changed` for telling the client "hey, the tool list updated, re-fetch via tools/list". chromatika **doesn't push these today** because:

- HTTP MCP transport is request/response only - no SSE or websocket for server push
- the tool list is static (defined in code), so list-changed events are rare

future: add SSE transport for server-to-client streams. when that lands, list-changed (and possibly progress events for long approve-tier calls) become possible.

## library

- `randomUUID` from `node:crypto` for correlation ids
- `Map` for the pending registry
- `chrome.runtime.connectNative` + `port.postMessage` / `port.onMessage` on the extension side
- internal: `mcp-pending-queue.ts` for the approve-tier queue + popup orchestration
- internal: `mcp-tools.ts` for the tool catalog + dispatch

## related

- [mcp-native-messaging-frame.md](/library/tech/mcp-native-messaging-frame) - the wire format under tool-call / tool-result
- [mcp-http-transport.md](/library/tech/mcp-http-transport) - the HTTP listener that initiates the dispatch
- [mcp-bearer-token-auth.md](/library/tech/mcp-bearer-token-auth) - validates HTTP requests before they reach the dispatcher
