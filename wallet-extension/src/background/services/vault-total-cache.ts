import { VAULT_SCOPED_KEYS } from '@/background/storage/keys';

/** mainnet vs testnet/devnet tier per per-chain probe row. lets the UI split the
 *  headline total so testnet/devnet balances priced against the mainnet oracle
 *  don't inflate the "real money" number. propagated from probe dispatch via
 *  `ChainProbeNetworkBundle` (see vault-total-fetchers.ts). */
export type NetworkTier = 'mainnet' | 'testnet';

export type PerChainTotal = {
  chainKey: string;
  /** mainnet or testnet/devnet. testnets are still summed (against mainnet prices)
   *  so the user can see "what your testnet stack would be worth on real chains",
   *  but the UI labels them clearly so they don't get confused with real value. */
  tier: NetworkTier;
  usdMicros: bigint;
  ok: boolean;
  reason?: string;
};

export type VaultTotalSnapshot = {
  vaultId: string;
  /** sum of mainnet + testnet (kept for the few consumers that haven't moved to the split). */
  usdMicros: bigint;
  /** mainnet-only headline number. this is the "real money" line. */
  mainnetUsdMicros: bigint;
  /** testnet/devnet line, priced against the mainnet oracle (notional only). */
  testnetUsdMicros: bigint;
  partial: boolean;
  lastFetchedMs: number;
  perChain: PerChainTotal[];
};

export const VAULT_TOTAL_CACHE_TTL_MS = 5 * 60_000;

export function vaultTotalCacheKey(vaultId: string): string {
  return VAULT_SCOPED_KEYS.vaultTotal(vaultId);
}

type WireSnapshot = {
  vaultId: string;
  usdMicros: string;
  mainnetUsdMicros: string;
  testnetUsdMicros: string;
  partial: boolean;
  lastFetchedMs: number;
  perChain: Array<{
    chainKey: string;
    tier: NetworkTier;
    usdMicros: string;
    ok: boolean;
    reason?: string;
  }>;
};

function toWire(s: VaultTotalSnapshot): WireSnapshot {
  return {
    vaultId: s.vaultId,
    usdMicros: s.usdMicros.toString(),
    mainnetUsdMicros: s.mainnetUsdMicros.toString(),
    testnetUsdMicros: s.testnetUsdMicros.toString(),
    partial: s.partial,
    lastFetchedMs: s.lastFetchedMs,
    perChain: s.perChain.map((p) => ({
      chainKey: p.chainKey,
      tier: p.tier,
      usdMicros: p.usdMicros.toString(),
      ok: p.ok,
      reason: p.reason,
    })),
  };
}

function fromWire(w: WireSnapshot): VaultTotalSnapshot {
  return {
    vaultId: w.vaultId,
    usdMicros: BigInt(w.usdMicros),
    mainnetUsdMicros: BigInt(w.mainnetUsdMicros),
    testnetUsdMicros: BigInt(w.testnetUsdMicros),
    partial: w.partial,
    lastFetchedMs: w.lastFetchedMs,
    perChain: w.perChain.map((p) => ({
      chainKey: p.chainKey,
      tier: p.tier === 'testnet' ? 'testnet' : 'mainnet',
      usdMicros: BigInt(p.usdMicros),
      ok: p.ok,
      reason: p.reason,
    })),
  };
}

export async function readVaultTotalSnapshot(vaultId: string): Promise<VaultTotalSnapshot | null> {
  const key = vaultTotalCacheKey(vaultId);
  return new Promise((resolve, reject) => {
    chrome.storage.session.get([key], (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      const wire = result[key] as WireSnapshot | undefined;
      resolve(wire ? fromWire(wire) : null);
    });
  });
}

export async function writeVaultTotalSnapshot(snapshot: VaultTotalSnapshot): Promise<void> {
  const key = vaultTotalCacheKey(snapshot.vaultId);
  return new Promise((resolve, reject) => {
    chrome.storage.session.set({ [key]: toWire(snapshot) }, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

export async function clearVaultTotalCache(vaultId: string): Promise<void> {
  const key = vaultTotalCacheKey(vaultId);
  return new Promise((resolve, reject) => {
    chrome.storage.session.remove([key], () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

export function parseStoredWireSnapshot(value: unknown): VaultTotalSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Partial<WireSnapshot>;
  if (
    typeof v.vaultId !== 'string' ||
    typeof v.usdMicros !== 'string' ||
    typeof v.mainnetUsdMicros !== 'string' ||
    typeof v.testnetUsdMicros !== 'string' ||
    typeof v.partial !== 'boolean' ||
    typeof v.lastFetchedMs !== 'number' ||
    !Array.isArray(v.perChain)
  ) {
    return null;
  }
  try {
    return fromWire(v as WireSnapshot);
  } catch {
    return null;
  }
}

export function isStaleSnapshot(snapshot: VaultTotalSnapshot | null, nowMs: number): boolean {
  if (!snapshot) return true;
  return nowMs - snapshot.lastFetchedMs > VAULT_TOTAL_CACHE_TTL_MS;
}
