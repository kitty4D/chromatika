/**
 * per-vault dismissal flag for the Home-screen "create your first dWallets" prompt.
 * the prompt itself only renders when the active vault has 0 dWallets AND is funded.
 * once dismissed, the prompt never re-appears for that vault id; the empty state
 * falls back to the existing "Create a dWallet" button which opens dWallet mgmt.
 *
 * cleared by `removeVault()` so the row doesn't leak after a vault is deleted.
 */

import { VAULT_SCOPED_KEYS } from '@/background/storage';

function key(vaultId: string): string {
  return VAULT_SCOPED_KEYS.dwalletCreatePromptDismissed(vaultId);
}

export async function isDWalletCreatePromptDismissed(vaultId: string): Promise<boolean> {
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

export async function dismissDWalletCreatePromptForVault(vaultId: string): Promise<void> {
  const k = key(vaultId);
  return new Promise((resolve) => {
    chrome.storage.local.set({ [k]: true }, () => resolve());
  });
}

export async function clearDWalletCreatePromptForVault(vaultId: string): Promise<void> {
  const k = key(vaultId);
  return new Promise((resolve) => {
    chrome.storage.local.remove([k], () => resolve());
  });
}
