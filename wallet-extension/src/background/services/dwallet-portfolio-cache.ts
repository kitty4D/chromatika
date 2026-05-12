/**
 * per-dWallet USD portfolio snapshot cache for the ChromaLab leaderboard.
 *
 * mirrors `vault-total-cache.ts` exactly except the key family is per-dWallet-id
 * (any owner) rather than per-vault. session-scoped, 5 min SWR TTL so the
 * leaderboard refresh tick stays cheap.
 */

import { DWALLET_SCOPED_KEYS, DWALLET_PORTFOLIO_KEY_PREFIX } from '@/background/storage/keys';
import type { PerChainTotal } from '@/background/services/vault-total-cache';

export type DWalletPortfolioSnapshot = {
  dwalletId: string;
  /** ika curve at the time we snapshotted (`SECP256K1`, `ED25519`, or `unknown` if not yet active). */
  curve: 'SECP256K1' | 'ED25519' | 'unknown';
  /** ika state kind (`Active`, `AwaitingKeyHolderSignature`, etc). */
  stateKind: string;
  /** derived chain addresses we probed. */
  addresses: {
    evm?: string;
    btcP2wpkh?: string;
    btcP2tr?: string;
    sui?: string;
    solana?: string;
    aptos?: string;
    deso?: string;
  };
  usdMicros: bigint;
  /** true when address derivation failed, the dWallet is not yet `Active`, or any probe errored. */
  partial: boolean;
  lastFetchedMs: number;
  perChain: PerChainTotal[];
};

/** match `VAULT_TOTAL_CACHE_TTL_MS` so freshness expectations stay consistent across surfaces. */
export const DWALLET_PORTFOLIO_CACHE_TTL_MS = 5 * 60_000;

export function dwalletPortfolioCacheKey(dwalletId: string): string {
  return DWALLET_SCOPED_KEYS.dwalletPortfolio(dwalletId);
}

export { DWALLET_PORTFOLIO_KEY_PREFIX };

type WireSnapshot = {
  dwalletId: string;
  curve: 'SECP256K1' | 'ED25519' | 'unknown';
  stateKind: string;
  addresses: DWalletPortfolioSnapshot['addresses'];
  usdMicros: string;
  partial: boolean;
  lastFetchedMs: number;
  perChain: Array<{ chainKey: string; usdMicros: string; ok: boolean; reason?: string }>;
};

function toWire(s: DWalletPortfolioSnapshot): WireSnapshot {
  return {
    dwalletId: s.dwalletId,
    curve: s.curve,
    stateKind: s.stateKind,
    addresses: s.addresses,
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

function fromWire(w: WireSnapshot): DWalletPortfolioSnapshot {
  return {
    dwalletId: w.dwalletId,
    curve: w.curve,
    stateKind: w.stateKind,
    addresses: w.addresses ?? {},
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

export async function readDWalletPortfolioSnapshot(dwalletId: string): Promise<DWalletPortfolioSnapshot | null> {
  const key = dwalletPortfolioCacheKey(dwalletId);
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

export async function writeDWalletPortfolioSnapshot(snapshot: DWalletPortfolioSnapshot): Promise<void> {
  const key = dwalletPortfolioCacheKey(snapshot.dwalletId);
  return new Promise((resolve, reject) => {
    chrome.storage.session.set({ [key]: toWire(snapshot) }, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

export async function clearDWalletPortfolioCache(dwalletId: string): Promise<void> {
  const key = dwalletPortfolioCacheKey(dwalletId);
  return new Promise((resolve, reject) => {
    chrome.storage.session.remove([key], () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

/** parse a value pulled from `chrome.storage.onChanged` payloads (already wire-shaped). */
export function parseStoredWireSnapshot(value: unknown): DWalletPortfolioSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Partial<WireSnapshot>;
  if (
    typeof v.dwalletId !== 'string'
    || typeof v.usdMicros !== 'string'
    || typeof v.partial !== 'boolean'
    || typeof v.lastFetchedMs !== 'number'
    || !Array.isArray(v.perChain)
  ) {
    return null;
  }
  try {
    return fromWire(v as WireSnapshot);
  } catch {
    return null;
  }
}

export function isStaleSnapshot(snapshot: DWalletPortfolioSnapshot | null, nowMs: number): boolean {
  if (!snapshot) return true;
  return nowMs - snapshot.lastFetchedMs > DWALLET_PORTFOLIO_CACHE_TTL_MS;
}

/** load ALL per-dwallet snapshots from session storage in one read. used to assemble leaderboard rows. */
export async function readAllDWalletPortfolioSnapshots(): Promise<DWalletPortfolioSnapshot[]> {
  return new Promise((resolve, reject) => {
    chrome.storage.session.get(null, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      const out: DWalletPortfolioSnapshot[] = [];
      for (const [k, v] of Object.entries(result)) {
        if (!k.startsWith(DWALLET_PORTFOLIO_KEY_PREFIX)) continue;
        const parsed = parseStoredWireSnapshot(v);
        if (parsed) out.push(parsed);
      }
      resolve(out);
    });
  });
}
