import {
  MCP_CONFIG_VERSION,
  MCP_LISTEN_HOST,
  MCP_NATIVE_HOST_NAME,
  MCP_STORAGE_KEY,
  type McpConfigV1,
} from './mcp-types';

const DEFAULT_CONFIG: McpConfigV1 = {
  v: MCP_CONFIG_VERSION,
  enabled: false,
  tokenHex: '',
  listenPort: null,
  listenHost: MCP_LISTEN_HOST,
  nativeHostName: MCP_NATIVE_HOST_NAME,
  desiredListenPort: null,
};

export async function getMcpConfig(): Promise<McpConfigV1> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get([MCP_STORAGE_KEY], (r) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      const stored = r[MCP_STORAGE_KEY] as McpConfigV1 | undefined;
      // pre-release: any older shape is rebuilt rather than migrated.
      if (!stored || stored.v !== MCP_CONFIG_VERSION) {
        resolve({ ...DEFAULT_CONFIG });
        return;
      }
      // forward-compat: if a row from before the desiredListenPort field is read back,
      // fold in the default rather than returning undefined.
      resolve({ ...DEFAULT_CONFIG, ...stored, v: MCP_CONFIG_VERSION });
    });
  });
}

export async function setMcpConfig(next: McpConfigV1): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [MCP_STORAGE_KEY]: next }, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

export async function patchMcpConfig(patch: Partial<Omit<McpConfigV1, 'v'>>): Promise<McpConfigV1> {
  const current = await getMcpConfig();
  const next: McpConfigV1 = { ...current, ...patch, v: MCP_CONFIG_VERSION };
  await setMcpConfig(next);
  return next;
}
