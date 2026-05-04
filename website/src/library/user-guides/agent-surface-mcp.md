# how to use the agent surface (MCP)

chromatika exposes a Model Context Protocol (MCP) surface so AI agents (Claude Desktop, Cursor, Cline, etc.) can read wallet state and request signed actions, with user approval popups for anything that signs. the bridge runs through a chrome native messaging host that listens on `127.0.0.1:<port>` (HTTP MCP) or accepts stdio bridging for clients that only speak stdio.

## prerequisites

- chromatika is installed and unlocked at least once (the read tier respects lock state)
- you've registered the native host on your OS once: `pnpm setup:native-host --extension-id=<id>`. this writes the per-OS native messaging directory entry (and on Windows a `.bat` shim + `reg add`)
- the agent client (Claude Desktop, Cursor, etc.) has chromatika configured as an MCP server pointing at the agent URL

## options at a glance

- **enable / disable**: turn the surface on or off (off = no listener, no native host)
- **bearer token**: per-install token, gates the HTTP MCP listener. reveal, copy, or rotate at any time
- **listen port**: random by default; you can pin one (1024-65535) so Claude Desktop config doesn't churn across chrome restarts
- **stdio bridge**: same binary supports `--stdio-bridge` for stdio MCP clients. the bridge forwards line-delimited JSON-RPC to the chrome-spawned host
- **read tier** (no popup): `listVaults`, `getActiveVault`, `getActiveNetworks`, `getLockState`
- **approve tier** (popup-gated): `signMessage`, `sendEvmTx`, `signTransaction`

## how to enable the agent surface

1. call `mcpStatus` to see current state (`{ enabled, tokenHex, listenHost, listenPort, ... }`)
2. submit `mcpEnable` - background generates a token if missing, spawns the native host via `chrome.runtime.connectNative`, exponential backoff on connect (5 attempts, 1s → 30s)
3. poll `mcpStatus` until the host reports an active port
4. configure your agent client with the agent URL (typically `http://127.0.0.1:<port>/mcp`) plus the bearer token

## how to disable the agent surface

1. submit `mcpDisable`
2. background sends teardown to the host, drops the native port, clears stale state
3. `mcpStatus` reflects the disabled state

## how to view, copy, or rotate the bearer token

1. read with `mcpStatus` (returns `tokenHex`)
2. rotate with `mcpRotateToken` - generates a fresh token, pushes to the running host so the new token is live immediately. update your agent client to use the new token

## how to set a fixed listen port

1. submit `mcpSetDesiredPort` with `port` (1024-65535) or `null` to clear
2. the host tries that port on startup; if it's already taken (other process), the host falls back to a random port and surfaces the actual port in `mcpStatus`
3. setting a stable port avoids reconfiguring Claude Desktop after every chrome restart

## how to approve an incoming MCP sign request

read tier returns immediately. approve tier opens a popup at `?mcpapprove=<id>`:

1. popup calls `getPendingMcpSignRequest` with the id
2. response includes: `chain` (`'evm' | 'solana'`), `messageHex`, optional `evmChainId` (for `signMessage` of EVM messages)
3. submit `approvePendingMcpSign` with the id - background signs via ika MPC, returns `{ chain, signatureHex, signerAddress }` to the agent
4. submit `rejectPendingMcpSign` with id and `reason` (default `'user_canceled'`) to deny

## how the approve tier maps to existing flows

- `signMessage` ({ chain, messageHex, evmChainId? }) → `McpApprovalScreen` popup → ika MPC signs → returns `{ chain, signatureHex, signerAddress }`
- `sendEvmTx` ({ to, value?, data?, chainId?, gas?, ... }) → existing tx-approval popup with full gas / sim UI → `signAndBroadcastEvm` → returns broadcast tx hash
- `signTransaction` ({ to, value?, data?, chainId?, gas?, ... }) → same popup with "sign only - no broadcast" banner → `signEvmTxOnly` → returns `{ signedRawTx, txHash }` for relayer / bundler / abstract-wallet flows

## notes

- the read tier is genuinely no-popup: agents that just need to know your active vault / lock state can poll without bothering you
- the approve tier always pops user-visible UI - chromatika does not let an agent sign silently
- per-port rebind is handled by the host receiving `{ type: 'reconfigure-port' }`; if bind fails the host falls back to random and reports
- a Solana sendTx MCP tool is tracked as future. today MCP can sign Solana messages (read tier returns the address), but sending Solana goes through the existing dapp / wallet UI paths
- nonce-race for `signTransaction`: nonce is reserved at sign time but a slow caller can race; if real users hit this, a "reserve nonce in extension state" pattern is on the future list
