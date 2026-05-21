import { STORAGE_KEYS } from '@/background/storage';

const KEY = STORAGE_KEYS.BALANCE_PRIVACY_V1;

export async function getBalancePrivacy(): Promise<boolean> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get([KEY], (r) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(r[KEY] === true);
    });
  });
}

export async function setBalancePrivacy(hidden: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [KEY]: hidden }, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

export const BALANCE_PRIVACY_STORAGE_KEY = KEY;
