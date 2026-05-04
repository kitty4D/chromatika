import { STORAGE_KEYS } from '@/background/storage';
import {
  DEFAULT_PRICE_SOURCE_ORDER,
  normalizePriceSourceOrder,
  type PriceSourceId,
} from '@/config/price-sources';

const KEY = STORAGE_KEYS.PRICE_WATERFALL_V1;

export type PricePreferences = {
  /** ordered list of sources to try for each symbol (first hit wins). */
  order: PriceSourceId[];
};

export const DEFAULT_PRICE_PREFERENCES: PricePreferences = {
  order: [...DEFAULT_PRICE_SOURCE_ORDER],
};

export async function getPricePreferences(): Promise<PricePreferences> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get([KEY], (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      const raw = result[KEY];
      if (!raw || typeof raw !== 'object') {
        resolve({ ...DEFAULT_PRICE_PREFERENCES });
        return;
      }
      const order = normalizePriceSourceOrder((raw as { order?: unknown }).order);
      resolve({ order });
    });
  });
}

export async function setPricePreferences(next: PricePreferences): Promise<void> {
  const normalized: PricePreferences = {
    order: normalizePriceSourceOrder(next.order),
  };
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [KEY]: normalized }, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

export const PRICE_PREFERENCES_STORAGE_KEY = KEY;
