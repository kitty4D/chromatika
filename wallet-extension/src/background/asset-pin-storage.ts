import { VAULT_SCOPED_KEYS } from '@/background/storage';

type AssetKeyList = { keys: string[] };

function pinnedKey(vaultId: string): string {
  return VAULT_SCOPED_KEYS.pinnedAssets(vaultId);
}

function hiddenKey(vaultId: string): string {
  return VAULT_SCOPED_KEYS.hiddenAssets(vaultId);
}

async function loadKeyList(storageKey: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get([storageKey], (r) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else {
        const raw = r[storageKey] as AssetKeyList | undefined;
        const keys = raw?.keys;
        resolve(Array.isArray(keys) ? keys.filter((x): x is string => typeof x === 'string' && x.length > 0) : []);
      }
    });
  });
}

async function saveKeyList(storageKey: string, keys: string[]): Promise<void> {
  const payload: AssetKeyList = { keys };
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [storageKey]: payload }, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

export async function loadPinnedAssets(vaultId: string): Promise<string[]> {
  return loadKeyList(pinnedKey(vaultId));
}

export async function savePinnedAssets(vaultId: string, keys: string[]): Promise<void> {
  return saveKeyList(pinnedKey(vaultId), keys);
}

export async function loadHiddenAssets(vaultId: string): Promise<string[]> {
  return loadKeyList(hiddenKey(vaultId));
}

export async function saveHiddenAssets(vaultId: string, keys: string[]): Promise<void> {
  return saveKeyList(hiddenKey(vaultId), keys);
}
