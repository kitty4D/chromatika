/**
 * Global "don't ask me again" flag for the post-dWallet-creation Policy Vault prompt
 * (`PostCreatePolicyVaultPrompt`).
 *
 * Default false. Flipped true when the user checks "Don't ask me again on any new
 * dWallet" before any close path on the modal (wrap / customize / not now / X). Read
 * via the `getPolicyVaultPromptState` tRPC procedure right before the modal would
 * mount. Toggleable via Settings -> Safety -> "Prompts I've dismissed".
 *
 * Global (no vault id). The Policy Vault is wallet-wide rather than per-vault from a
 * security-prompt-fatigue standpoint - if the user opts out once, they opt out for
 * every new dWallet across every vault until they re-enable in Settings.
 *
 * Mirrors the shape of `dwallet-create-prompt.ts` (per-vault) and `advanced-mode.ts`
 * (single boolean) so the read/write semantics are unsurprising.
 */

import { STORAGE_KEYS } from '@/background/storage';

const KEY = STORAGE_KEYS.POLICY_VAULT_PROMPT_GLOBALLY_DISMISSED_V1;

export async function isPolicyVaultPromptGloballyDismissed(): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get([KEY], (r) => {
        resolve(r?.[KEY] === true);
      });
    } catch {
      resolve(false);
    }
  });
}

export async function setPolicyVaultPromptGloballyDismissed(dismissed: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      chrome.storage.local.set({ [KEY]: dismissed }, () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve();
        }
      });
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}
