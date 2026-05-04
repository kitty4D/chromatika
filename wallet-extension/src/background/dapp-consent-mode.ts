import { STORAGE_KEYS } from '@/background/storage';

const KEY = STORAGE_KEYS.DAPP_CONSENT_MODE_V1;

export type DappConsentMode = 'compat' | 'strict';

export async function getDappConsentMode(): Promise<DappConsentMode> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get([KEY], (r) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve((r[KEY] as DappConsentMode) ?? 'compat');
    });
  });
}

export async function setDappConsentMode(mode: DappConsentMode): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [KEY]: mode }, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}
