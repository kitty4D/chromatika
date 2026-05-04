import { STORAGE_KEYS } from '@/background/storage';

const KEY = STORAGE_KEYS.ADVANCED_MODE_V1;

export async function getAdvancedMode(): Promise<boolean> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get([KEY], (r) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve((r[KEY] as boolean) ?? false);
    });
  });
}

export async function setAdvancedMode(enabled: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [KEY]: enabled }, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}
