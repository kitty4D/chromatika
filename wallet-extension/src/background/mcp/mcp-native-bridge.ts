/**
 * mcp-native-bridge - background-side wrapper around chrome.runtime.connectNative.
 *
 * the chrome native messaging port is the only way an mv3 sw can talk to a long-lived helper
 * process. this module:
 *   - holds at most one port to `com.chromatika.mcp.host` while the surface is enabled.
 *   - pushes the per-install token to the host on connect so it can authenticate mcp clients.
 *   - exposes a status snapshot + listenPort so the settings ui can render real state.
 *   - reconnects with capped exponential backoff if the host disconnects unexpectedly.
 *
 * native-host messages this slice handles:
 *   - `{ kind: 'listen', host, port }` - host advertises the localhost port it bound; cached
 *     on disk so future ui mounts can render it without a live connection.
 *   - `{ kind: 'listen-error', error }` - host failed to bind.
 *   - `{ kind: 'pong' | 'config-ack' | 'echo', ... }` - diagnostics, currently ignored.
 */

import { getMcpConfig, patchMcpConfig } from './mcp-storage';
import { MCP_TOOLS, dispatchMcpToolCall } from './mcp-tools';

export type NativeHostStatus = {
  connected: boolean;
  listenPort: number | null;
  lastConnectAtMs: number | null;
  lastDisconnectAtMs: number | null;
  lastErrorMessage: string | null;
  reconnectAttempts: number;
};

let port: chrome.runtime.Port | null = null;
let status: NativeHostStatus = {
  connected: false,
  listenPort: null,
  lastConnectAtMs: null,
  lastDisconnectAtMs: null,
  lastErrorMessage: null,
  reconnectAttempts: 0,
};

let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
const RECONNECT_MAX_ATTEMPTS = 5;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

function clearReconnect(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect(): void {
  clearReconnect();
  if (status.reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
    return;
  }
  const delay = Math.min(
    RECONNECT_BASE_MS * Math.pow(2, status.reconnectAttempts),
    RECONNECT_MAX_MS,
  );
  reconnectTimer = setTimeout(() => {
    void connectNativeHost();
  }, delay);
}

export function getNativeHostStatus(): NativeHostStatus {
  return { ...status };
}

export async function connectNativeHost(): Promise<void> {
  if (port) return;

  const config = await getMcpConfig();
  if (!config.enabled) return;

  let newPort: chrome.runtime.Port;
  try {
    newPort = chrome.runtime.connectNative(config.nativeHostName);
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : String(e);
    status = {
      ...status,
      connected: false,
      lastErrorMessage: errorMessage,
      reconnectAttempts: status.reconnectAttempts + 1,
    };
    scheduleReconnect();
    return;
  }

  port = newPort;
  status = {
    ...status,
    connected: true,
    lastConnectAtMs: Date.now(),
    lastErrorMessage: null,
    reconnectAttempts: 0,
  };

  newPort.onMessage.addListener((message) => {
    void handleHostMessage(message);
  });

  newPort.onDisconnect.addListener(() => {
    // chrome.runtime.lastError is the canonical failure reason here. it's set to "Specified
    // native messaging host not found." when the host isn't registered, or e.g. "Native host
    // has exited." if the process crashed.
    const errorMessage = chrome.runtime.lastError?.message ?? null;
    port = null;
    status = {
      ...status,
      connected: false,
      lastDisconnectAtMs: Date.now(),
      lastErrorMessage: errorMessage,
      reconnectAttempts: status.reconnectAttempts + 1,
    };
    void getMcpConfig().then((cfg) => {
      if (cfg.enabled) scheduleReconnect();
    });
  });

  try {
    newPort.postMessage({ type: 'config', tokenHex: config.tokenHex });
    if (typeof config.desiredListenPort === 'number' && config.desiredListenPort > 0) {
      // host bound a random port first; ask it to rebind to the user's chosen port. on
      // failure the host falls back to the random port and reports `kind: 'rebind-error'`.
      newPort.postMessage({ type: 'reconfigure-port', port: config.desiredListenPort });
    }
  } catch (e) {
    console.warn('mcp-native-bridge: initial postMessage failed', e);
  }
}

export function disconnectNativeHost(): void {
  clearReconnect();
  if (port) {
    try {
      port.disconnect();
    } catch {
      /* already gone */
    }
    port = null;
  }
  status = {
    ...status,
    connected: false,
    listenPort: null,
    lastDisconnectAtMs: Date.now(),
    reconnectAttempts: 0,
  };
}

export function pushConfigToHost(): void {
  if (!port) return;
  void getMcpConfig().then((cfg) => {
    try {
      port?.postMessage({ type: 'config', tokenHex: cfg.tokenHex });
    } catch (e) {
      console.warn('mcp-native-bridge: pushConfigToHost failed', e);
    }
  });
}

type HostMessage = {
  type?: string;
  kind?: string;
  ok?: boolean;
  host?: string;
  port?: number;
  error?: string;
  tsMs?: number;
  hasToken?: boolean;
  received?: unknown;
  // tool-call envelope (host → ext)
  id?: string;
  method?: string;
  params?: unknown;
};

async function handleHostMessage(rawMessage: unknown): Promise<void> {
  if (!rawMessage || typeof rawMessage !== 'object') return;
  const message = rawMessage as HostMessage;

  // tool dispatch path: host forwards mcp tools/list and tools/call requests through native
  // messaging. correlation `id` is echoed back so the host can route the response to the
  // waiting http client.
  if (message.type === 'tool-call' && typeof message.id === 'string' && typeof message.method === 'string') {
    await handleToolCall(message.id, message.method, message.params);
    return;
  }

  if (message.kind === 'listen' && typeof message.port === 'number' && message.port > 0) {
    status = { ...status, listenPort: message.port };
    await patchMcpConfig({ listenPort: message.port });
    return;
  }

  if (message.kind === 'listen-error' && typeof message.error === 'string') {
    status = { ...status, lastErrorMessage: `host bind failed: ${message.error}` };
    return;
  }

  if (message.kind === 'rebind-error' && typeof message.error === 'string') {
    // host failed to bind the user's desired port; it stays on its random fallback. surface
    // the failure in status so the settings UI can show "couldn't bind 31415; using <random>".
    status = { ...status, lastErrorMessage: `desired port bind failed: ${message.error}` };
    return;
  }

  // pong / config-ack / echo: diagnostics; nothing to persist.
}

/**
 * push the user's desired listen port to the running host. called when the user changes the
 * port in settings; the bridge already pushes on connect for the chrome-restart case.
 */
export function pushDesiredPortToHost(): void {
  if (!port) return;
  void getMcpConfig().then((cfg) => {
    if (typeof cfg.desiredListenPort !== 'number' || cfg.desiredListenPort <= 0) {
      // user cleared the desired port: tell host to stay on whatever it bound.
      // (we could request a rebind to a fresh random port, but that breaks active client
      // connections without warning. simpler: leave the current binding alone until the
      // next chrome restart picks up the cleared setting.)
      return;
    }
    try {
      port?.postMessage({ type: 'reconfigure-port', port: cfg.desiredListenPort });
    } catch (e) {
      console.warn('mcp-native-bridge: pushDesiredPortToHost failed', e);
    }
  });
}

async function handleToolCall(id: string, method: string, params: unknown): Promise<void> {
  if (method === 'tools/list') {
    sendToHost({ type: 'tool-result', id, result: { tools: MCP_TOOLS } });
    return;
  }

  if (method === 'tools/call') {
    const callParams = (params ?? {}) as { name?: string; arguments?: unknown };
    if (typeof callParams.name !== 'string') {
      sendToHost({
        type: 'tool-result',
        id,
        error: { code: -32602, message: 'tools/call requires `name` (string)' },
      });
      return;
    }
    const out = await dispatchMcpToolCall(callParams.name, callParams.arguments);
    if (out.ok) {
      // mcp tools/call result shape: { content: [...], isError?: boolean }. v1 wraps the
      // tool's structured result as a single text-content block so any mcp client can render
      // it without needing custom content types.
      sendToHost({
        type: 'tool-result',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(out.result) }],
        },
      });
    } else {
      sendToHost({
        type: 'tool-result',
        id,
        error: out.error,
      });
    }
    return;
  }

  sendToHost({
    type: 'tool-result',
    id,
    error: { code: -32601, message: `unknown method: ${method}` },
  });
}

function sendToHost(message: unknown): void {
  if (!port) return;
  try {
    port.postMessage(message);
  } catch (e) {
    console.warn('mcp-native-bridge: sendToHost failed', e);
  }
}
