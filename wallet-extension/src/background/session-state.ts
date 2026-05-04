import { getSession, setSession } from '@/background/session';
import { importKeyBytesToVaultKey, type VaultKdfMeta } from '@/background/vault';
import { STORAGE_KEYS } from '@/background/storage';

/**
 * ephemeral unlock rehydrate cache: chrome.storage.session only (cleared on browser close).
 * stores the *derived* AES-GCM key bytes plus the KDF meta - never the plaintext password.
 * on rehydrate, bytes are imported as a non-extractable `CryptoKey`, then forgotten.
 */
const UNLOCK_CACHE_KEY = STORAGE_KEYS.UNLOCK_CACHE_V1;
/** legacy key - cleared on lock/unlock so old plaintext entries are removed */
const UNLOCK_CACHE_KEY_LOCAL_LEGACY = STORAGE_KEYS.UNLOCK_CACHE_V1_LOCAL_LEGACY;

export type UnlockCache = {
  /** base64 of 32 raw AES-GCM key bytes (Argon2id output). re-imported as non-extractable on read. */
  vaultKeyB64: string;
  kdfMeta: VaultKdfMeta;
  expiresAtEpochMs: number;
  autoLockMinutes: number;
};

function parseUnlockCache(raw: unknown): UnlockCache | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Partial<UnlockCache> & { password?: string };
  // a stale plaintext-password cache from before the argon2id migration - drop it.
  if (typeof o.password === 'string' || !o.vaultKeyB64 || !o.kdfMeta) return null;
  if (
    typeof o.vaultKeyB64 !== 'string'
    || typeof o.expiresAtEpochMs !== 'number'
    || typeof o.autoLockMinutes !== 'number'
    || typeof o.kdfMeta !== 'object'
  ) {
    return null;
  }
  return o as UnlockCache;
}

export async function readUnlockCache(): Promise<UnlockCache | null> {
  if (!chrome.storage.session) return null;
  return new Promise<UnlockCache | null>((resolve) => {
    chrome.storage.session.get([UNLOCK_CACHE_KEY], (r) => {
      resolve(parseUnlockCache(r[UNLOCK_CACHE_KEY]));
    });
  });
}

export async function writeUnlockCache(
  vaultKeyBytes: Uint8Array,
  kdfMeta: VaultKdfMeta,
  autoLockMinutes: number,
): Promise<void> {
  if (!chrome.storage.session) return;
  const vaultKeyB64 = btoa(String.fromCharCode(...vaultKeyBytes));
  const payload: UnlockCache = {
    vaultKeyB64,
    kdfMeta,
    autoLockMinutes,
    expiresAtEpochMs: Date.now() + autoLockMinutes * 60_000,
  };
  await new Promise<void>((resolve) => {
    chrome.storage.session.set({ [UNLOCK_CACHE_KEY]: payload }, () => {
      if (chrome.runtime.lastError) {
        console.warn('[chromatika] unlock cache (session) write failed:', chrome.runtime.lastError.message);
      }
      resolve();
    });
  });
  await new Promise<void>((resolve) => {
    chrome.storage.local.remove([UNLOCK_CACHE_KEY_LOCAL_LEGACY], () => resolve());
  });
}

/** re-import cached key bytes as a non-extractable CryptoKey, then forget the bytes. */
export async function importVaultKeyFromCache(cache: UnlockCache): Promise<CryptoKey> {
  const bytes = Uint8Array.from(atob(cache.vaultKeyB64), (c) => c.charCodeAt(0));
  try {
    return await importKeyBytesToVaultKey(bytes);
  } finally {
    bytes.fill(0);
  }
}

export async function clearUnlockCache(): Promise<void> {
  const tasks: Promise<void>[] = [
    new Promise<void>((resolve) => {
      chrome.storage.local.remove([UNLOCK_CACHE_KEY_LOCAL_LEGACY], () => resolve());
    }),
  ];
  if (chrome.storage.session) {
    tasks.push(
      new Promise<void>((resolve) => {
        chrome.storage.session.remove([UNLOCK_CACHE_KEY], () => resolve());
      }),
    );
  }
  await Promise.all(tasks);
}

export function lockWallet(): void {
  setSession(null);
  void clearUnlockCache();
}

export function getLockState(): { unlocked: boolean } {
  return { unlocked: getSession() !== null };
}

export function getActiveVaultId(): string | null {
  return getSession()?.activeVaultId ?? null;
}
