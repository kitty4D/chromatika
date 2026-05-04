/**
 * active network state per chain family.
 * stored in chrome.storage.local so it persists across extension restarts.
 */
import { STORAGE_KEYS } from '@/background/storage';

const KEY = STORAGE_KEYS.ACTIVE_NETWORKS_V1;

export type ActiveNetworks = {
  evmChainId: number;
  solNetworkId: string;
  suiNetworkId: string;
  aptNetworkId: string;
  btcNetworkId: string;
};

const DEFAULTS: ActiveNetworks = {
  evmChainId: 1,
  solNetworkId: 'sol-devnet',
  suiNetworkId: 'sui-mainnet',
  aptNetworkId: 'apt-mainnet',
  btcNetworkId: 'btc-mainnet',
};

export async function getActiveNetworks(): Promise<ActiveNetworks> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get([KEY], (r) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve({ ...DEFAULTS, ...(r[KEY] as Partial<ActiveNetworks> ?? {}) });
    });
  });
}

export async function setActiveNetworks(patch: Partial<ActiveNetworks>): Promise<ActiveNetworks> {
  const current = await getActiveNetworks();
  const next = { ...current, ...patch };
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [KEY]: next }, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(next);
    });
  });
}
