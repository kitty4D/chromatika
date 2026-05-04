/**
 * promise wrappers around `chrome.storage.local` and `chrome.storage.session`.
 *
 * - `readLocal` / `readSession` resolve to `undefined` when the key is missing.
 *   `chrome.runtime.lastError` is surfaced as a thrown `Error` (matches the prevailing
 *   pattern across the background; callers that want a softer fallback should wrap).
 * - session helpers gracefully no-op if `chrome.storage.session` isn't available
 *   (older runtimes, unit tests with partial mocks). reads return `undefined`,
 *   writes / removes resolve void.
 */

export async function readLocal<T = unknown>(key: string): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve, reject) => {
    chrome.storage.local.get([key], (r) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(r[key] as T | undefined);
    });
  });
}

export async function readLocalMany(keys: string[]): Promise<Record<string, unknown>> {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    chrome.storage.local.get(keys, (r) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(r);
    });
  });
}

export async function writeLocal<T>(key: string, value: T): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    chrome.storage.local.set({ [key]: value }, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

export async function removeLocal(key: string | string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    chrome.storage.local.remove(key, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

export async function readSession<T = unknown>(key: string): Promise<T | undefined> {
  if (!chrome.storage.session) return undefined;
  return new Promise<T | undefined>((resolve) => {
    chrome.storage.session.get([key], (r) => {
      // session reads are best-effort; some envs surface lastError on cold start.
      if (chrome.runtime.lastError) {
        resolve(undefined);
        return;
      }
      resolve(r[key] as T | undefined);
    });
  });
}

export async function writeSession<T>(key: string, value: T): Promise<void> {
  if (!chrome.storage.session) return;
  return new Promise<void>((resolve) => {
    chrome.storage.session.set({ [key]: value }, () => {
      if (chrome.runtime.lastError) {
        console.warn('[chromatika][storage] session write failed:', chrome.runtime.lastError.message);
      }
      resolve();
    });
  });
}

export async function removeSession(key: string | string[]): Promise<void> {
  if (!chrome.storage.session) return;
  return new Promise<void>((resolve) => {
    chrome.storage.session.remove(key, () => resolve());
  });
}
