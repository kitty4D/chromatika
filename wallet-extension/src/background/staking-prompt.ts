import { VAULT_SCOPED_KEYS } from '@/background/storage';

function key(vaultId: string): string {
  return VAULT_SCOPED_KEYS.stakingPromptDismissed(vaultId);
}

export async function isStakingPromptDismissed(vaultId: string): Promise<boolean> {
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

export async function dismissStakingPrompt(vaultId: string): Promise<void> {
  const k = key(vaultId);
  return new Promise((resolve) => {
    chrome.storage.local.set({ [k]: true }, () => resolve());
  });
}
