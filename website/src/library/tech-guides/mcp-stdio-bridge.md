# MCP stdio bridge mode (`--stdio-bridge`)

Claude Desktop's default MCP transport is **stdio** - the client spawns a child process and exchanges line-delimited JSON-RPC frames over stdin / stdout. chromatika's native host, when invoked with `--stdio-bridge`, acts as a thin shim: read JSON-RPC from stdin, forward to the chrome-spawned HTTP MCP host, write the response back to stdout. this lets stdio-only clients drive chromatika.

## why a separate mode

the chrome-spawned native messaging host (no flag) reads **4-byte-LE-length-prefixed** frames from stdin (chrome's wire format) and serves HTTP MCP on a localhost port. but Claude Desktop sends **line-delimited JSON** without length prefixes. we can't make one process speak both at the same time, so the same binary supports two modes:

| invocation | who spawns it | reads from stdin | writes to stdout | also serves HTTP MCP |
|------------|---------------|------------------|------------------|---------------------|
| (no flag) | chrome via `chrome.runtime.connectNative` | 4-byte-LE-length frames | 4-byte-LE-length frames | yes, on `127.0.0.1:<port>/mcp` |
| `--stdio-bridge` | stdio MCP client (Claude Desktop) | line-delimited JSON | line-delimited JSON | no - bridges to the existing HTTP transport |

both modes run from the **same binary** (`chromatika-mcp-host.mjs`). the flag dispatches at startup.

## startup

```js
const STDIO_BRIDGE_FLAG = '--stdio-bridge';
const isStdioBridge = process.argv.includes(STDIO_BRIDGE_FLAG);

if (isStdioBridge) {
  await runStdioBridge();
  process.exit(0);
}

// otherwise: native messaging host mode
```

`runStdioBridge` reads `$CHROMATIKA_AGENT_URL` (e.g. `http://127.0.0.1:54321/mcp`) and `$CHROMATIKA_AGENT_TOKEN` (the per-install bearer token) from environment variables. these point at the chrome-spawned HTTP MCP listener.

## the bridge loop

```js
async function runStdioBridge() {
  const url = process.env.CHROMATIKA_AGENT_URL;
  const token = process.env.CHROMATIKA_AGENT_TOKEN;
  if (!url || !token) {
    console.error('missing CHROMATIKA_AGENT_URL or CHROMATIKA_AGENT_TOKEN env vars');
    process.exit(1);
  }

  const rl = createInterface({ input: process.stdin });

  for await (const line of rl) {
    if (!line.trim()) continue;

    let req;
    try { req = JSON.parse(line); }
    catch (e) {
      stdoutWrite({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
      continue;
    }

    try {
      const httpResp = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(req),
      });
      const body = await httpResp.json();
      stdoutWrite(body);
    } catch (e) {
      stdoutWrite({
        jsonrpc: '2.0',
        id: req.id ?? null,
        error: { code: -32603, message: 'bridge upstream error: ' + (e.message ?? String(e)) }
      });
    }
  }

  process.exit(0);
}

function stdoutWrite(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}
```

per-line read, fetch to the HTTP MCP, write the response with a trailing newline. exits when stdin closes (parent client disconnected).

## env-var configuration (the manual update problem)

```
CHROMATIKA_AGENT_URL=http://127.0.0.1:54321/mcp
CHROMATIKA_AGENT_TOKEN=abcdef0123...
```

these are baked into Claude Desktop's MCP config:
```jsonc
{
  "mcpServers": {
    "chromatika": {
      "command": "node",
      "args": ["/path/to/chromatika-mcp-host.mjs", "--stdio-bridge"],
      "env": {
        "CHROMATIKA_AGENT_URL": "http://127.0.0.1:54321/mcp",
        "CHROMATIKA_AGENT_TOKEN": "abcdef0123..."
      }
    }
  }
}
```

since the chrome-spawned HTTP host's port is **random by default**, every chrome restart can change the port → user has to update Claude Desktop config and restart Claude. fixing this is what `mcpSetDesiredPort` (see [mcp-reconfigure-port.md](/library/tech/mcp-reconfigure-port)) addresses: pin a fixed port (1024-65535) so the URL stays stable across restarts.

bearer token similarly persists in chromatika's `chromatika_mcp_v1.tokenHex` storage, but rotating it (via `mcpRotateToken`) requires updating the env var too. acceptable tradeoff for now; tracked future is "durable port registration so stdio-bridge users don't need to manually update env vars."

## what the bridge doesn't do

- no caching, no rate limiting, no transformation - it's a 1:1 forwarder
- no concurrency management - JSON-RPC is request/response, line-by-line; if a client sends two requests rapidly, they're processed sequentially (the next loop iteration only starts after the previous response is written)
- no SSE or other streaming - if MCP gains server-initiated notifications (`tools/list_changed`, sampling, etc.), the bridge will need event-stream support. tracked future
- no auth-elevation - stdio clients pass through the same bearer token the chrome-spawned host validates

## error semantics

- non-JSON input line → JSON-RPC parse error response with `id: null`
- HTTP fetch error (host not running, port wrong, etc.) → JSON-RPC `-32603` internal error response with `id` echoed
- bearer token rejected by HTTP host → returns 401, bridge wraps it as JSON-RPC `-32603` with the 401 message

## why not implement MCP fully in the bridge

the bridge could in principle implement MCP itself instead of forwarding. but then it'd need to:
- understand chromatika's tool catalog
- talk to the chrome extension over... some other channel
- duplicate auth logic

since the chrome-spawned host already does all this and exposes HTTP MCP, the simplest design is **bridge stdio → HTTP**. one source of truth.

## library

- `node:readline` for line-by-line stdin
- `fetch` (native in Node 18+)
- environment variables via `process.env`
- no npm deps

## related

- [mcp-protocol-overview.md](/library/tech/mcp-protocol-overview) - MCP method set
- [mcp-http-transport.md](/library/tech/mcp-http-transport) - the upstream the bridge forwards to
- [mcp-bearer-token-auth.md](/library/tech/mcp-bearer-token-auth) - token model the bridge passes through
- [mcp-reconfigure-port.md](/library/tech/mcp-reconfigure-port) - solves the "port changes on chrome restart" pain
