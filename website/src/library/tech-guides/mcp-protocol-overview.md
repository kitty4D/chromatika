# MCP protocol overview (chromatika)

chromatika exposes a **Model Context Protocol** (MCP) surface so AI agents (Claude Desktop, Cursor, Cline, Zed, etc.) can read wallet state and request signed actions, with user approval popups for anything that signs. MCP is Anthropic's spec for "tools an LLM can call". chromatika hand-rolls the protocol over JSON-RPC 2.0 - **no `@modelcontextprotocol/sdk` dependency**. the native messaging host (`wallet-extension/native-host/chromatika-mcp-host.mjs`) is a "zero-deps node script".

## protocol version

```js
const MCP_PROTOCOL_VERSION = '2025-03-26';
```

defined in the native host. clients negotiate this on `initialize`. when MCP spec bumps, update this constant + verify backward-compat with deployed agent clients.

## the methods we implement

JSON-RPC 2.0 methods chromatika serves over `POST /mcp`:

- `initialize` - client / server handshake. server returns `{ protocolVersion, serverInfo, capabilities }`
- `tools/list` - server returns the list of tools (name, description, JSON schema for params)
- `tools/call` - client invokes a tool by name with params. server returns the tool's structured result or an error

we **don't** implement (yet):
- `tools/list_changed` server-to-client notifications (no SSE transport yet)
- `prompts/*` (prompt templates surface)
- `resources/*` (resource discovery surface)
- `logging/*` (server-pushed log streaming)
- `sampling/*` (server requesting LLM sampling on the client)

these are MCP capabilities chromatika doesn't need today. the spec is layered - you can implement just `tools/*` and that's a valid minimal MCP server.

## server info we report

```jsonc
{
  "name": "chromatika",
  "version": "0.0.1"
}
```

returned in the `initialize` response. clients use this to display "connected to chromatika 0.0.1" in their agent settings.

## capabilities

```jsonc
{
  "tools": {
    "listChanged": false   // we don't push tools/list_changed notifications today
  }
}
```

minimal capability declaration. when SSE arrives, flip `listChanged: true`.

## the wire format

JSON-RPC 2.0 over either:
1. **HTTP** - `POST http://127.0.0.1:<port>/mcp` with `Authorization: Bearer <tokenHex>` and `Content-Type: application/json`. body is one JSON-RPC request, response is one JSON-RPC response. see [mcp-http-transport.md](/library/tech/mcp-http-transport)
2. **stdio bridge** - line-delimited JSON-RPC 2.0 on stdin / stdout. forwards to the HTTP transport. see [mcp-stdio-bridge.md](/library/tech/mcp-stdio-bridge)

every JSON-RPC frame has the standard shape:
```jsonc
// request
{ "jsonrpc": "2.0", "id": "abc-123", "method": "tools/call", "params": { ... } }

// response
{ "jsonrpc": "2.0", "id": "abc-123", "result": { ... } }
// or
{ "jsonrpc": "2.0", "id": "abc-123", "error": { "code": -32603, "message": "...", "data": ... } }
```

`id` is whatever the client sets - chromatika echoes it. this is how clients correlate request → response.

## the read tier (no popup)

these tools resolve immediately, no user interaction:
- `listVaults` - returns vault metadata (id, label, base chain, primary credential type, dWallet count)
- `getActiveVault` - returns the currently active vault id + summary
- `getActiveNetworks` - returns active EVM chain id, active Solana network, active Sui network, etc.
- `getLockState` - returns `{ locked: bool, autoLockMinutes? }`

internal implementation: each maps to an existing tRPC procedure. the native bridge correlates `tool-call` envelopes back to `tool-result` envelopes (see [mcp-tool-routing.md](/library/tech/mcp-tool-routing)).

## the approve tier (popup-gated)

these tools open a chromatika popup for user approval before signing:
- `signMessage({ chain: 'evm' | 'solana', messageHex, evmChainId? })` - opens `McpApprovalScreen` → ika MPC signs → returns `{ chain, signatureHex, signerAddress }`
- `sendEvmTx({ to, value?, data?, chainId?, gas?, ... })` - opens existing `ApproveTxScreen` with full gas / sim UI → `signAndBroadcastEvm` → returns broadcast tx hash
- `signTransaction({ to, value?, data?, chainId?, gas?, ... })` - same popup with "sign only - no broadcast" banner → `signEvmTxOnly` → returns `{ signedRawTx, txHash }`

the popup-gated tools share the same wait pattern: tool-call enqueues a request, opens the popup, waits up to 5 minutes (`TOOL_CALL_TIMEOUT_MS = 300_000`) for resolution. if the user closes the popup or doesn't respond, the tool call returns an error.

## tool definitions surface

tools are described to the LLM via JSON Schema:
```jsonc
{
  "name": "signMessage",
  "description": "Sign an arbitrary message with the active dWallet. Opens a user approval popup. Returns { chain, signatureHex, signerAddress }.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "chain": { "type": "string", "enum": ["evm", "solana"] },
      "messageHex": { "type": "string", "pattern": "^(0x)?[0-9a-fA-F]+$" },
      "evmChainId": { "type": "integer", "minimum": 1, "nullable": true }
    },
    "required": ["chain", "messageHex"]
  }
}
```

the LLM reads `description` + `inputSchema` to decide when / how to call the tool. clear, minimal descriptions matter - the LLM only knows what we tell it via these fields.

## why hand-roll vs `@modelcontextprotocol/sdk`

the SDK is great for production servers but adds dep weight and abstractions chromatika doesn't need:
- chromatika's MCP server is **stateless beyond the per-call envelope correlation**. no session memory, no streaming, no resource subscriptions
- chromatika needs to bridge **chrome native messaging** (4-byte LE length prefix) on one side and **HTTP MCP** on the other - the SDK doesn't have a chrome-native-messaging transport
- a "zero-deps node script" is easier to ship as a setup artifact (`pnpm setup:native-host` writes the script to the right OS-specific native messaging directory) - no node_modules to bundle
- the protocol itself is small. the entire native host is ~500 lines

if MCP gains complexity (SSE, sampling, resources), revisit.

## related docs

- [mcp-native-messaging-frame.md](/library/tech/mcp-native-messaging-frame) - how chrome ↔ host frames work
- [mcp-http-transport.md](/library/tech/mcp-http-transport) - the localhost HTTP MCP listener
- [mcp-stdio-bridge.md](/library/tech/mcp-stdio-bridge) - the `--stdio-bridge` mode for Claude Desktop
- [mcp-tool-routing.md](/library/tech/mcp-tool-routing) - tool-call envelope correlation through native messaging
- [mcp-bearer-token-auth.md](/library/tech/mcp-bearer-token-auth) - per-install token + rotation
- [mcp-reconfigure-port.md](/library/tech/mcp-reconfigure-port) - live port rebind protocol
- [mcp-host-spawn-and-setup.md](/library/tech/mcp-host-spawn-and-setup) - per-OS native host registration
