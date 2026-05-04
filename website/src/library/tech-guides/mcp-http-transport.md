# MCP HTTP transport (`POST /mcp`)

the chromatika native messaging host hosts a localhost HTTP listener that speaks JSON-RPC 2.0 MCP. agent clients (Claude Desktop in HTTP MCP mode, Cursor, Cline) connect to `http://127.0.0.1:<port>/mcp` with a bearer token and call MCP methods. each request is one JSON-RPC frame; the response is one JSON-RPC response.

## the listener

```
http://127.0.0.1:<port>/mcp
```

- `127.0.0.1` only (never bound to `0.0.0.0`)
- port is **random by default** unless the user pinned a fixed port via settings (see [mcp-reconfigure-port.md](/library/tech/mcp-reconfigure-port))
- single endpoint: `POST /mcp`. no other paths. GETs return 404
- spawned by the native messaging host using node's `node:http` `createServer`

## request

```http
POST /mcp HTTP/1.1
Host: 127.0.0.1:<port>
Content-Type: application/json
Authorization: Bearer <tokenHex>
Content-Length: <N>

{"jsonrpc":"2.0","id":"abc-123","method":"tools/list","params":{}}
```

- `Authorization: Bearer <tokenHex>` is **required**. missing or wrong token returns `401 Unauthorized`
- `Content-Type` should be `application/json`
- body is a single JSON-RPC 2.0 frame

## response

```http
HTTP/1.1 200 OK
Content-Type: application/json
Content-Length: <N>

{"jsonrpc":"2.0","id":"abc-123","result":{"tools":[...]}}
```

or for errors:
```jsonc
{
  "jsonrpc": "2.0",
  "id": "abc-123",
  "error": {
    "code": -32603,
    "message": "Internal error",
    "data": { ... }
  }
}
```

JSON-RPC error codes used by chromatika:
- `-32700` parse error
- `-32600` invalid request
- `-32601` method not found
- `-32602` invalid params
- `-32603` internal error
- `-32000` to `-32099` reserved for chromatika-specific errors (e.g. wallet locked, user canceled, timeout)

HTTP status codes:
- `200 OK` for any well-formed JSON-RPC response (whether `result` or `error`)
- `400 Bad Request` for non-JSON or malformed body
- `401 Unauthorized` for missing / wrong bearer token
- `404 Not Found` for any path other than `/mcp`
- `405 Method Not Allowed` for non-POST requests
- `500 Internal Server Error` for host-side crashes (rare; usually still returns JSON-RPC error)

## the auth flow

1. extension generates a per-install random token at first MCP enable: `tokenHex = crypto.getRandomValues(32 bytes).toHex()`
2. extension persists `chromatika_mcp_v1.tokenHex` in `chrome.storage.local`
3. on `chrome.runtime.connectNative`, extension pushes `{ type: 'config', tokenHex }` to the host
4. host stores it in memory: `STATE.tokenHex = msg.tokenHex`
5. on every HTTP request, host validates `Authorization: Bearer <token>` against `STATE.tokenHex`
6. on rotate (`mcpRotateToken`), extension generates a new random token, pushes a fresh `{ type: 'config', tokenHex }` to the host - the new token takes effect immediately for subsequent requests; existing in-flight requests with the old token complete normally

see [mcp-bearer-token-auth.md](/library/tech/mcp-bearer-token-auth) for the full auth flow.

## why HTTP and not pure stdio

- HTTP MCP transport is a first-class option in the MCP spec. clients like Cursor / Cline support it natively
- localhost HTTP is testable via `curl` from the user's terminal - useful for debugging
- the host can serve multiple agent clients simultaneously over HTTP without managing concurrent stdio frames
- stdio bridge mode (see [mcp-stdio-bridge.md](/library/tech/mcp-stdio-bridge)) layers on top: the bridge process forwards stdio MCP to this HTTP transport, letting Claude Desktop (which only speaks stdio) drive the wallet

## the request → tool-call lifecycle

```
1. POST /mcp with method='tools/call' arrives
2. host validates auth
3. host parses JSON-RPC, extracts method + params
4. host writes a native-messaging frame to chrome:
   { type: 'tool-call', id: <correlation-id>, method, params }
5. host registers a pending Map entry { id → resolve, timeout }
6. extension service worker handles the tool-call, opens popups if needed,
   eventually responds with { type: 'tool-result', id, result|error }
7. host pops the pending entry, resolves the HTTP response
8. host writes JSON-RPC response back over HTTP
9. timeout: 5 minutes (TOOL_CALL_TIMEOUT_MS = 300_000). on timeout, return JSON-RPC error
   with code -32603 and message 'tool call timed out'
```

read-tier tools (`listVaults`, `getLockState`, etc.) resolve in well under a second. approve-tier tools wait on the user clicking through a popup - 5 min is the cap to allow careful reads.

## a working `curl` example

```sh
TOKEN=$(node -e "console.log(JSON.parse(fs.readFileSync('/path/to/chrome.storage.local')).chromatika_mcp_v1.tokenHex)")
curl -X POST http://127.0.0.1:54321/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":"1","method":"initialize","params":{}}'
```

response:
```json
{"jsonrpc":"2.0","id":"1","result":{"protocolVersion":"2025-03-26","serverInfo":{"name":"chromatika","version":"0.0.1"},"capabilities":{"tools":{"listChanged":false}}}}
```

## CORS and security

- localhost HTTP only (`127.0.0.1`)
- no CORS - the listener doesn't set `Access-Control-Allow-Origin` headers, so browsers can't reach it from arbitrary websites (browsers block fetch to localhost without CORS, and the chrome extension itself uses native messaging anyway, not HTTP)
- agent clients are typically native processes (Claude Desktop, Cursor) - they don't run in browsers, so CORS doesn't apply
- bearer token gates everything; without the token, an attacker on the same machine can't call MCP methods

threat model: any local process running as the same user **could** read `chrome.storage.local` (chrome's data dir is user-scoped) and grab the token. that's why the user-facing UI lets the user rotate the token at any time. for higher-trust deployments, ship a wrapper that restricts host spawning behind additional auth (out of scope for chromatika today).

## library

- `node:http` for the listener
- node-native `Buffer`, `JSON`, etc.
- no npm deps
- chromatika extension side: `mcp-storage.ts` for `chromatika_mcp_v1` persistence, `mcp-native-bridge.ts` for the connect / disconnect logic

## related

- [mcp-bearer-token-auth.md](/library/tech/mcp-bearer-token-auth) - token generation / rotation / validation
- [mcp-tool-routing.md](/library/tech/mcp-tool-routing) - tool-call / tool-result correlation
- [mcp-stdio-bridge.md](/library/tech/mcp-stdio-bridge) - the stdio companion for clients that don't speak HTTP MCP
- [mcp-reconfigure-port.md](/library/tech/mcp-reconfigure-port) - live port rebind
