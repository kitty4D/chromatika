/**
 * storage round-trip tests for the policy-vault link + package config. mocks chrome.storage
 * so each test sees a fresh in-memory store.
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

const VALID_PKG_ID = '0x' + 'a'.repeat(64);
const VALID_VAULT_ID = '0x' + 'b'.repeat(64);
const VALID_DWALLET_ID = '0x' + 'c'.repeat(64);
const VALID_ACTUATOR = '0x' + 'd'.repeat(64);

describe('policy-vault-storage: package config', () => {
  it('returns null when nothing is set', async () => {
    const m = await import('./policy-vault-storage');
    expect(await m.getPolicyPackageConfig()).toBeNull();
  });

  it('round-trips package config through storage', async () => {
    const m = await import('./policy-vault-storage');
    await m.setPolicyPackageConfig({ packageId: VALID_PKG_ID, setAtMs: 1000, label: 'test' });
    const cfg = await m.getPolicyPackageConfig();
    expect(cfg?.packageId).toBe(VALID_PKG_ID);
    expect(cfg?.label).toBe('test');
    expect(cfg?.setAtMs).toBe(1000);
  });

  it('rejects malformed package id', async () => {
    const m = await import('./policy-vault-storage');
    await expect(
      m.setPolicyPackageConfig({ packageId: '0x123', setAtMs: 1, label: undefined }),
    ).rejects.toThrow(/0x-prefixed/);
    await expect(
      m.setPolicyPackageConfig({
        packageId: '0xnotvalidhex' + 'g'.repeat(54),
        setAtMs: 1,
      }),
    ).rejects.toThrow(/0x-prefixed/);
  });

  it('clear removes the entry', async () => {
    const m = await import('./policy-vault-storage');
    await m.setPolicyPackageConfig({ packageId: VALID_PKG_ID, setAtMs: 1, label: 'x' });
    expect(await m.getPolicyPackageConfig()).not.toBeNull();
    await m.clearPolicyPackageConfig();
    expect(await m.getPolicyPackageConfig()).toBeNull();
  });
});

describe('policy-vault-storage: per-vault link', () => {
  const baseLink = {
    vaultObjectId: VALID_VAULT_ID,
    dwalletId: VALID_DWALLET_ID,
    primaryActuator: VALID_ACTUATOR,
    optInAtMs: 100,
    curve: 0,
    signatureAlgorithm: 0,
  } as const;

  it('returns null for a vault with no link', async () => {
    const m = await import('./policy-vault-storage');
    expect(await m.getPolicyVaultLink('vault-x')).toBeNull();
  });

  it('round-trips a link', async () => {
    const m = await import('./policy-vault-storage');
    await m.setPolicyVaultLink('vault-x', { ...baseLink });
    const got = await m.getPolicyVaultLink('vault-x');
    expect(got?.vaultObjectId).toBe(VALID_VAULT_ID);
    expect(got?.dwalletId).toBe(VALID_DWALLET_ID);
    expect(got?.primaryActuator).toBe(VALID_ACTUATOR);
    expect(got?.curve).toBe(0);
  });

  it('isolates per-vault keys', async () => {
    const m = await import('./policy-vault-storage');
    await m.setPolicyVaultLink('vault-a', { ...baseLink });
    await m.setPolicyVaultLink('vault-b', {
      ...baseLink,
      vaultObjectId: '0x' + 'e'.repeat(64),
    });
    const a = await m.getPolicyVaultLink('vault-a');
    const b = await m.getPolicyVaultLink('vault-b');
    expect(a?.vaultObjectId).toBe(VALID_VAULT_ID);
    expect(b?.vaultObjectId).toBe('0x' + 'e'.repeat(64));
  });

  it('rejects malformed vaultObjectId', async () => {
    const m = await import('./policy-vault-storage');
    await expect(
      m.setPolicyVaultLink('vault-x', { ...baseLink, vaultObjectId: '0x123' }),
    ).rejects.toThrow(/0x-prefixed/);
  });

  it('updateSnapshot patches cached fields', async () => {
    const m = await import('./policy-vault-storage');
    await m.setPolicyVaultLink('vault-x', { ...baseLink });
    await m.updatePolicyVaultSnapshot('vault-x', {
      panicked: false,
      panicAtMs: 0,
      unfreezeDelayMs: 7 * 86_400_000,
      unfreezeUnlocksAtMs: 0,
      dailyCapMicros: '50000000',
      spentTodayMicros: '5000000',
      coolDownMs: 60_000,
      lastSignAtMs: 12345,
      actuators: [VALID_ACTUATOR],
      hasRescueAddress: true,
      ikaBalance: '100000',
      suiBalance: '50000',
      presignsRemaining: 3,
      epochDay: 19850,
      stageCapRaises: false,
      stageDelayMs: 86_400_000,
      hasPendingCap: false,
      pendingCapMicros: '0',
      pendingCapAtMs: 0,
      pendingStageOff: false,
      pendingStageOffAtMs: 0,
    });
    const got = await m.getPolicyVaultLink('vault-x');
    expect(got?.cachedSnapshot?.dailyCapMicros).toBe('50000000');
    expect(got?.cachedSnapshot?.actuators).toEqual([VALID_ACTUATOR]);
    expect(typeof got?.lastSyncMs).toBe('number');
  });

  it('updateSnapshot is a no-op when no link exists', async () => {
    const m = await import('./policy-vault-storage');
    await m.updatePolicyVaultSnapshot('vault-none', {
      panicked: false,
      panicAtMs: 0,
      unfreezeDelayMs: 0,
      unfreezeUnlocksAtMs: 0,
      dailyCapMicros: '0',
      spentTodayMicros: '0',
      coolDownMs: 0,
      lastSignAtMs: 0,
      actuators: [],
      hasRescueAddress: false,
      ikaBalance: '0',
      suiBalance: '0',
      presignsRemaining: 0,
      epochDay: 0,
      stageCapRaises: false,
      stageDelayMs: 0,
      hasPendingCap: false,
      pendingCapMicros: '0',
      pendingCapAtMs: 0,
      pendingStageOff: false,
      pendingStageOffAtMs: 0,
    });
    expect(await m.getPolicyVaultLink('vault-none')).toBeNull();
  });

  it('clear removes the link entry', async () => {
    const m = await import('./policy-vault-storage');
    await m.setPolicyVaultLink('vault-x', { ...baseLink });
    expect(await m.getPolicyVaultLink('vault-x')).not.toBeNull();
    await m.clearPolicyVaultLink('vault-x');
    expect(await m.getPolicyVaultLink('vault-x')).toBeNull();
  });
});
