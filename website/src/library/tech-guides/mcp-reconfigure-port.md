# MCP `reconfigure-port` live rebind

by default, the chromatika MCP HTTP listener binds to a **random** port on `127.0.0.1`. that's fine until you want to put the URL in Claude Desktop's MCP config (which doesn't reload on chrome restart) - the port changes after every chrome unloads the SW + respawns the host. the fix: `mcpSetDesiredPort` lets the user pin a fixed port (1024-65535). the extension pushes that desired port to the running host via a `{ type: 'reconfigure-port', port }` frame. the host opens a new listener on the desired port, **then** tears down the old one - if the new bind fails, the host stays on the current port and reports the error.

## why this is non-trivial

if we just close the old listener and try to open a new one, we have a brief window where neither is bound. agent clients with in-flight requests would see connection-refused. the live rebind handles this by:

1. building a replacement server first
2. binding it to the desired port
3. on success, closing the old listener
4. on failure, throwing away the replacement and keeping the old listener alive

it's a "open new before closing old" handoff with rollback on failure.

## the frame

```jsonc
// extension → host
{
  "type": "reconfigure-port",
  "port": 54321
}
```

port must be `1024 ≤ port ≤ 65535`. ports below 1024 require root on linux/mac and admin on windows; chromatika doesn't support that.

## the host-side handler

```js
async function rebindToDesiredPort(desiredPort) {
  const currentAddr = server?.address?.();
  const currentPort = typeof currentAddr === 'object' && currentAddr ? currentAddr.port : null;

  // already on the right port - nothing to do
  if (currentPort === desiredPort) {
    sendFrame({ kind: 'listen', host: '127.0.0.1', port: desiredPort });
    return;
  }

  const oldServer = server;
  // build replacement first; only swap after successful bind
  const newServer = createServer(httpHandler);
  newServer.on('error', (e) => {
    logErr('replacement server error:', e?.message ?? e);
  });

  await new Promise((resolve) => {
    newServer.once('error', (e) => {
      logErr(`rebind to port ${desiredPort} failed: ${e?.message ?? e}; staying on current port ${currentPort}`);
      sendFrame({ kind: 'rebind-error', desiredPort, error: e?.message ?? String(e) });
      try { newServer.close(); } catch { /* noop */ }
      resolve();
    });
    newServer.listen(desiredPort, '127.0.0.1', () => {
      // bind success - tear down the old listener
      try { oldServer.close(); }
      catch (e) { logErr('failed to close prior listener after rebind:', e?.message ?? e); }
      server = newServer;
      sendFrame({ kind: 'listen', host: '127.0.0.1', port: desiredPort });
      logErr(`chromatika-mcp-host rebound to 127.0.0.1:${desiredPort}`);
      resolve();
    });
  });
}
```

key invariants:
- if `desiredPort` matches `currentPort`, no-op (don't touch a working listener)
- on bind error, stay on the current listener; report `kind: 'rebind-error'` with the error message
- on bind success, swap - new listener becomes `server`, old listener closes
- in-flight requests on the old listener complete normally (node's `server.close()` waits for active connections to finish before tearing down the listening socket)

## extension-side coordination

```ts
async function pushDesiredPortToHost(port: number | null) {
  if (!nativePort) return;
  if (port === null) {
    // user cleared the desired port - host should fall back to a random port
    // this is a pseudo-rebind: pick a random ephemeral port and reconfigure
    nativePort.postMessage({ type: 'reconfigure-port', port: pickRandomPort() });
  } else {
    nativePort.postMessage({ type: 'reconfigure-port', port });
  }
}
```

a `null` desired-port means "use a random port"; the extension picks a random ephemeral and sends that. there's no "go back to whatever you originally bound" frame because the host doesn't remember its initial port - it just takes whatever port it's currently on.

## the chrome-restart behavior

when chrome restarts:
1. service worker spawns cold
2. SW reads `chromatika_mcp_v1.desiredListenPort` from storage
3. SW reconnects to the native host via `chrome.runtime.connectNative`
4. host spawns fresh, binds to **a random port** initially (it doesn't know about the desired port yet)
5. host sends `{ kind: 'listen', host: '127.0.0.1', port: <random> }` via native messaging
6. SW receives, **then** sends `{ type: 'reconfigure-port', port: <desiredPort> }` if a desired port is set
7. host rebinds to the desired port, sends fresh `kind: 'listen'` frame
8. SW updates `chromatika_mcp_v1.listenPort` to the desired port

end result: after chrome restart, the listener is on `desiredPort` (or random if none was pinned). the rebind takes <100ms typically.

## error: bind failure

if the desired port is taken (another process bound it, or chromatika was started before the previous instance fully released the socket), the host reports:

```jsonc
// host → extension
{
  "kind": "rebind-error",
  "desiredPort": 54321,
  "error": "EADDRINUSE: address already in use 127.0.0.1:54321"
}
```

the extension surfaces this in the agent-settings UI as "couldn't bind requested port". the listener stays on whatever port it was on before (random if just spawned). user options: pick a different port, find what's using 54321 and kill it, retry.

## why not declare the port up-front in the native messaging manifest

native messaging manifests don't have a port field. they just declare the host binary path. the host process is responsible for any networking it does. plus, putting a port in the manifest would freeze it across all installs and conflict with users who want different ports.

## the `setupBuffer` quirk during rebind

when the host rebinds, the **old** server is in the middle of serving any in-flight requests. node's `server.close()` waits for active connections; new connections to the old port refuse immediately. so:
- new requests during rebind: routed to the new listener
- in-flight requests during rebind: complete on the old listener
- post-rebind: only the new listener accepts connections

agent clients with persistent connections to the old port may see disconnects when their connection drains; they reconnect to the new URL. acceptable.

## library

- `node:http` `createServer`, `server.listen`, `server.close`
- `chrome.storage.local` to persist `desiredListenPort`
- `chrome.runtime.connectNative` `port.postMessage` for the frame

## related

- [mcp-http-transport.md](/library/tech/mcp-http-transport) - the HTTP listener that gets rebound
- [mcp-native-messaging-frame.md](/library/tech/mcp-native-messaging-frame) - the frame format under `reconfigure-port`
- [mcp-host-spawn-and-setup.md](/library/tech/mcp-host-spawn-and-setup) - per-OS host registration that makes connectNative work in the first place
