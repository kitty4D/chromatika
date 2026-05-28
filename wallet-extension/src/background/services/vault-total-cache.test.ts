import { describe, it, expect, beforeEach } from 'vitest';
import {
  readVaultTotalSnapshot,
  writeVaultTotalSnapshot,
  clearVaultTotalCache,
  isStaleSnapshot,
  vaultTotalCacheKey,
  parseStoredWireSnapshot,
  type VaultTotalSnapshot,
} from './vault-total-cache';

const session = new Map<string, unknown>();
beforeEach(() => {
  session.clear();
  // cast through unknown to avoid @types/chrome overload mismatch in the test stub
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      session: {
        get: (keys: string[], cb: (r: Record<string, unknown>) => void) => {
          const out: Record<string, unknown> = {};
          for (const k of keys) if (session.has(k)) out[k] = session.get(k);
          cb(out);
        },
        set: (items: Record<string, unknown>, cb: () => void) => {
          for (const [k, v] of Object.entries(items)) session.set(k, v);
          cb();
        },
        remove: (keys: string[], cb: () => void) => {
          for (const k of keys) session.delete(k);
          cb();
        },
      },
    },
    runtime: { lastError: undefined as { message: string } | undefined },
  };
});

const SAMPLE: VaultTotalSnapshot = {
  vaultId: 'vault-a',
  usdMicros: 1_234_560_000n,
  mainnetUsdMicros: 1_234_560_000n,
  testnetUsdMicros: 0n,
  partial: false,
  lastFetchedMs: 1_700_000_000_000,
  perChain: [{ chainKey: 'sui', tier: 'mainnet', usdMicros: 1_234_560_000n, ok: true }],
};

describe('vault-total-cache', () => {
  it('vaultTotalCacheKey is namespaced + versioned', () => {
    expect(vaultTotalCacheKey('vault-a')).toBe('chromatika_vault_total_v2_vault-a');
  });

  it('round-trips a snapshot through chrome.storage.session', async () => {
    await writeVaultTotalSnapshot(SAMPLE);
    const got = await readVaultTotalSnapshot('vault-a');
    expect(got).toEqual(SAMPLE);
    expect(typeof got!.usdMicros).toBe('bigint');
  });

  it('returns null for unknown vault', async () => {
    expect(await readVaultTotalSnapshot('does-not-exist')).toBeNull();
  });

  it('isStaleSnapshot returns true past TTL, false within', () => {
    const now = 1_700_000_000_000;
    expect(isStaleSnapshot({ ...SAMPLE, lastFetchedMs: now - 4 * 60_000 }, now)).toBe(false);
    expect(isStaleSnapshot({ ...SAMPLE, lastFetchedMs: now - 6 * 60_000 }, now)).toBe(true);
  });

  it('isStaleSnapshot treats null as stale', () => {
    expect(isStaleSnapshot(null, Date.now())).toBe(true);
  });

  it('clearVaultTotalCache removes only the targeted row', async () => {
    await writeVaultTotalSnapshot(SAMPLE);
    await writeVaultTotalSnapshot({ ...SAMPLE, vaultId: 'vault-b' });
    await clearVaultTotalCache('vault-a');
    expect(await readVaultTotalSnapshot('vault-a')).toBeNull();
    expect(await readVaultTotalSnapshot('vault-b')).not.toBeNull();
  });

  it('readVaultTotalSnapshot rejects on chrome.runtime.lastError', async () => {
    (globalThis as unknown as { chrome: { runtime: { lastError: unknown } } }).chrome.runtime.lastError = { message: 'quota exceeded' };
    await expect(readVaultTotalSnapshot('vault-a')).rejects.toThrow('quota exceeded');
    (globalThis as unknown as { chrome: { runtime: { lastError: unknown } } }).chrome.runtime.lastError = undefined;
  });

  it('writeVaultTotalSnapshot rejects on chrome.runtime.lastError', async () => {
    (globalThis as unknown as { chrome: { runtime: { lastError: unknown } } }).chrome.runtime.lastError = { message: 'disk full' };
    await expect(writeVaultTotalSnapshot(SAMPLE)).rejects.toThrow('disk full');
    (globalThis as unknown as { chrome: { runtime: { lastError: unknown } } }).chrome.runtime.lastError = undefined;
  });

  it('clearVaultTotalCache rejects on chrome.runtime.lastError', async () => {
    (globalThis as unknown as { chrome: { runtime: { lastError: unknown } } }).chrome.runtime.lastError = { message: 'storage offline' };
    await expect(clearVaultTotalCache('vault-a')).rejects.toThrow('storage offline');
    (globalThis as unknown as { chrome: { runtime: { lastError: unknown } } }).chrome.runtime.lastError = undefined;
  });

  describe('parseStoredWireSnapshot', () => {
    it('round-trips wire format back to a snapshot with bigints', () => {
      const wire = {
        vaultId: 'vault-a',
        usdMicros: '1234560000',
        mainnetUsdMicros: '1234560000',
        testnetUsdMicros: '0',
        partial: false,
        lastFetchedMs: 1_700_000_000_000,
        perChain: [{ chainKey: 'sui', tier: 'mainnet', usdMicros: '1234560000', ok: true }],
      };
      const snap = parseStoredWireSnapshot(wire);
      expect(snap).not.toBeNull();
      expect(snap!.usdMicros).toBe(1_234_560_000n);
      expect(snap!.mainnetUsdMicros).toBe(1_234_560_000n);
      expect(snap!.testnetUsdMicros).toBe(0n);
      expect(snap!.perChain[0]!.usdMicros).toBe(1_234_560_000n);
      expect(snap!.perChain[0]!.tier).toBe('mainnet');
    });

    it('splits mainnet vs testnet across perChain rows', () => {
      const wire = {
        vaultId: 'vault-a',
        usdMicros: '500000000',
        mainnetUsdMicros: '300000000',
        testnetUsdMicros: '200000000',
        partial: false,
        lastFetchedMs: 1_700_000_000_000,
        perChain: [
          { chainKey: 'sui', tier: 'mainnet', usdMicros: '300000000', ok: true },
          { chainKey: 'sol', tier: 'testnet', usdMicros: '200000000', ok: true },
        ],
      };
      const snap = parseStoredWireSnapshot(wire);
      expect(snap).not.toBeNull();
      expect(snap!.mainnetUsdMicros).toBe(300_000_000n);
      expect(snap!.testnetUsdMicros).toBe(200_000_000n);
      expect(snap!.perChain[1]!.tier).toBe('testnet');
    });

    it('returns null for malformed input', () => {
      expect(parseStoredWireSnapshot(null)).toBeNull();
      expect(parseStoredWireSnapshot({})).toBeNull();
      expect(parseStoredWireSnapshot({ vaultId: 'v', usdMicros: 123 })).toBeNull();
      expect(parseStoredWireSnapshot('not an object')).toBeNull();
    });
  });
});
