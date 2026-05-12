/**
 * Global "don't ask me again on any vault" flag for the empty-state
 * `CreateDwalletPrompt` shown on the Home screen when a funded vault has zero
 * dWallets.
 *
 * Additive to the existing per-vault flag at
 * `VAULT_SCOPED_KEYS.dwalletCreatePromptDismissed` (see `dwallet-create-prompt.ts`).
 * Either flag being true hides the prompt. The router's
 * `getDWalletCreatePromptState` ORs both sources.
 *
 * Set when the user checks "Don't show this on any vault" before tapping "I'll
 * do this manually later" on the prompt. Toggleable via Settings -> Safety ->
 * "Prompts I've dismissed".
 */

import { STORAGE_KEYS } from '@/background/storage';

const KEY = STORAGE_KEYS.DWALLET_CREATE_PROMPT_GLOBALLY_DISMISSED_V1;

export async function isDWalletCreatePromptGloballyDismissed(): Promise<boolean> {
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

export async function setDWalletCreatePromptGloballyDismissed(dismissed: boolean): Promise<void> {
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
