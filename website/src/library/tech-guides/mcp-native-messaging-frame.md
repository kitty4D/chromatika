# chrome native messaging frame protocol

chrome native messaging is the channel between the chromatika service worker (via `chrome.runtime.connectNative`) and the spawned native host process (`chromatika-mcp-host.mjs`). it's a tiny binary protocol: each message is a **4-byte little-endian length prefix** followed by **UTF-8 JSON** body.

## the wire format

```
+------------+-----------------+
| 4-byte LE  |  UTF-8 JSON     |
| length N   |  N bytes body   |
+------------+-----------------+
```

example: sending `{"type":"ping"}` (15 bytes UTF-8):

```
[0x0F, 0x00, 0x00, 0x00] [0x7B, 0x22, 0x74, 0x79, 0x70, 0x65, 0x22, 0x3A, 0x22, 0x70, 0x69, 0x6E, 0x67, 0x22, 0x7D]
   ^ length = 15           ^ {"type":"ping"}
```

the prefix is **little-endian uint32**. on the host side:

```js
function sendFrame(obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(body.length, 0);
  STDOUT.write(Buffer.concat([lenBuf, body]));
}
```

reading is the mirror image - read 4 bytes, parse as LE u32, read N more bytes, JSON.parse. the host has a buffered reader because chrome may split a single send across multiple stdin reads:

```js
let buffer = Buffer.alloc(0);

function processBuffer() {
  while (buffer.length >= 4) {
    const msgLen = buffer.readUInt32LE(0);
    if (buffer.length < 4 + msgLen) break; // wait for more bytes
    const body = buffer.subarray(4, 4 + msgLen);
    buffer = buffer.subarray(4 + msgLen);
    const msg = JSON.parse(body.toString("utf8"));
    handleMessage(msg);
  }
}
```

## the 1 MiB limit

chrome rejects any single message larger than **1 MiB** in either direction (extension → host or host → extension). chromatika doesn't come close - the largest frames are tool-result responses with signature bytes, well under 10 KB.

if you ever need to send more (e.g. a large NFT inventory dump), split into multiple frames at the application layer. don't try to bypass chrome's limit.

## how chrome spawns the host

`chrome.runtime.connectNative('com.chromatika.mcp_host')` looks up the native messaging manifest by name in OS-specific locations:

- **Windows**: `HKEY_CURRENT_USER\SOFTWARE\Google\Chrome\NativeMessagingHosts\com.chromatika.mcp_host` registry key pointing at the manifest JSON
- **macOS**: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.chromatika.mcp_host.json`
- **Linux**: `~/.config/google-chrome/NativeMessagingHosts/com.chromatika.mcp_host.json`

the manifest declares the host binary path + which extension ids are allowed to connect:

```jsonc
{
  "name": "com.chromatika.mcp_host",
  "description": "Chromatika MCP native messaging host",
  "path": "/absolute/path/to/chromatika-mcp-host.mjs",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://<your-extension-id>/"],
}
```

`pnpm setup:native-host --extension-id=<id>` writes this manifest to the right OS-specific directory. on Windows it also drops a `.bat` shim and runs `reg add` for the registry entry.

## the connection lifecycle

```
1. service worker calls chrome.runtime.connectNative('com.chromatika.mcp_host')
2. chrome looks up manifest, spawns the host as a child process with stdio piped
3. host begins reading 4-byte-prefixed frames from stdin
4. service worker pushes the first frame: { type: 'config', tokenHex: '<...>' }
5. host echoes { ok: true, kind: 'config-ack', hasToken: true }
6. host opens an HTTP listener (see mcp-http-transport.md), writes back { kind: 'listen', host: '127.0.0.1', port }
7. service worker stores the port for the agent URL
8. on every MCP call, host writes { type: 'tool-call', id, method, params } to stdout (toward extension);
   service worker handles, replies { type: 'tool-result', id, result|error }
9. on disconnect (extension side or host crash), the channel closes; chrome.runtime.connectNative returns
   onDisconnect; chromatika reconnects with exp backoff (5 attempts, 1s → 30s)
```

## frame types chromatika sends

extension → host:

- `{ type: 'config', tokenHex }` - pushed on connect; sets the bearer token
- `{ type: 'tool-result', id, result }` - response to a tool-call
- `{ type: 'tool-result', id, error }` - error response
- `{ type: 'reconfigure-port', port }` - live port rebind request
- `{ type: 'ping' }` - liveness check

host → extension:

- `{ ok: true, kind: 'config-ack', hasToken }` - config acknowledged
- `{ kind: 'listen', host, port }` - HTTP listener bound
- `{ kind: 'rebind-error', desiredPort, error }` - failed to rebind to user-supplied port
- `{ ok: true, kind: 'pong', tsMs }` - ping response
- `{ type: 'tool-call', id, method, params }` - forward an MCP tool call to the extension
- `{ ok: true, kind: 'echo', received }` - debug echo for unknown frames

## the `setupBuffer` quirk

chrome may write multiple frames worth of bytes before the host's first read. the host accumulates everything in a `buffer` and processes complete frames in a loop (`while (buffer.length >= 4 + msgLen)`). this is correct for both single-frame writes and merged-write cases.

if you implement a similar host, **don't** assume one read = one frame. always buffer + parse-while-complete-frame-available.

## errors

- `parse error: Unexpected token`: a frame body isn't valid UTF-8 JSON. log to stderr, skip
- `expected json object`: a frame body is valid JSON but not an object (e.g. a literal string). log, skip
- `stdout write failed`: the parent (chrome) died. exit cleanly

stderr is the only diagnostic channel; chrome logs native host stderr to its own internal logs (`chrome://extensions` developer mode + chrome's stderr if launched from a terminal).

## library

- node.js built-ins: `node:http`, `node:crypto`, `node:readline`. **no npm dependencies**
- chromatika side: `chrome.runtime.connectNative` is browser native; `mcp-native-bridge.ts` wraps it for the service worker

## related

- [mcp-http-transport.md](/library/tech/mcp-http-transport) - what the host serves at `127.0.0.1:<port>/mcp`
- [mcp-tool-routing.md](/library/tech/mcp-tool-routing) - how `tool-call` and `tool-result` frames correlate
- [mcp-bearer-token-auth.md](/library/tech/mcp-bearer-token-auth) - the `{ type: 'config', tokenHex }` frame
- [mcp-reconfigure-port.md](/library/tech/mcp-reconfigure-port) - the `{ type: 'reconfigure-port', port }` frame
