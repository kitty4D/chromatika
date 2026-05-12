/**
 * round-trip tests for the per-vault "create dWallet" prompt dismissal flag.
 * mocks chrome.storage so each test sees a fresh in-memory store.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type ChromeStorageMock = {
  store: Record<string, unknown>;
  get: (keys: string[], cb: (r: Record<string, unknown>) => void) => void;
  set: (items: Record<string, unknown>, cb: () => void) => void;
  remove: (keys: string[], cb: () => void) => void;
};

const storageMock: ChromeStorageMock = {
  store: {},
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
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: { local: storageMock },
    runtime: { lastError: null },
  };
});

afterEach(() => {
  vi.resetModules();
});

describe('dwallet-create-prompt: dismissal flag', () => {
  it('returns false when no row exists', async () => {
    const m = await import('./dwallet-create-prompt');
    expect(await m.isDWalletCreatePromptDismissed('vault-x')).toBe(false);
  });

  it('round-trips dismissal through storage', async () => {
    const m = await import('./dwallet-create-prompt');
    await m.dismissDWalletCreatePromptForVault('vault-x');
    expect(await m.isDWalletCreatePromptDismissed('vault-x')).toBe(true);
  });

  it('isolates dismissals per vault id', async () => {
    const m = await import('./dwallet-create-prompt');
    await m.dismissDWalletCreatePromptForVault('vault-a');
    expect(await m.isDWalletCreatePromptDismissed('vault-a')).toBe(true);
    expect(await m.isDWalletCreatePromptDismissed('vault-b')).toBe(false);
  });

  it('clear removes the dismissal entry', async () => {
    const m = await import('./dwallet-create-prompt');
    await m.dismissDWalletCreatePromptForVault('vault-x');
    expect(await m.isDWalletCreatePromptDismissed('vault-x')).toBe(true);
    await m.clearDWalletCreatePromptForVault('vault-x');
    expect(await m.isDWalletCreatePromptDismissed('vault-x')).toBe(false);
  });

  it('clear is scoped per vault (does not affect siblings)', async () => {
    const m = await import('./dwallet-create-prompt');
    await m.dismissDWalletCreatePromptForVault('vault-a');
    await m.dismissDWalletCreatePromptForVault('vault-b');
    await m.clearDWalletCreatePromptForVault('vault-a');
    expect(await m.isDWalletCreatePromptDismissed('vault-a')).toBe(false);
    expect(await m.isDWalletCreatePromptDismissed('vault-b')).toBe(true);
  });
});
