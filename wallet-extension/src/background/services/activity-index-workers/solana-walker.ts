/**
 * Solana activity-index worker. Paginates `getSignaturesForAddress` back through the
 * cluster's signature history, then fetches per-tx details lazily on a sample basis to
 * extract the recipient.
 *
 * IMPORTANT - coverage ceiling: `'complete-to-retention'`, NOT `'complete-to-genesis'`.
 * Solana RPCs don't retain full chain history by default - the free Helius / public
 * Ankr / Solana Labs endpoints typically expose ~2 epochs (~6 days) of signature data.
 * Even Helius's paid plan caps at a longer-but-finite window. We CAN'T claim "all
 * history" on Solana without an archival provider, and even then we'd want to verify it
 * per-RPC. So the orchestrator marks the final status as `'complete-to-retention'` once
 * the walker drains pagination - the verdict policy in `activity-index.ts` then renders
 * the muted "indexer only retains recent history" footnote on the Confirm screen.
 *
 * counterparty extraction: limited. `getSignaturesForAddress` returns signature + slot +
 * memo + err; it does NOT return the recipient. We'd need a per-tx `getTransaction` call
 * to extract balance changes - O(N) RPC calls on top of the pagination. For Phase 2 we
 * record rows with `counterparty: null` (so the first-time check degrades to the
 * `chromatika-only` tier on Solana). Phase 3 can add an opt-in "deep index" mode that
 * spends the RPC budget for per-tx parsing.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { resolveSolanaRpcUrl, getDwalletNetworkSettings } from '@/background/network/tier-network-settings';
import { getSession } from '@/background/session';
import type { IndexWalker } from '@/background/services/activity-index-orchestrator';
import { makeTxKey, type IndexedTx } from '@/background/services/activity-index';
import {
  classifySolanaTx,
  type ParsedTxLite,
} from '@/background/services/activity-classifier/solana-classifier';

const PAGE_SIZE = 1000; // RPC max; smaller chunks waste round trips
/** how many top-of-page signatures to deep-fetch via `getParsedTransaction` for kind +
 * memo extraction. each call is ~200ms; 12 keeps the page latency reasonable while
 * giving us classified data for the rows most likely to be user-visible. older rows
 * stay `kind: 'unknown'` and the TxDetailModal's per-tx fetch lights them up on click. */
const LAZY_CLASSIFY_HEAD = 12;

export const solanaActivityIndexWalker: IndexWalker = {
  chain: 'solana',
  source: 'solana-rpc',
  coverageCeiling: 'complete-to-retention',

  async fetchPage({ vaultId, address, cursor }) {
    const s = getSession();
    if (!s) throw new Error('Wallet locked');
    const dw = await getDwalletNetworkSettings(s.activeVaultId, {
      network: s.network,
      baseChain: s.activeVaultBaseChain,
    });
    const rpcUrl = resolveSolanaRpcUrl(dw.solana);
    const conn = new Connection(rpcUrl, dw.solana.commitment);

    const pubkey = new PublicKey(address);
    const sigs = await conn.getSignaturesForAddress(pubkey, {
      limit: PAGE_SIZE,
      before: cursor ?? undefined,
    });

    // Gap 3: lazy classify the top N rows per page. parallel fetch keeps the latency
    // bounded by one round-trip; per-sig failures are individually swallowed (classifier
    // gets nothing for that row → stays kind: 'unknown'). errors here never abort the
    // walker - if RPC chokes on the deep fetch we still write the signature rows.
    const deepFetch: Array<Promise<{ sig: string; parsed: ParsedTxLite | null }>> = [];
    for (let i = 0; i < Math.min(sigs.length, LAZY_CLASSIFY_HEAD); i++) {
      const s = sigs[i]!;
      deepFetch.push(
        conn
          .getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0 })
          .then((p) => ({ sig: s.signature, parsed: p as unknown as ParsedTxLite | null }))
          .catch(() => ({ sig: s.signature, parsed: null })),
      );
    }
    const deepResults = await Promise.all(deepFetch);
    const classifiedBySig = new Map<
      string,
      { kind: IndexedTx['kind']; memo: string | null }
    >();
    for (const r of deepResults) {
      if (!r.parsed) continue;
      const { kind, memo } = classifySolanaTx(r.parsed);
      classifiedBySig.set(r.sig, { kind, memo });
    }

    const rows: IndexedTx[] = [];
    let newest: string | null = null;
    let oldest: string | null = null;
    for (const sig of sigs) {
      // include failed txs too - "first time recipient" still makes sense in negative
      // (an attempted send that errored still establishes intent toward a counterparty).
      const position = String(sig.slot);
      const ts = sig.blockTime != null ? sig.blockTime * 1000 : null;
      const classified = classifiedBySig.get(sig.signature);
      rows.push({
        key: makeTxKey('solana', vaultId, sig.signature),
        vaultId,
        chain: 'solana',
        digest: sig.signature,
        // Solana base58 addresses are case-sensitive; store raw.
        perspectiveAddress: address,
        counterparty: null, // see header note; phase 3 deep-index can fill this
        position,
        timestampMs: ts,
        symbol: null,
        amountRaw: null,
        source: 'solana-rpc',
        status: 'success',
        // Gap 3: lazy-classified for the top N rows of this page; older rows stay
        // 'unknown' until the user clicks them (TxDetailModal triggers a per-tx fetch).
        kind: classified?.kind ?? 'unknown',
        memo: classified?.memo ?? null,
      });
      if (newest === null || BigInt(position) > BigInt(newest)) newest = position;
      if (oldest === null || BigInt(position) < BigInt(oldest)) oldest = position;
    }

    // pagination cursor for `getSignaturesForAddress` is the signature of the last (oldest)
    // result of the previous page. when fewer than PAGE_SIZE results returned, we've hit
    // the RPC's retention horizon - flip nextCursor to null so the orchestrator finalizes.
    const nextCursor =
      sigs.length === PAGE_SIZE && sigs[sigs.length - 1]
        ? sigs[sigs.length - 1]!.signature
        : null;

    return {
      rows,
      nextCursor,
      newestPosition: newest,
      oldestPosition: oldest,
    };
  },
};
