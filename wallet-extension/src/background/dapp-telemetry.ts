import { STORAGE_KEYS } from '@/background/storage';

const KEY = STORAGE_KEYS.DAPP_BRIDGE_DEBUG_V1;
const MAX_ITEMS = 150;

export type BridgeTelemetryItem = {
  at: number;
  origin: string;
  method: string;
  ok: boolean;
  reason?: string;
  /** set when `solana_signTransaction` / `solana_signAllTransactions` wire touches Encrypt program id */
  solanaEncryptProgram?: boolean;
};

let cache: BridgeTelemetryItem[] | null = null;

async function load(): Promise<BridgeTelemetryItem[]> {
  if (cache) return cache;
  return new Promise((resolve, reject) => {
    chrome.storage.local.get([KEY], (r) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else {
        cache = (r[KEY] as BridgeTelemetryItem[]) ?? [];
        resolve(cache);
      }
    });
  });
}

async function save(items: BridgeTelemetryItem[]): Promise<void> {
  cache = items;
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [KEY]: items }, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

export async function recordBridgeTelemetry(item: BridgeTelemetryItem): Promise<void> {
  const items = await load();
  const next = [...items, item].slice(-MAX_ITEMS);
  await save(next);
}

export async function getBridgeTelemetry(): Promise<BridgeTelemetryItem[]> {
  return load();
}
