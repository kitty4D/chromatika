import { VAULT_SCOPED_KEYS } from '@/background/storage';

function key(vaultId: string): string {
  return VAULT_SCOPED_KEYS.welcomeBannerDismissed(vaultId);
}

export async function isWelcomeBannerDismissed(vaultId: string): Promise<boolean> {
  const k = key(vaultId);
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get([k], (r) => {
        resolve(r?.[k] === true);
      });
    } catch {
      resolve(false);
    }
  });
}

export async function dismissWelcomeBanner(vaultId: string): Promise<void> {
  const k = key(vaultId);
  return new Promise((resolve) => {
    chrome.storage.local.set({ [k]: true }, () => resolve());
  });
}
