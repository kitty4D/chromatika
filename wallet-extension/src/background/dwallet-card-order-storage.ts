/**
 * per-vault ordered list of dWallet ids for home `WalletPage` card order (local UX only).
 */
import { VAULT_SCOPED_KEYS } from '@/background/storage';

function storageKey(vaultId: string): string {
  return VAULT_SCOPED_KEYS.dwalletCardOrder(vaultId);
}

export type DwalletCardOrder = {
  /** older dWallet ids first; unknown ids ignored at read time. */
  orderedIds: string[];
};

export async function loadDwalletCardOrder(vaultId: string): Promise<string[]> {
  const key = storageKey(vaultId);
  return new Promise((resolve, reject) => {
    chrome.storage.local.get([key], (r) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else {
        const raw = r[key] as DwalletCardOrder | undefined;
        const ids = raw?.orderedIds;
        resolve(Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string' && x.length > 0) : []);
      }
    });
  });
}

export async function saveDwalletCardOrder(vaultId: string, orderedIds: string[]): Promise<void> {
  const key = storageKey(vaultId);
  const payload: DwalletCardOrder = { orderedIds };
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [key]: payload }, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}
