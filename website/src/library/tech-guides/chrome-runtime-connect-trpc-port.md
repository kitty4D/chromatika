# `chrome.runtime.connect` (tRPC port for UI ↔ background)

chromatika's UI (popup, side panel, full-page surfaces) talks to the background service worker over a long-lived `chrome.runtime.Port`. tRPC is layered on top: each tRPC procedure call serializes to a port message; the background dispatches to the handler; result returns over the same port. has a 12-second response timeout to defend against cold-SW silent stalls.

## why a port (not `chrome.runtime.sendMessage`)

`chrome.runtime.sendMessage` is one-shot - send a message, get a response. fine for read-only requests. but tRPC supports streaming, batching, request cancellation, and long-running operations. a long-lived port is the right primitive:

- one connection setup per UI session
- bidirectional messages (background can push events, e.g. `'lock'` notifications)
- in-order delivery
- automatic cleanup when the UI page closes (port disconnect event)

## the port lifecycle

```ts
// UI side (popup/side-panel)
const port = chrome.runtime.connect({ name: "chromatika-trpc" });
const trpcClient = createTRPCClient({
  links: [chromeRuntimePortLink({ port })],
});

// every trpcClient.someProcedure.query(...) call:
// 1. serialize the tRPC request (with superjson for bigint/Date support)
// 2. port.postMessage({ type: 'trpc-req', id, method, params })
// 3. await matching 'trpc-resp' on port.onMessage
// 4. resolve / reject the promise

// background side
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "chromatika-trpc") return;
  port.onMessage.addListener(async (msg) => {
    if (msg.type !== "trpc-req") return;
    try {
      const result = await trpcRouter[msg.method](msg.params);
      port.postMessage({ type: "trpc-resp", id: msg.id, result });
    } catch (e) {
      port.postMessage({ type: "trpc-resp", id: msg.id, error: serializeError(e) });
    }
  });
  port.onDisconnect.addListener(() => {
    // cleanup any per-port subscriptions
  });
});
```

## the 12-second timeout

per `src/lib/trpc.ts`, every tRPC procedure has a **12-second port response timeout**. if the background doesn't respond in 12 seconds, the UI rejects the procedure with a timeout error. this defends against:

- cold service worker that silently fails to reach handler dispatch
- background hung on an unrelated operation
- network operations (e.g. RPC calls) that take too long

**exempted** procedures: long-running mutations like `executeSwap` (20s keepalive), `getDwalletHomeGasMany` (20s), `presign refill` if user-initiated, etc. these mark themselves as "long-running" via a tRPC meta and the client increases the timeout per-call.

## the sendMessage fallback

for cases where a port isn't available (e.g. content-script context that isn't UI), chromatika falls back to `chrome.runtime.sendMessage`. the dapp bridge (page → content-script → background) uses this. tRPC isn't layered on it; just bare message passing.

## the cold-SW handshake

chrome MV3 service workers go to sleep after ~30s idle. when a UI page (e.g. popup) opens after the SW slept:

1. UI calls `chrome.runtime.connect` - this implicitly **wakes** the SW
2. SW spins up, registers `chrome.runtime.onConnect` handlers
3. there's a brief race: the UI's first port message could land before the SW's listener registers
4. if so, chrome holds the message in queue and delivers when the listener attaches

usually this works seamlessly. occasionally a cold SW takes long enough that the 12s timeout fires before the listener is up - that's the "wallet not ready, retry" case.

## superjson for serialization

tRPC procedures often use `bigint` (e.g. wei amounts), `Date` (timestamps), `Map` (lookup tables) - JSON doesn't natively serialize these. chromatika uses **superjson** to wrap the tRPC payload:

```ts
{
  json: { ... actual JSON-serializable shape ... },
  meta: { references: { "$.amount": "bigint" } }   // restoration map
}
```

on the receiving side, superjson reads `meta.references` and restores types. transparent to handler code; just feels like native types passed across the boundary.

## per-tab isolation

each UI page (popup, side panel, settings page) gets its **own port**. the background tracks ports for:

- broadcasting events (e.g. lock state changed → notify all UI ports)
- per-port subscriptions (e.g. `signingProgress` polling)
- cleanup on disconnect

ports don't leak between UI surfaces - locking via the popup correctly broadcasts `disconnect` to the side panel's port too.

## library

- browser native `chrome.runtime.connect`, `chrome.runtime.onConnect`, `chrome.runtime.Port`
- `@trpc/client`, `@trpc/server` for the tRPC layer
- `superjson` for serialization
- internal: `wallet-extension/src/lib/trpc.ts` for the chrome-runtime-port tRPC link
- internal: `wallet-extension/src/server/trpc.ts` for the background-side router

## related

- [chrome-runtime-connectnative.md](/library/tech/chrome-runtime-connectnative) - the analog for MCP native messaging
- [cold-sw-unlock-cache.md](/library/tech/cold-sw-unlock-cache) - how the SW survives idle teardown
- [mcp-tool-routing.md](/library/tech/mcp-tool-routing) - tRPC procedures the MCP layer dispatches into
