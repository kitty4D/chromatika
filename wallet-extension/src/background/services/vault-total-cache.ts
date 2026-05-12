import { VAULT_SCOPED_KEYS } from '@/background/storage/keys';

export type PerChainTotal = {
  chainKey: string;
  usdMicros: bigint;
  ok: boolean;
  reason?: string;
};

export type VaultTotalSnapshot = {
  vaultId: string;
  usdMicros: bigint;
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
  partial: boolean;
  lastFetchedMs: number;
  perChain: Array<{ chainKey: string; usdMicros: string; ok: boolean; reason?: string }>;
};

function toWire(s: VaultTotalSnapshot): WireSnapshot {
  return {
    vaultId: s.vaultId,
    usdMicros: s.usdMicros.toString(),
    partial: s.partial,
    lastFetchedMs: s.lastFetchedMs,
    perChain: s.perChain.map((p) => ({
      chainKey: p.chainKey,
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
    partial: w.partial,
    lastFetchedMs: w.lastFetchedMs,
    perChain: w.perChain.map((p) => ({
      chainKey: p.chainKey,
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
