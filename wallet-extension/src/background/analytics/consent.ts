import { STORAGE_KEYS } from '@/background/storage/keys';

const KEY = STORAGE_KEYS.ANALYTICS_CONSENT_V1;

export type AnalyticsConsent = {
  errorTracking: boolean;
};

const DEFAULTS: AnalyticsConsent = { errorTracking: false };

export async function getAnalyticsConsent(): Promise<AnalyticsConsent> {
  return new Promise((resolve) => {
    chrome.storage.local.get([KEY], (r) => {
      resolve({ ...DEFAULTS, ...(r[KEY] as Partial<AnalyticsConsent> ?? {}) });
    });
  });
}

export async function setAnalyticsConsent(consent: AnalyticsConsent): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [KEY]: consent }, resolve);
  });
}
