/** light/dark UI appearance (independent of ika base chain). storage: chromatika_appearance_v1 */
import { STORAGE_KEYS } from '@/background/storage';

export type AppearanceMode = 'light' | 'dark';

const KEY = STORAGE_KEYS.APPEARANCE_V1;

function normalize(v: unknown): AppearanceMode {
  return v === 'light' ? 'light' : 'dark';
}

export async function getAppearance(): Promise<AppearanceMode> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get([KEY], (r) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(normalize(r[KEY]));
    });
  });
}

export async function setAppearance(mode: AppearanceMode): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [KEY]: mode }, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

export const APPEARANCE_STORAGE_KEY = KEY;
