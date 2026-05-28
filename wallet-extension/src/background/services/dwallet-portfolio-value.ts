/**
 * ChromaLab dWallet leaderboard - per-dWallet USD compute path.
 *
 * given an arbitrary on-chain dWallet object id (NOT a vault id from the user's
 * local store), fetch its `public_output` from chain, derive every chain address
 * the dWallet can sign for, and probe each chain's balance into a USD total.
 *
 * the heavy lifting comes from reusable helpers we extracted from the per-vault
 * path: `probeAllChainsForAddresses` is the same probe loop the user's own
 * vault total runs, just unbound from a specific vault id. that means a dWallet
 * the user has never seen before goes through identical pricing + balance code -
 * if it works for your own wallet, it works for everyone else's too.
 *
 * caching mirrors `vault-total-value.ts`: SWR with 5 min TTL stored in
 * `chrome.storage.session`, plus a fire-and-forget refresh path that lets the UI
 * paint cached data immediately and update on `chrome.storage.onChanged` once
 * the background re-probe completes.
 */

import { chainAddressesForDwalletId } from '@/background/chains/dwallet-derived-addresses';
import {
  probeAllChainsForAddresses,
  resolveDefaultNetworkBundle,
} from '@/background/services/vault-total-fetchers';
import {
  isStaleSnapshot,
  readDWalletPortfolioSnapshot,
  writeDWalletPortfolioSnapshot,
  type DWalletPortfolioSnapshot,
} from '@/background/services/dwallet-portfolio-cache';
import type { CurveKey } from '@/background/session';

function emptyAddresses(): DWalletPortfolioSnapshot['addresses'] {
  return {};
}

function partialSnapshot(
  dwalletId: string,
  curve: DWalletPortfolioSnapshot['curve'],
  stateKind: string,
  reason: string,
  nowMs: number,
): DWalletPortfolioSnapshot {
  return {
    dwalletId,
    curve,
    stateKind,
    addresses: emptyAddresses(),
    usdMicros: 0n,
    partial: true,
    lastFetchedMs: nowMs,
    perChain: [
      {
        chainKey: '_orchestrator',
        tier: 'mainnet',
        usdMicros: 0n,
        ok: false,
        reason,
      },
    ],
  };
}

function narrowCurve(curve: CurveKey | 'unknown'): DWalletPortfolioSnapshot['curve'] {
  if (curve === 'SECP256K1' || curve === 'ED25519') return curve;
  return 'unknown';
}

/**
 * core compute pipeline. produces a fresh snapshot for `dwalletId` by reading
 * the dWallet from chain via the session's ika client (which uses the vault's
 * `SuiGraphQLClient` per CLAUDE.md - no JSON-RPC). on any failure we return a
 * `partial: true` snapshot rather than throwing so the orchestrator never sees
 * an unhandled rejection and the leaderboard UI can render the row with a
 * 'partial' affordance.
 */
export async function computeDWalletPortfolio(dwalletId: string): Promise<DWalletPortfolioSnapshot> {
  const nowMs = Date.now();

  let curve: DWalletPortfolioSnapshot['curve'] = 'unknown';
  let stateKind = 'unknown';
  let addresses: DWalletPortfolioSnapshot['addresses'] = emptyAddresses();

  try {
    const pack = await chainAddressesForDwalletId(dwalletId);
    curve = narrowCurve(pack.curve);
    stateKind = pack.status;
    addresses = pack.addresses;
  } catch (err) {
    return partialSnapshot(
      dwalletId,
      curve,
      stateKind,
      err instanceof Error ? err.message : String(err),
      nowMs,
    );
  }

  if (Object.keys(addresses).length === 0) {
    return partialSnapshot(
      dwalletId,
      curve,
      stateKind,
      stateKind === 'Active' ? 'no-derived-addresses' : `state=${stateKind}`,
      nowMs,
    );
  }

  let bundle: Awaited<ReturnType<typeof resolveDefaultNetworkBundle>>;
  try {
    bundle = await resolveDefaultNetworkBundle();
  } catch (err) {
    return {
      dwalletId,
      curve,
      stateKind,
      addresses,
      usdMicros: 0n,
      partial: true,
      lastFetchedMs: nowMs,
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

  const probes = await probeAllChainsForAddresses(addresses, bundle);
  let total = 0n;
  for (const p of probes) total += p.usdMicros;
  const partial = probes.some((p) => !p.ok);

  const snap: DWalletPortfolioSnapshot = {
    dwalletId,
    curve,
    stateKind,
    addresses,
    usdMicros: total,
    partial,
    lastFetchedMs: nowMs,
    perChain: probes,
  };
  await writeDWalletPortfolioSnapshot(snap);
  return snap;
}

/**
 * SWR wrapper. returns the cached snapshot if fresh; otherwise (re)computes.
 * callers that want stale-while-revalidate semantics should call
 * `getCachedOrTriggerRefresh` instead.
 */
export async function getOrRefreshDWalletPortfolio(dwalletId: string): Promise<DWalletPortfolioSnapshot> {
  const cached = await readDWalletPortfolioSnapshot(dwalletId);
  if (cached && !isStaleSnapshot(cached, Date.now())) return cached;
  return computeDWalletPortfolio(dwalletId);
}

/**
 * stale-while-revalidate: returns the cached snapshot immediately (even if
 * stale or null), and kicks off a background refresh if it was stale. UI
 * picks up the update via `chrome.storage.onChanged` on the per-dwallet key.
 */
export async function getCachedOrTriggerRefresh(dwalletId: string): Promise<DWalletPortfolioSnapshot | null> {
  const cached = await readDWalletPortfolioSnapshot(dwalletId);
  if (cached && !isStaleSnapshot(cached, Date.now())) return cached;
  void computeDWalletPortfolio(dwalletId).catch((err) => {
    console.warn('[leaderboard] dWallet portfolio refresh failed:', dwalletId, err);
  });
  return cached;
}
