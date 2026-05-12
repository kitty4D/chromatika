/**
 * Round-trip tests for the global "don't ask me again" flag that suppresses the
 * post-dWallet-creation Policy Vault prompt.
 *
 * Mocks `chrome.storage.local` so each test sees a fresh in-memory store.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type ChromeStorageMock = {
  store: Record<string, unknown>;
  lastError: { message: string } | null;
  get: (keys: string[], cb: (r: Record<string, unknown>) => void) => void;
  set: (items: Record<string, unknown>, cb: () => void) => void;
  remove: (keys: string[], cb: () => void) => void;
};

const storageMock: ChromeStorageMock = {
  store: {},
  lastError: null,
  get(keys, cb) {
    const out: Record<string, unknown> = {};
    for (const k of keys) if (k in this.store) out[k] = this.store[k];
    cb(out);
  },
  set(items, cb) {
    Object.assign(this.store, items);
    cb();
  },
  remove(keys, cb) {
    for (const k of keys) delete this.store[k];
    cb();
  },
};

beforeEach(() => {
  storageMock.store = {};
  storageMock.lastError = null;
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: { local: storageMock },
    runtime: {
      get lastError() {
        return storageMock.lastError;
      },
    },
  };
});

afterEach(() => {
  vi.resetModules();
});

describe('policy-vault-prompt: global dismiss flag', () => {
  it('defaults to false when nothing is set', async () => {
    const m = await import('./policy-vault-prompt');
    expect(await m.isPolicyVaultPromptGloballyDismissed()).toBe(false);
  });

  it('round-trips true through storage', async () => {
    const m = await import('./policy-vault-prompt');
    await m.setPolicyVaultPromptGloballyDismissed(true);
    expect(await m.isPolicyVaultPromptGloballyDismissed()).toBe(true);
  });

  it('round-trips false to clear the flag', async () => {
    const m = await import('./policy-vault-prompt');
    await m.setPolicyVaultPromptGloballyDismissed(true);
    expect(await m.isPolicyVaultPromptGloballyDismissed()).toBe(true);
    await m.setPolicyVaultPromptGloballyDismissed(false);
    expect(await m.isPolicyVaultPromptGloballyDismissed()).toBe(false);
  });

  it('rejects when chrome.runtime.lastError fires on set', async () => {
    const m = await import('./policy-vault-prompt');
    storageMock.lastError = { message: 'quota exceeded' };
    await expect(m.setPolicyVaultPromptGloballyDismissed(true)).rejects.toThrow(/quota exceeded/);
  });
});
