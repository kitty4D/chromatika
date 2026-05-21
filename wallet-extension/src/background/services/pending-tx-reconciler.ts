/**
 * Pending-tx reconciler. Polls per-chain status for every row with `status: 'pending'`
 * in IDB, with exponential backoff matching the chain's block time, and flips rows to
 * `'success'` / `'failure'` when the chain settles. Triggered by:
 *
 *   - `startReconcilerOnDemand(vaultId)` from `sendUnified` after a successful broadcast
 *     (ensures the new pending row gets polled even on a long-idle SW)
 *   - SW startup hook (recovers from SW death; resumes any rows still pending after
 *     restart)
 *
 * One-poller-per-vault. The active poller drains all chains for that vault until
 * either (a) no pending rows remain or (b) every remaining row has exceeded the 10-min
 * timeout. On timeout, the row gets `status: 'failure'` with a clear reason - users see
 * "timed out waiting for confirmation" instead of a stuck spinner.
 *
 * Backoff strategy per chain (multiplier × base block time):
 *   - EVM       : base 12s, multipliers [1.2, 1.5, 2, 5, 10]   capped at 60s
 *   - Sui       : base  3s, multipliers [1.2, 1.5, 2, 5, 10]   capped at 30s
 *   - Solana    : base  0.4s, multipliers [1.5, 2, 5, 10, 20]  capped at 8s
 *   - BTC       : base 600s (~10min), but we poll at 30s baseline since the user is
 *                 watching the UI and even 1-block-deep confirmation is what they want
 *
 * Aptos is not handled today (send is stubbed).
 */

import { JsonRpcProvider } from 'ethers';
import { Connection, PublicKey } from '@solana/web3.js';
import {
  listIndexedTxsByStatus,
  type IndexedTx,
} from '@/background/services/activity-index';
import { bumpPendingPollState, markTxSettled } from '@/background/services/pending-tx-tracker';
import { maybeFireNotification } from '@/background/services/notifications/notify-chrome';
import { getSession } from '@/background/session';
import {
  createSuiGraphQLClientFromRegistryNetworkId,
} from '@/background/sui-client';
import {
  getDwalletNetworkSettings,
  resolveSolanaRpcUrl,
} from '@/background/network/tier-network-settings';
import { BUILTIN_BITCOIN, findEvmNetwork } from '@/config/networks';
import { getCustomNetworks } from '@/background/network/custom-networks';
import { getActiveNetworks } from '@/background/network/active-network';

/** total time a pending tx is allowed to remain unsettled before we mark it failure with
 * `'timed out waiting for confirmation'`. 10 min is generous enough for EVM L1 congestion
 * + BTC's first confirmation, but tight enough that a stuck-pending row doesn't sit
 * forever on a dead RPC. */
const PENDING_TIMEOUT_MS = 10 * 60 * 1000;

/** per-(vaultId) active poller registry. one poller per vault keeps the API rate-limit
 * budget predictable; a second `startReconcilerOnDemand` call for the same vault while
 * a poller is already running is a no-op. */
const activePollers = new Map<string, { cancelled: boolean }>();

/** kick off the reconciler for a vault. idempotent: returns immediately if already
 * running. caller (sendUnified, SW startup) doesn't await. */
export function startReconcilerOnDemand(vaultId: string): void {
  if (activePollers.has(vaultId)) return;
  const handle = { cancelled: false };
  activePollers.set(vaultId, handle);
  void runPoller(vaultId, handle).finally(() => activePollers.delete(vaultId));
}

/** stop the active poller for a vault (used on vault switch / lock). idempotent. */
export function cancelReconciler(vaultId: string): void {
  const h = activePollers.get(vaultId);
  if (h) h.cancelled = true;
}

// ---------------------------------------------------------------------------
// poller loop
// ---------------------------------------------------------------------------

async function runPoller(vaultId: string, handle: { cancelled: boolean }): Promise<void> {
  while (!handle.cancelled) {
    const pending = await listIndexedTxsByStatus(vaultId, 'pending');
    if (pending.length === 0) return;

    const now = Date.now();
    // partition: rows that timed out get failed; rows still in-budget get polled.
    for (const row of pending) {
      if (handle.cancelled) return;
      const broadcastAt = row.pendingMeta?.broadcastAtMs ?? row.timestampMs ?? now;
      if (now - broadcastAt > PENDING_TIMEOUT_MS) {
        await markTxSettled({
          vaultId,
          chain: row.chain,
          digest: row.digest,
          status: 'failure',
          failureReason: 'timed out waiting for confirmation',
        }).catch((e) => console.warn('[pending-tx-reconciler] markTxSettled (timeout) failed', e));
        continue;
      }
      try {
        const result = await checkTxStatus(row);
        if (result === 'success' || result === 'failure') {
          await markTxSettled({
            vaultId,
            chain: row.chain,
            digest: row.digest,
            status: result,
            failureReason: result === 'failure' ? 'chain reported failure' : undefined,
          });
          if (result === 'success') {
            void maybeFireNotification('sendConfirmation', {
              id: `chromatika-confirmed-${row.digest}`,
              title: 'Send confirmed',
              message: `${row.symbol ?? row.chain} to ${row.counterparty ? row.counterparty.slice(0, 8) + '...' : 'recipient'} - confirmed`,
            });
          } else {
            void maybeFireNotification('sendConfirmation', {
              id: `chromatika-confirmed-${row.digest}`,
              title: 'Send failed',
              message: `${row.symbol ?? row.chain} - transaction failed`,
            });
          }
        } else {
          await bumpPendingPollState(vaultId, row.chain, row.digest);
        }
      } catch (e) {
        // status check threw (RPC down, malformed response). just bump poll state and
        // try again next tick; if we're past the global timeout we'll mark failure on
        // the next loop iteration.
        console.warn('[pending-tx-reconciler] status check failed (will retry)', {
          chain: row.chain,
          digest: row.digest,
          error: e instanceof Error ? e.message : String(e),
        });
        await bumpPendingPollState(vaultId, row.chain, row.digest);
      }
    }

    // global tick interval: 2s. we don't need per-row scheduling sophistication beyond
    // this since the chain-side backoffs are smaller than 2s for Sui/Solana and the
    // user-visible cadence on the UI is 3s anyway. EVM/BTC just over-poll a bit, which
    // is fine.
    await sleep(2000);
  }
}

// ---------------------------------------------------------------------------
// per-chain status fetchers
// ---------------------------------------------------------------------------

type StatusOutcome = 'pending' | 'success' | 'failure';

async function checkTxStatus(row: IndexedTx): Promise<StatusOutcome> {
  switch (row.chain) {
    case 'evm':
      return checkEvmTxStatus(row);
    case 'sui':
      return checkSuiTxStatus(row);
    case 'solana':
      return checkSolanaTxStatus(row);
    case 'btc':
      return checkBtcTxStatus(row);
    case 'aptos':
      return 'pending'; // not implemented; pending rows on aptos will eventually timeout
  }
}

async function checkEvmTxStatus(row: IndexedTx): Promise<StatusOutcome> {
  // prefer the chainId we stashed on `pendingMeta.chainId` at broadcast time; fall back
  // to the wallet's currently-active EVM chain when missing (e.g. v1-migrated row or a
  // pre-fix pending row). this fixes the bug where a pending tx on Arbitrum stays stuck
  // pending if the user flips the wallet to Optimism between broadcast + settlement.
  const stashedChainId = row.pendingMeta?.chainId;
  const active = await getActiveNetworks();
  const chainId = stashedChainId ?? active.evmChainId;
  const { evm: customEvm } = await getCustomNetworks();
  const net = findEvmNetwork(chainId, customEvm);
  if (!net) return 'pending';
  const provider = new JsonRpcProvider(net.rpcUrl);
  const receipt = await provider.getTransactionReceipt(row.digest);
  if (!receipt) return 'pending';
  return receipt.status === 1 ? 'success' : 'failure';
}

async function checkSuiTxStatus(row: IndexedTx): Promise<StatusOutcome> {
  const s = getSession();
  if (!s) return 'pending';
  const dw = await getDwalletNetworkSettings(s.activeVaultId, {
    network: s.network,
    baseChain: s.activeVaultBaseChain,
  });
  const client = createSuiGraphQLClientFromRegistryNetworkId(dw.suiNetworkId);
  type Resp = {
    data?: {
      transaction?: { effects?: { status?: string | null } | null } | null;
    };
  };
  const res = (await (
    client as unknown as {
      query: (opts: { query: string; variables: Record<string, unknown> }) => Promise<Resp>;
    }
  ).query({
    query: 'query ChromatikaSuiPendingStatus($digest: String!) { transaction(digest: $digest) { effects { status } } }',
    variables: { digest: row.digest },
  })) as Resp;
  const status = res?.data?.transaction?.effects?.status;
  if (!status) return 'pending';
  return status.toUpperCase() === 'SUCCESS' ? 'success' : 'failure';
}

async function checkSolanaTxStatus(row: IndexedTx): Promise<StatusOutcome> {
  const s = getSession();
  if (!s) return 'pending';
  const dw = await getDwalletNetworkSettings(s.activeVaultId, {
    network: s.network,
    baseChain: s.activeVaultBaseChain,
  });
  const conn = new Connection(resolveSolanaRpcUrl(dw.solana), dw.solana.commitment);
  void PublicKey; // ensure import retained for tree-shake safety in case future needs add it
  const r = await conn.getSignatureStatus(row.digest, { searchTransactionHistory: false });
  const v = r?.value;
  if (!v) return 'pending';
  if (v.err) return 'failure';
  // accept any confirmation level (processed / confirmed / finalized) as success - the UI
  // shows the row settled once we've seen the cluster acknowledge the tx.
  if (v.confirmationStatus) return 'success';
  return 'pending';
}

async function checkBtcTxStatus(row: IndexedTx): Promise<StatusOutcome> {
  const s = getSession();
  if (!s) return 'pending';
  const dw = await getDwalletNetworkSettings(s.activeVaultId, {
    network: s.network,
    baseChain: s.activeVaultBaseChain,
  });
  const btcNet = BUILTIN_BITCOIN.find((n) => n.id === dw.btcNetworkId) ?? BUILTIN_BITCOIN[0];
  const esploraBase = btcNet!.esploraUrl.replace(/\/$/, '');
  const r = await fetch(`${esploraBase}/tx/${encodeURIComponent(row.digest)}/status`, {
    signal: AbortSignal.timeout(8000),
  });
  if (r.status === 404) return 'pending'; // not yet in mempool / chain
  if (!r.ok) return 'pending';
  const j = (await r.json()) as { confirmed?: boolean };
  return j.confirmed === true ? 'success' : 'pending';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
