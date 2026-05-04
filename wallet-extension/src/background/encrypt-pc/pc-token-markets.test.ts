/**
 * tests for the PC-Token market registry - pure storage round-trips. we mock chrome.storage so
 * the registry module sees a fresh in-memory backing store per test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type ChromeStorageMock = {
  store: Record<string, unknown>;
  get: (keys: string[], cb: (r: Record<string, unknown>) => void) => void;
  set: (items: Record<string, unknown>, cb: () => void) => void;
};

// vitest module hooks need a stable identity for the mock per file. each test resets `store`.
const storageMock: ChromeStorageMock = {
  store: {},
  get(keys, cb) {
    const out: Record<string, unknown> = {};
    for (const k of keys) {
      if (k in this.store) out[k] = this.store[k];
    }
    cb(out);
  },
  set(items, cb) {
    Object.assign(this.store, items);
    cb();
  },
};

beforeEach(() => {
  storageMock.store = {};
  // chrome.* is undefined in the vitest jsdom env - define just enough.
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: { local: storageMock },
    runtime: { lastError: null },
  };
});

afterEach(async () => {
  vi.resetModules();
});

const VALID_PROGRAM_A = 'PCToknwwK7tqrtKtbPpmK6jZ7n45iYQpzx95YRG7eXg';
// different known-valid base58 pubkey (System Program; doesn't matter what it points to for
// registry-side validation, only that it round-trips through PublicKey).
const VALID_PROGRAM_B = '11111111111111111111111111111112';
const VALID_USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const VALID_MINT_AUTH = 'So11111111111111111111111111111111111111112';

const baseMarket = {
  id: 'pcUSDC',
  label: 'pcUSDC (devnet)',
  splMint: VALID_USDC_MINT,
  splSymbol: 'USDC',
  splDecimals: 6,
  programId: VALID_PROGRAM_A,
  network: 'sol-devnet' as const,
};

describe('pc-token-markets', () => {
  it('starts empty: getActiveMarket returns null and eligibleSplMints is empty', async () => {
    const m = await import('@/background/encrypt-pc/pc-token-markets');
    await m.bootPcTokenMarkets();
    expect(m.listMarkets()).toEqual([]);
    expect(m.getActiveMarket()).toBeNull();
    expect(m.getActiveMarketId()).toBeNull();
    expect(m.eligibleSplMints().size).toBe(0);
  });

  it('first add becomes active automatically; list contains the entry', async () => {
    const m = await import('@/background/encrypt-pc/pc-token-markets');
    await m.bootPcTokenMarkets();
    const entry = await m.addMarket(baseMarket);
    expect(entry.id).toBe('pcUSDC');
    expect(entry.builtin).toBe(false);
    expect(m.listMarkets()).toHaveLength(1);
    expect(m.getActiveMarket()?.id).toBe('pcUSDC');
    expect(m.eligibleSplMints().has(VALID_USDC_MINT)).toBe(true);
  });

  it('two markets sharing the same splMint coexist; eligibleSplMints stays one entry', async () => {
    const m = await import('@/background/encrypt-pc/pc-token-markets');
    await m.bootPcTokenMarkets();
    await m.addMarket(baseMarket);
    await m.addMarket({ ...baseMarket, id: 'pcUSDC-friends', label: 'pcUSDC (friends)', programId: VALID_PROGRAM_B });
    expect(m.listMarkets()).toHaveLength(2);
    expect(m.marketsForSplMint(VALID_USDC_MINT)).toHaveLength(2);
    expect(m.eligibleSplMints().size).toBe(1);
    // first add stays active
    expect(m.getActiveMarket()?.id).toBe('pcUSDC');
  });

  it('removing the active market rolls activeMarketId to the next entry (or null when empty)', async () => {
    const m = await import('@/background/encrypt-pc/pc-token-markets');
    await m.bootPcTokenMarkets();
    await m.addMarket(baseMarket);
    await m.addMarket({ ...baseMarket, id: 'pcUSDC-b', programId: VALID_PROGRAM_B });
    await m.removeMarket('pcUSDC');
    expect(m.getActiveMarket()?.id).toBe('pcUSDC-b');
    await m.removeMarket('pcUSDC-b');
    expect(m.listMarkets()).toEqual([]);
    expect(m.getActiveMarket()).toBeNull();
  });

  it('rejects bad base58 program ID', async () => {
    const m = await import('@/background/encrypt-pc/pc-token-markets');
    await m.bootPcTokenMarkets();
    await expect(m.addMarket({ ...baseMarket, programId: 'not-base58!' })).rejects.toThrow(
      /not a valid base58 pubkey/,
    );
  });

  it('rejects duplicate market id', async () => {
    const m = await import('@/background/encrypt-pc/pc-token-markets');
    await m.bootPcTokenMarkets();
    await m.addMarket(baseMarket);
    await expect(m.addMarket(baseMarket)).rejects.toThrow(/already exists/);
  });

  it('updateMarket patches mutable fields; can clear mintAuthorityB58 with null', async () => {
    const m = await import('@/background/encrypt-pc/pc-token-markets');
    await m.bootPcTokenMarkets();
    await m.addMarket({ ...baseMarket, mintAuthorityB58: VALID_MINT_AUTH });
    const u1 = await m.updateMarket('pcUSDC', { label: 'renamed' });
    expect(u1.label).toBe('renamed');
    expect(u1.mintAuthorityB58).toBe(VALID_MINT_AUTH);
    const u2 = await m.updateMarket('pcUSDC', { mintAuthorityB58: null });
    expect(u2.mintAuthorityB58).toBeUndefined();
  });

  it('setActiveMarketId throws when target id is unknown', async () => {
    const m = await import('@/background/encrypt-pc/pc-token-markets');
    await m.bootPcTokenMarkets();
    await m.addMarket(baseMarket);
    await expect(m.setActiveMarketId('does-not-exist')).rejects.toThrow(/unknown market/);
    await m.setActiveMarketId(null);
    expect(m.getActiveMarketId()).toBeNull();
  });
});
