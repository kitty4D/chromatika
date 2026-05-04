import type { SessionState } from '@/background/session';
import { VAULT_SCOPED_KEYS } from '@/background/storage';

export function dwalletMetaStorageKey(vaultId: string): string {
  return VAULT_SCOPED_KEYS.dwalletMeta(vaultId);
}

export async function loadDwalletMeta(vaultId: string): Promise<SessionState['dwalletMeta']> {
  const key = dwalletMetaStorageKey(vaultId);
  return new Promise((resolve, reject) => {
    chrome.storage.local.get([key], (r) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve((r[key] as SessionState['dwalletMeta']) ?? {});
    });
  });
}

export async function saveDwalletMeta(
  vaultId: string,
  meta: SessionState['dwalletMeta'],
): Promise<void> {
  const key = dwalletMetaStorageKey(vaultId);
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [key]: meta }, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}
