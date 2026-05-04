import { STORAGE_KEYS } from '@/background/storage';
import type { EvmNetwork } from '@/config/networks';

const KEY = STORAGE_KEYS.CUSTOM_NETWORKS_V1;

type Store = { evm: EvmNetwork[] };

async function load(): Promise<Store> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get([KEY], (r) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve((r[KEY] as Store) ?? { evm: [] });
    });
  });
}

async function save(store: Store): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [KEY]: store }, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

export async function getCustomNetworks(): Promise<Store> {
  return load();
}

export async function addCustomEvm(network: Omit<EvmNetwork, 'isCustom' | 'id'>): Promise<EvmNetwork> {
  const store = await load();
  // replace if same chainId already exists as custom
  const existing = store.evm.findIndex((n) => n.chainId === network.chainId);
  const entry: EvmNetwork = { ...network, id: `evm-custom-${network.chainId}`, isCustom: true };
  if (existing >= 0) store.evm[existing] = entry;
  else store.evm.push(entry);
  await save(store);
  return entry;
}

export async function removeCustomEvm(chainId: number): Promise<void> {
  const store = await load();
  store.evm = store.evm.filter((n) => n.chainId !== chainId);
  await save(store);
}
