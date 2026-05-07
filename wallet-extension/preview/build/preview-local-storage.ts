/**
 * In-memory `chrome.storage.local` slice for the static website iframe preview.
 * Keeps `chromatika_ika_base_mode_v1` in sync with `trpc.getIkaBaseMode` / `setIkaBaseMode`
 * and fires `chrome.storage.onChanged` so `useIkaBaseMode` matches the real extension.
 */

import { STORAGE_KEYS } from '@/background/storage/keys';

type StorageChangeListener = (
  changes: Record<string, chrome.storage.StorageChange>,
  areaName: chrome.storage.AreaName,
) => void;

const store: Record<string, unknown> = {
  [STORAGE_KEYS.IKA_BASE_MODE_V1]: 'sui',
};

const listeners = new Set<StorageChangeListener>();

function coerceKeyList(keys: unknown): string[] | null {
  if (keys === null || keys === undefined) return null;
  if (typeof keys === 'string') return [keys];
  if (Array.isArray(keys)) return keys.filter((k): k is string => typeof k === 'string');
  if (typeof keys === 'object') return Object.keys(keys as object);
  return null;
}

function buildGetResult(wanted: string[] | null): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const keyList = wanted === null ? Object.keys(store) : wanted;
  for (const k of keyList) {
    if (Object.prototype.hasOwnProperty.call(store, k)) result[k] = store[k];
  }
  return result;
}

function clearRuntimeLastErrorBestEffort() {
  try {
    const c = globalThis.chrome as { runtime?: { lastError?: chrome.runtime.LastError | undefined } } | undefined;
    if (c?.runtime) delete c.runtime.lastError;
  } catch {
    /* ignore */
  }
}

function applySet(items: Record<string, unknown>) {
  const changes: Record<string, chrome.storage.StorageChange> = {};
  for (const key of Object.keys(items)) {
    const newValue = items[key];
    const oldValue = store[key];
    if (oldValue === newValue) continue;
    changes[key] = { oldValue, newValue };
    if (newValue === undefined) delete store[key];
    else store[key] = newValue;
  }
  if (Object.keys(changes).length === 0) return;
  for (const fn of listeners) {
    try {
      fn(changes, 'local');
    } catch {
      /* swallow - preview UX should not explode on listener bugs */
    }
  }
}

export function readPreviewIkaBaseMode(): 'sui' | 'solana' {
  const v = store[STORAGE_KEYS.IKA_BASE_MODE_V1];
  return v === 'solana' ? 'solana' : 'sui';
}

/** Used by preview tRPC mocks to mirror persist + notify storage listeners without duplicating chrome API shape. */
export function previewPersistIkaBaseMode(mode: 'sui' | 'solana'): void {
  applySet({ [STORAGE_KEYS.IKA_BASE_MODE_V1]: mode });
}

export function previewChromeStorageNamespace(): chrome.storage.Static {
  const localApi: chrome.storage.StorageArea = {
    get(keys?: unknown, callback?: (items: Record<string, unknown>) => void) {
      const wanted = coerceKeyList(keys);
      const result = buildGetResult(wanted);
      clearRuntimeLastErrorBestEffort();
      if (typeof callback === 'function') {
        queueMicrotask(() => {
          clearRuntimeLastErrorBestEffort();
          callback(result);
        });
      }
      return Promise.resolve(result) as unknown as Promise<Record<string, unknown>>;
    },

    set(items: Record<string, unknown>, callback?: () => void) {
      applySet(items);
      clearRuntimeLastErrorBestEffort();
      if (typeof callback === 'function') queueMicrotask(() => callback());
      return Promise.resolve() as unknown as Promise<void>;
    },

    remove(_keys: string | string[], _callback?: () => void): Promise<void> {
      clearRuntimeLastErrorBestEffort();
      return Promise.resolve();
    },

    clear(_callback?: () => void): Promise<void> {
      clearRuntimeLastErrorBestEffort();
      return Promise.resolve();
    },

    setAccessLevel(_details: chrome.storage.accessOptions): Promise<void> {
      return Promise.resolve();
    },

    getBytesInUse(keys: string | string[] | null, callback?: (bytes: number) => void) {
      if (typeof callback === 'function') queueMicrotask(() => callback(0));
      return Promise.resolve(0);
    },
  };

  return {
    local: localApi,
    session: localApi,
    sync: localApi,
    managed: localApi,
    onChanged: {
      addListener(fn: StorageChangeListener) {
        listeners.add(fn);
      },
      removeListener(fn: StorageChangeListener) {
        listeners.delete(fn);
      },
      hasListener(fn: StorageChangeListener) {
        return listeners.has(fn);
      },
    },
  } as unknown as chrome.storage.Static;
}
