import { describe, it, expect, vi } from 'vitest';
import {
  computeVaultTotalWithDeps,
  type VaultTotalDeps,
  type ChainBalanceProbe,
} from './vault-total-value';

function makeProbe(
  chainKey: string,
  usdMicros: bigint,
  ok = true,
  reason?: string,
  tier: 'mainnet' | 'testnet' = 'mainnet',
): ChainBalanceProbe {
  return { chainKey, tier, usdMicros, ok, reason };
}

function depsWithProbes(probes: ChainBalanceProbe[]): VaultTotalDeps {
  return {
    listVaultDwalletAddresses: vi.fn(async () => [{ dwalletId: 'd1', addresses: { sui: '0xabc' } }]),
    probeAllChainsForVault: vi.fn(async () => probes),
    nowMs: () => 1_700_000_000_000,
  };
}

describe('computeVaultTotalWithDeps', () => {
  it('sums per-chain micros into the total', async () => {
    const deps = depsWithProbes([
      makeProbe('sui', 100_000_000n),
      makeProbe('eth', 250_000_000n),
    ]);
    const snap = await computeVaultTotalWithDeps('vault-a', deps);
    expect(snap.usdMicros).toBe(350_000_000n);
    expect(snap.partial).toBe(false);
    expect(snap.perChain).toHaveLength(2);
  });

  it('marks partial when any probe failed', async () => {
    const deps = depsWithProbes([
      makeProbe('sui', 100_000_000n),
      makeProbe('eth', 0n, false, 'rpc-timeout'),
    ]);
    const snap = await computeVaultTotalWithDeps('vault-a', deps);
    expect(snap.usdMicros).toBe(100_000_000n);
    expect(snap.partial).toBe(true);
    expect(snap.perChain.find((p) => p.chainKey === 'eth')?.reason).toBe('rpc-timeout');
  });

  it('returns zero with empty perChain when vault has no dwallets', async () => {
    const deps: VaultTotalDeps = {
      listVaultDwalletAddresses: vi.fn(async () => []),
      probeAllChainsForVault: vi.fn(async () => []),
      nowMs: () => 1_700_000_000_000,
    };
    const snap = await computeVaultTotalWithDeps('vault-empty', deps);
    expect(snap.usdMicros).toBe(0n);
    expect(snap.partial).toBe(false);
    expect(snap.perChain).toEqual([]);
  });

  it('handles all probes failing', async () => {
    const deps = depsWithProbes([
      makeProbe('sui', 0n, false, 'rpc-timeout'),
      makeProbe('eth', 0n, false, 'no-price'),
    ]);
    const snap = await computeVaultTotalWithDeps('vault-a', deps);
    expect(snap.usdMicros).toBe(0n);
    expect(snap.partial).toBe(true);
    expect(snap.perChain.every((p) => !p.ok)).toBe(true);
  });

  it('saturates near u64 max without overflow throw', async () => {
    const big = (1n << 63n) - 1n;
    const deps = depsWithProbes([makeProbe('sui', big), makeProbe('eth', 1_000_000n)]);
    const snap = await computeVaultTotalWithDeps('vault-a', deps);
    expect(snap.usdMicros).toBe(big + 1_000_000n);
  });

  it('stamps lastFetchedMs from deps.nowMs', async () => {
    const deps = depsWithProbes([makeProbe('sui', 100n)]);
    const snap = await computeVaultTotalWithDeps('vault-a', deps);
    expect(snap.lastFetchedMs).toBe(1_700_000_000_000);
  });

  it('catches throw inside probeAllChainsForVault and returns total-failure snapshot', async () => {
    const deps: VaultTotalDeps = {
      listVaultDwalletAddresses: vi.fn(async () => [{ dwalletId: 'd1', addresses: {} }]),
      probeAllChainsForVault: vi.fn(async () => {
        throw new Error('boom');
      }),
      nowMs: () => 1_700_000_000_000,
    };
    const snap = await computeVaultTotalWithDeps('vault-a', deps);
    expect(snap.usdMicros).toBe(0n);
    expect(snap.partial).toBe(true);
    expect(snap.perChain).toEqual([
      { chainKey: '_orchestrator', tier: 'mainnet', usdMicros: 0n, ok: false, reason: 'boom' },
    ]);
  });

  describe('mainnet vs testnet split', () => {
    it('routes mainnet rows into mainnetUsdMicros and testnet rows into testnetUsdMicros', async () => {
      const deps = depsWithProbes([
        makeProbe('sui', 100_000_000n, true, undefined, 'mainnet'),
        makeProbe('eth', 250_000_000n, true, undefined, 'mainnet'),
        makeProbe('sol', 75_000_000n, true, undefined, 'testnet'),
      ]);
      const snap = await computeVaultTotalWithDeps('vault-a', deps);
      expect(snap.mainnetUsdMicros).toBe(350_000_000n);
      expect(snap.testnetUsdMicros).toBe(75_000_000n);
      expect(snap.usdMicros).toBe(425_000_000n);
    });

    it('mainnet + testnet both zero when no probes', async () => {
      const deps: VaultTotalDeps = {
        listVaultDwalletAddresses: vi.fn(async () => []),
        probeAllChainsForVault: vi.fn(async () => []),
        nowMs: () => 1_700_000_000_000,
      };
      const snap = await computeVaultTotalWithDeps('vault-empty', deps);
      expect(snap.mainnetUsdMicros).toBe(0n);
      expect(snap.testnetUsdMicros).toBe(0n);
    });
  });
});
