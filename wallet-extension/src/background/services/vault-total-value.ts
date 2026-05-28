import type { VaultTotalSnapshot, PerChainTotal } from './vault-total-cache';

export type ChainBalanceProbe = PerChainTotal;

export type VaultDwalletAddresses = {
  dwalletId: string;
  addresses: {
    evm?: string;
    btcP2wpkh?: string;
    btcP2tr?: string;
    sui?: string;
    solana?: string;
    aptos?: string;
    deso?: string;
  };
};

export type VaultTotalDeps = {
  listVaultDwalletAddresses: (vaultId: string) => Promise<VaultDwalletAddresses[]>;
  probeAllChainsForVault: (
    vaultId: string,
    dwallets: VaultDwalletAddresses[],
  ) => Promise<ChainBalanceProbe[]>;
  nowMs: () => number;
};

export async function computeVaultTotalWithDeps(
  vaultId: string,
  deps: VaultTotalDeps,
): Promise<VaultTotalSnapshot> {
  let dwallets: VaultDwalletAddresses[] = [];
  let probes: ChainBalanceProbe[] = [];
  try {
    dwallets = await deps.listVaultDwalletAddresses(vaultId);
    probes = await deps.probeAllChainsForVault(vaultId, dwallets);
  } catch (err) {
    return {
      vaultId,
      usdMicros: 0n,
      mainnetUsdMicros: 0n,
      testnetUsdMicros: 0n,
      partial: true,
      lastFetchedMs: deps.nowMs(),
      perChain: [
        {
          chainKey: '_orchestrator',
          tier: 'mainnet',
          usdMicros: 0n,
          ok: false,
          reason: err instanceof Error ? err.message : String(err),
        },
      ],
    };
  }
  let mainnetTotal = 0n;
  let testnetTotal = 0n;
  for (const p of probes) {
    if (p.tier === 'testnet') testnetTotal += p.usdMicros;
    else mainnetTotal += p.usdMicros;
  }
  const partial = probes.some((p) => !p.ok);
  return {
    vaultId,
    usdMicros: mainnetTotal + testnetTotal,
    mainnetUsdMicros: mainnetTotal,
    testnetUsdMicros: testnetTotal,
    partial,
    lastFetchedMs: deps.nowMs(),
    perChain: probes,
  };
}

// ---------------------------------------------------------------------------
// public convenience API (wires real fetchers + cache)
// ---------------------------------------------------------------------------

import {
  listAddressesForVaultFromMeta,
  probeAllChainsForVaultDefault,
} from './vault-total-fetchers';
import {
  readVaultTotalSnapshot,
  writeVaultTotalSnapshot,
  isStaleSnapshot,
} from './vault-total-cache';

export type { VaultTotalSnapshot };

export function defaultVaultTotalDeps(): VaultTotalDeps {
  return {
    listVaultDwalletAddresses: listAddressesForVaultFromMeta,
    probeAllChainsForVault: probeAllChainsForVaultDefault,
    nowMs: () => Date.now(),
  };
}

export async function computeVaultTotal(vaultId: string): Promise<VaultTotalSnapshot> {
  const snap = await computeVaultTotalWithDeps(vaultId, defaultVaultTotalDeps());
  await writeVaultTotalSnapshot(snap);
  return snap;
}

export async function getCachedVaultTotal(vaultId: string): Promise<VaultTotalSnapshot | null> {
  return readVaultTotalSnapshot(vaultId);
}

const REFRESH_CONCURRENCY = 3;

export async function refreshVaultTotalsBatch(vaultIds: string[]): Promise<VaultTotalSnapshot[]> {
  const out: VaultTotalSnapshot[] = [];
  for (let i = 0; i < vaultIds.length; i += REFRESH_CONCURRENCY) {
    const slice = vaultIds.slice(i, i + REFRESH_CONCURRENCY);
    const got = await Promise.all(slice.map(computeVaultTotal));
    out.push(...got);
  }
  return out;
}

export async function getOrRefreshVaultTotal(vaultId: string): Promise<VaultTotalSnapshot> {
  const cached = await readVaultTotalSnapshot(vaultId);
  if (cached && !isStaleSnapshot(cached, Date.now())) return cached;
  return computeVaultTotal(vaultId);
}
