/**
 * mcp foundation: shared constants + storage shape.
 *
 * win 3 of the brainstorm plan. v1 only stores config; the native host process and the readonly
 * tool wrappers land in subsequent slices. transport choice (native messaging) is forced by MV3:
 * the extension cannot bind a listening socket itself, so the host process binds 127.0.0.1 and
 * the extension talks to it over chrome.runtime.connectNative.
 */

import { STORAGE_KEYS } from '@/background/storage';

export const MCP_CONFIG_VERSION = 1 as const;
export const MCP_STORAGE_KEY = STORAGE_KEYS.MCP_V1;
export const MCP_NATIVE_HOST_NAME = 'com.chromatika.mcp.host';
export const MCP_LISTEN_HOST = '127.0.0.1';

export type McpConfigV1 = {
  v: typeof MCP_CONFIG_VERSION;
  enabled: boolean;
  tokenHex: string;
  /** currently-bound port reported by the native host (`{ kind: 'listen', port }`). */
  listenPort: number | null;
  listenHost: typeof MCP_LISTEN_HOST;
  nativeHostName: typeof MCP_NATIVE_HOST_NAME;
  /**
   * optional fixed port the host should try to bind. `null` = use a random port (default
   * behavior). set this when configuring claude desktop / cursor / cline so the URL stays
   * stable across chrome restarts. if the host can't bind the requested port (collision /
   * permissions), it falls back to random and surfaces an error in the status.
   */
  desiredListenPort: number | null;
};

export type McpStatusOutput = {
  enabled: boolean;
  tokenHex: string;
  listenHost: string;
  listenPort: number | null;
  nativeHostName: string;
  configVersion: number;
  desiredListenPort: number | null;
};
