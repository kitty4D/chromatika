# `chrome.runtime.connectNative` (MCP native messaging)

chromatika spawns the MCP native messaging host via `chrome.runtime.connectNative('com.chromatika.mcp_host')`. unlike the tRPC port (which connects in-process between UI and SW), `connectNative` reaches an **out-of-process** native binary that chrome spawns as a child process and pipes stdio to. this is how chromatika reaches outside the browser to host the localhost HTTP MCP listener.

## the manifest dance

`connectNative` looks up a per-OS native messaging manifest (see [mcp-host-spawn-and-setup.md](/library/tech/mcp-host-spawn-and-setup)):
- the manifest's `name` field must match the `connectNative` argument
- `allowed_origins` must include the chromatika extension id
- `path` points at the host binary

chrome refuses to connect if any check fails - returns a port that immediately disconnects with a `chrome.runtime.lastError`.

## the wire protocol (chrome ↔ native host)

unlike `chrome.runtime.connect` which uses arbitrary JS messages, `connectNative` uses a specific binary frame protocol:

```
[4-byte LE length prefix] [UTF-8 JSON body]
```

per direction. host's stdin gets framed JSON from chrome; host writes framed JSON to stdout. see [mcp-native-messaging-frame.md](/library/tech/mcp-native-messaging-frame) for the full details.

## the chromatika side

```ts
let nativePort: chrome.runtime.Port | null = null;
let reconnectAttempt = 0;

async function connectMcpHost() {
  if (nativePort) return;   // already connected

  nativePort = chrome.runtime.connectNative('com.chromatika.mcp_host');

  nativePort.onMessage.addListener((msg) => {
    handleNativeFrame(msg);   // see mcp-tool-routing for handlers
  });

  nativePort.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError;
    nativePort = null;
    if (mcpEnabled() && reconnectAttempt < 5) {
      const delay = Math.min(30_000, 1000 * Math.pow(2, reconnectAttempt));
      setTimeout(() => connectMcpHost(), delay);
      reconnectAttempt++;
    }
  });

  // push initial config
  const { tokenHex } = await chrome.storage.local.get('chromatika_mcp_v1');
  nativePort.postMessage({ type: 'config', tokenHex });
}
```

## the auto-reconnect with backoff

```
attempt 1: 1 second delay
attempt 2: 2 seconds
attempt 3: 4 seconds
attempt 4: 8 seconds
attempt 5: 16 seconds (capped at 30)
```

after 5 failed attempts, give up. user has to manually re-enable MCP via `mcpEnable` to retry. prevents infinite reconnect loops on permanent failure (e.g. host binary missing).

`reconnectAttempt` resets to 0 on a successful connect.

## the lifecycle states chromatika tracks

```ts
type McpHostState =
  | { kind: 'disabled' }
  | { kind: 'connecting' }
  | { kind: 'connected', port: number, host: string }
  | { kind: 'reconnecting', attempt: number, nextRetryAtMs: number }
  | { kind: 'failed', error: string };
```

surfaced via `mcpStatus` for the agent settings UI to display.

## the cold-SW restart case

when the SW dies and respawns:
1. SW reads `chromatika_mcp_v1.enabled`
2. if enabled, calls `connectMcpHost()` (fresh connection)
3. host process **also** respawns (the previous host process exited when its stdin closed)
4. fresh handshake: chromatika pushes `{ type: 'config', tokenHex }`, host responds with `{ kind: 'config-ack' }` then `{ kind: 'listen', port }`

if the user pinned a desired port via `mcpSetDesiredPort`, chromatika pushes `{ type: 'reconfigure-port', port }` after receiving the initial `{ kind: 'listen' }`. host rebinds to the desired port, sends fresh `{ kind: 'listen' }`.

so the URL the user has in their Claude Desktop config stays stable across SW restarts (assuming no port conflict).

## why this is different from regular ports

- regular `chrome.runtime.connect` reaches another JS context inside the same extension (UI ↔ SW, SW ↔ content-script)
- `chrome.runtime.connectNative` reaches a **separate process** outside chrome
- separate process means the host can do things SW can't:
  - bind a TCP listener (SW can't listen on sockets)
  - run synchronous file I/O
  - speak protocols beyond what chrome's `fetch` can speak

trade-off: the native host requires per-OS setup (the manifest + binary registration). regular extension communication doesn't.

## what `connectNative` doesn't do

- doesn't authenticate the host beyond the manifest's `allowed_origins`. the host accepts whatever the manifest registered. if an attacker can write to the manifest directory (probably needs OS-level access), they can swap in a different host
- doesn't encrypt the stdio pipe. it's local IPC, not network. encryption isn't necessary
- doesn't rate-limit. chromatika handles rate-limiting at the MCP layer (per-tool-call)

## library

- browser native `chrome.runtime.connectNative`, `chrome.runtime.Port`, `chrome.runtime.lastError`
- internal: `wallet-extension/src/background/mcp/mcp-native-bridge.ts` for the connect / reconnect orchestration

## related

- [mcp-host-spawn-and-setup.md](/library/tech/mcp-host-spawn-and-setup) - the per-OS manifest setup
- [mcp-native-messaging-frame.md](/library/tech/mcp-native-messaging-frame) - the wire format
- [mcp-protocol-overview.md](/library/tech/mcp-protocol-overview) - what chromatika does once connected
- [chrome-runtime-connect-trpc-port.md](/library/tech/chrome-runtime-connect-trpc-port) - the in-process port analog
