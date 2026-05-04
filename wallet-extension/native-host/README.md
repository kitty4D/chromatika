# chromatika native messaging host

bridge process that lets external mcp-style clients talk to the chromatika wallet extension.

mv3 reality: extensions cannot bind a listening socket. so the wallet extension speaks to this host via chrome native messaging, and the host binds 127.0.0.1 + serves mcp clients (cursor, cline, claude desktop's remote-mcp variants, custom python loops, etc.). the host is spawned as a child of chrome the moment the extension calls `chrome.runtime.connectNative`.

## status

- chrome-spawned mode: native messaging host that binds 127.0.0.1:&lt;random-port&gt; and serves http MCP at `POST /mcp` with bearer auth. forwards `tools/list` and `tools/call` over native messaging to the extension. tools shipped today: read tier (`listVaults`, `getActiveVault`, `getActiveNetworks`, `getLockState`) plus approve tier (`signMessage`, `sendEvmTx`).
- stdio bridge mode (`--stdio-bridge`): for MCP clients that only speak stdio (Claude Desktop's default config). reads line-delimited JSON-RPC from stdin, forwards to the chrome-spawned http endpoint with bearer auth, writes responses back as json lines. configured via `CHROMATIKA_AGENT_URL` + `CHROMATIKA_AGENT_TOKEN` env vars.

## install (dev mode)

1. load chromatika unpacked from `wallet-extension/dist/` and grab the extension id from chrome://extensions.
2. from this directory, register the host:

   ```bash
   node setup.mjs --extension-id=<your-extension-id>
   ```

   pass `--browser=edge` / `--browser=brave` / `--browser=chromium` if you're not on stable chrome.

3. open chromatika → settings → agents (next-slice ui) and toggle the surface on. the extension will spawn this host via chrome native messaging.

windows note: setup.mjs writes a `chromatika-mcp-host.bat` shim alongside the host script and registers a HKCU registry value pointing at the manifest. `node` must be on PATH at the time chrome spawns the host.

## connecting Claude Desktop (or any stdio MCP client)

claude desktop spawns each MCP server as a child process and speaks line-delimited JSON-RPC over stdio - it doesn't talk to http MCP endpoints directly. the `--stdio-bridge` mode of this same binary is a tiny relay that forwards stdio JSON-RPC to the http endpoint the chrome-spawned host already exposes.

1. in chromatika settings → agents, enable the agent surface and copy the agent URL + bearer token.
2. add this entry to your `claude_desktop_config.json` (location varies by OS - claude desktop's settings panel shows the path):

   ```json
   {
     "mcpServers": {
       "chromatika": {
         "command": "node",
         "args": [
           "/abs/path/to/wallet-extension/native-host/chromatika-mcp-host.mjs",
           "--stdio-bridge"
         ],
         "env": {
           "CHROMATIKA_AGENT_URL": "http://127.0.0.1:<port>/mcp",
           "CHROMATIKA_AGENT_TOKEN": "<token-hex>"
         }
       }
     }
   }
   ```

3. restart claude desktop. it spawns the bridge once, sees the tool list (read + approve tier), and routes every claude-side `tools/call` through the bridge → http endpoint → extension → wallet.

caveat: the chrome-spawned http port is randomly assigned and changes each chrome restart. when the port changes, update the `CHROMATIKA_AGENT_URL` env var in the claude desktop config. a stable-port option lands in a follow-up slice (a fixed port toggle in settings).

cursor / cline / other stdio MCP clients use the same config shape; consult their docs for where their config file lives.

## what gets installed where

- the host script, the windows shim, and a manifest copy stay alongside this README.
- on macos / linux, an additional manifest copy is dropped in the browser's `NativeMessagingHosts` directory (under `~/Library/Application Support/...` or `~/.config/...`).
- on windows, a HKCU registry value at `HKCU\Software\<browser>\NativeMessagingHosts\com.chromatika.mcp.host` points at the manifest in this directory.

## uninstall

- macos / linux: delete `~/Library/Application Support/<browser>/NativeMessagingHosts/com.chromatika.mcp.host.json` (or the `~/.config/...` equivalent).
- windows: `reg delete HKCU\Software\Google\Chrome\NativeMessagingHosts\com.chromatika.mcp.host /f` (adjust for your browser).

## debugging

- chrome captures the host's stderr in the extension service worker logs. open `chrome://extensions`, click "service worker" on the chromatika row, then watch the console.
- if the host fails to spawn, chrome surfaces the reason via `chrome.runtime.lastError` on `connectNative`. the chromatika settings page (next slice) renders this.
- the host also writes its `listen` event to stderr so you can confirm the bound port in the same log.

## security model (v1)

- the wallet sends a per-install token via a `{ type: 'config', tokenHex }` frame on connect. the host stores it in memory only - never to disk.
- the http listener does not authenticate yet (returns 503 unconditionally). once the real transport mounts in the next slice, the host will require the token in every request.
- the host listens only on `127.0.0.1`. nothing reachable over a network.
- chrome's `allowed_origins` in the manifest restricts which extension can spawn this host - only the chromatika extension id you passed to `setup.mjs`.
