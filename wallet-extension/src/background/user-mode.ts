import { STORAGE_KEYS } from '@/background/storage';

/**
 * UX tier. Collapses how much of the (unchanged) multi-vault / multi-dWallet model
 * is shown:
 *  - `beginner`: simplest single-account view, crypto jargon hidden.
 *  - `advanced`: today's full wallet (multiple accounts, every chain, networks, dapps).
 *  - `pro`: Advanced + raw addresses, dev details, and debug panels.
 *
 * `pro` subsumes what the old `advanced_mode` boolean gated, so the app derives
 * `advanced = userMode === 'pro'` and existing debug gates keep working unchanged.
 */
export type UserMode = 'beginner' | 'advanced' | 'pro';

const KEY = STORAGE_KEYS.USER_MODE_V1;
const VALID: readonly UserMode[] = ['beginner', 'advanced', 'pro'];

export async function getUserMode(): Promise<UserMode> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get([KEY], (r) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      const v = r[KEY] as UserMode | undefined;
      // default `advanced` = today's full UI (debug off). fresh installs get `beginner`
      // from the onboarding tier step, which writes this key explicitly.
      resolve(v && VALID.includes(v) ? v : 'advanced');
    });
  });
}

export async function setUserMode(mode: UserMode): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [KEY]: mode }, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}
