/** when false, hide inline help bubbles (home tips, future screen hints). storage: chromatika_ui_help_hints_v1 */
import { STORAGE_KEYS } from '@/background/storage';

const KEY = STORAGE_KEYS.UI_HELP_HINTS_V1;

export async function getUiHelpHints(): Promise<boolean> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get([KEY], (r) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve((r[KEY] as boolean | undefined) ?? true);
    });
  });
}

export async function setUiHelpHints(enabled: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [KEY]: enabled }, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}
