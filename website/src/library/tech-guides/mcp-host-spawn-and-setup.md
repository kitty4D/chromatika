# MCP host spawn + per-OS setup

`chrome.runtime.connectNative('com.chromatika.mcp_host')` only works if the OS has a **native messaging manifest** registered for that host name + the chromatika extension id. the manifest tells chrome where the host binary lives and which extensions are allowed to spawn it. chromatika ships a setup script (`pnpm setup:native-host --extension-id=<id>`) that writes the manifest in the right per-OS location.

## the manifest

```jsonc
{
  "name": "com.chromatika.mcp_host",
  "description": "Chromatika MCP native messaging host",
  "path": "/absolute/path/to/chromatika-mcp-host.mjs",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://<your-extension-id>/"
  ]
}
```

required fields:
- `name`: must match what chromatika passes to `connectNative`. **must be lowercase + dots/underscores only** per chrome's spec
- `description`: free-form
- `path`: absolute path to the host binary (or a wrapper script)
- `type`: always `"stdio"` for native messaging
- `allowed_origins`: list of `chrome-extension://...` origins permitted to spawn this host. **`<your-extension-id>` is install-specific** - hence the `--extension-id=` flag on the setup script

## per-OS manifest locations

per chrome's [native messaging docs](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging):

### macOS

user-level (no admin needed):
```
~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.chromatika.mcp_host.json
```

system-level (admin):
```
/Library/Google/Chrome/NativeMessagingHosts/com.chromatika.mcp_host.json
```

chromatika setup writes the user-level path.

### Linux

user-level:
```
~/.config/google-chrome/NativeMessagingHosts/com.chromatika.mcp_host.json
```

system-level:
```
/etc/opt/chrome/native-messaging-hosts/com.chromatika.mcp_host.json
```

chromatika setup writes user-level.

### Windows

user-level uses **registry** (no JSON manifest in a known directory; instead a registry value points at the manifest):
```
HKEY_CURRENT_USER\Software\Google\Chrome\NativeMessagingHosts\com.chromatika.mcp_host
  (Default) = "C:\path\to\manifest.json"
```

system-level:
```
HKEY_LOCAL_MACHINE\Software\Google\Chrome\NativeMessagingHosts\com.chromatika.mcp_host
```

windows also requires the host to be invokable - `node` may not be on `PATH` for the chrome process, so chromatika ships a `.bat` shim:
```bat
@echo off
node "%~dp0chromatika-mcp-host.mjs" %*
```

manifest's `path` points at the `.bat`, which `cmd.exe` invokes via `node`. the manifest goes in a per-user directory; the `reg add` registers the path.

## the setup command

```sh
pnpm setup:native-host --extension-id=<your-extension-id>
```

the script lives at `wallet-extension/native-host/setup.mjs`. it:
1. detects platform (`process.platform`)
2. computes the manifest JSON with the right `path` and `allowed_origins`
3. writes the manifest to the OS-specific user-level location
4. on Windows, also drops the `.bat` shim and runs `reg add` for the registry value
5. validates by running `chrome.runtime.connectNative` from the extension and checking `onDisconnect.lastError`

on success, the extension can call `connectNative('com.chromatika.mcp_host')` and chrome spawns the host.

## the spawn lifecycle

```
1. extension calls chrome.runtime.connectNative('com.chromatika.mcp_host')
2. chrome reads the manifest from the per-OS location
3. chrome verifies the calling extension's origin is in allowed_origins
4. chrome spawns the host binary as a child process:
     - stdin/stdout piped to chrome (4-byte LE length-prefixed frames)
     - stderr available to chrome's internal logging
5. chrome returns a Port object to the extension
6. host begins reading frames, ready to handle config push
7. extension pushes { type: 'config', tokenHex } as the first frame
8. host stores the token, opens HTTP MCP listener, sends { kind: 'listen' } frame
9. all subsequent MCP requests flow through this channel
```

## what kills the host process

- extension calls `port.disconnect()` (e.g. user disabled MCP via `mcpDisable`)
- chrome itself shuts down (browser quit)
- host process crashes (exits)
- network host name change (rare)

on disconnect, chrome cleans up the child. host's `process.stdin` closes, the readline / buffer-process loop exits, host exits.

## the auto-reconnect behavior

chromatika's `mcp-native-bridge.ts` does **capped exponential backoff** on disconnect:
- max attempts: 5
- delay: starts at 1s, doubles each attempt, capped at 30s
- delays: 1s → 2s → 4s → 8s → 16s → 30s, 30s

after 5 attempts, give up; user has to manually `mcpEnable` again to retry. this prevents zombie reconnect loops if the host binary is missing / broken.

reconnect rebinds the same port if `desiredListenPort` is set, otherwise picks a fresh random port.

## the SW startup re-establish

on cold service worker start (chrome unloaded the SW after idle):
1. SW reads `chromatika_mcp_v1.enabled`
2. if `enabled === true`, attempt `connectNative` immediately
3. retry on failure with the backoff schedule

this keeps the host alive across SW restart cycles without user action.

## why the install needs the extension id

`allowed_origins` in the manifest is the security boundary - **only the listed extension(s) can spawn this host**. without it, any extension installed on the user's chrome could call `connectNative` and drive the wallet. that's why the setup script requires `--extension-id=<id>`:
1. user opens `chrome://extensions`
2. enables developer mode
3. copies the chromatika extension id
4. runs `pnpm setup:native-host --extension-id=<that-id>`

dev installs and production-published extensions have **different extension ids**, so the manifest needs to be regenerated when switching between them.

## what `pnpm setup:native-host` does (Windows)

```
1. compute paths:
     hostBinary = wallet-extension/native-host/chromatika-mcp-host.mjs
     batShim    = wallet-extension/native-host/chromatika-mcp-host.bat
     manifest   = %APPDATA%/chromatika/com.chromatika.mcp_host.json

2. write batShim:
     @echo off
     node "%~dp0chromatika-mcp-host.mjs" %*

3. write manifest at the chosen path with `path` pointing at batShim

4. reg add HKCU\Software\Google\Chrome\NativeMessagingHosts\com.chromatika.mcp_host /ve /d "<manifest-path>" /f

5. echo a one-line success line + the registered path
```

## what `pnpm setup:native-host` does (macOS)

```
1. hostBinary = wallet-extension/native-host/chromatika-mcp-host.mjs
2. ensure shebang: '#!/usr/bin/env node' at the top of hostBinary (it already has this)
3. chmod +x hostBinary
4. write manifest at:
     ~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.chromatika.mcp_host.json
   with path = absolute path to hostBinary
5. echo success
```

## what `pnpm setup:native-host` does (Linux)

```
1. hostBinary = wallet-extension/native-host/chromatika-mcp-host.mjs
2. ensure shebang + chmod +x
3. write manifest at:
     ~/.config/google-chrome/NativeMessagingHosts/com.chromatika.mcp_host.json
   with path = absolute path to hostBinary
```

## library

- `node:fs` for writing the manifest
- `node:os` for `homedir()` resolution
- `node:child_process` for the Windows `reg add` invocation
- internal: `wallet-extension/native-host/setup.mjs` for the orchestration

## related

- [mcp-protocol-overview.md](/library/tech/mcp-protocol-overview) - what the host serves once spawned
- [mcp-native-messaging-frame.md](/library/tech/mcp-native-messaging-frame) - the wire format chrome ↔ host uses
- [mcp-http-transport.md](/library/tech/mcp-http-transport) - the localhost HTTP MCP the host opens
- [mcp-stdio-bridge.md](/library/tech/mcp-stdio-bridge) - the alternate `--stdio-bridge` invocation mode
