/** global ika dWallet anchor chain (Sui live, Solana when SDK ships). storage key: chromatika_ika_base_mode_v1 */
import { STORAGE_KEYS } from '@/background/storage';

export type IkaBaseMode = 'sui' | 'solana';

const KEY = STORAGE_KEYS.IKA_BASE_MODE_V1;

function normalize(v: unknown): IkaBaseMode {
  return v === 'solana' ? 'solana' : 'sui';
}

export async function getIkaBaseMode(): Promise<IkaBaseMode> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get([KEY], (r) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(normalize(r[KEY]));
    });
  });
}

export async function setIkaBaseMode(mode: IkaBaseMode): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [KEY]: mode }, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

export const IK_BASE_MODE_STORAGE_KEY = KEY;
