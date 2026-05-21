/**
 * BTC activity-index worker. Walks the active Esplora's
 * `/address/:addr/txs/chain[/:lastSeenTxid]` pagination. Each page returns up to 25
 * confirmed txs (Esplora's hardcoded limit) ordered newest-first; the cursor for the
 * next page is the txid of the last item we received.
 *
 * coverage ceiling: `'complete-to-genesis'` against `blockstream.info` (the default
 * Esplora). Some self-hosted Esploras may impose retention; we don't try to detect
 * that here. If a user is on a private Esplora that truncates, the walker will think
 * it's "complete-to-genesis" when really it's not - acceptable trade-off for now since
 * chromatika ships only blockstream.info presets in BUILTIN_BITCOIN.
 *
 * counterparty extraction: BTC outputs go to multiple addresses (change + recipient[s]
 * + sometimes OP_RETURN). For "did I send to X?" we pick the OUTPUT address with the
 * largest value that isn't the input owner (the sender's own change output). Works for
 * vanilla 2-output P2WPKH sends; multi-recipient batched payments would store the
 * largest single recipient.
 */

import { getDwalletNetworkSettings } from '@/background/network/tier-network-settings';
import { getSession } from '@/background/session';
import { BUILTIN_BITCOIN } from '@/config/networks';
import type { IndexWalker } from '@/background/services/activity-index-orchestrator';
import { makeTxKey, type IndexedTx } from '@/background/services/activity-index';
import { PriceCache } from './price-cache';

type EsploraVin = {
  prevout?: {
    scriptpubkey_address?: string | null;
    value?: number | null;
  } | null;
};

type EsploraVout = {
  scriptpubkey_address?: string | null;
  value?: number | null;
};

type EsploraTx = {
  txid: string;
  status?: {
    confirmed?: boolean;
    block_height?: number;
    block_time?: number;
  };
  vin?: EsploraVin[];
  vout?: EsploraVout[];
};

/** is `address` listed as one of the input owners? if yes, this tx is "outbound" for our
 * purposes (we spent a UTXO we owned). */
function isOutbound(address: string, tx: EsploraTx): boolean {
  for (const v of tx.vin ?? []) {
    if (v.prevout?.scriptpubkey_address === address) return true;
  }
  return false;
}

/** pick the recipient: largest-value output address that isn't `address` (the sender's
 * change output). returns null if all outputs go back to the sender. */
function pickRecipient(address: string, tx: EsploraTx): { recipient: string | null; sats: bigint | null } {
  let bestAddr: string | null = null;
  let bestSats = 0n;
  for (const out of tx.vout ?? []) {
    const a = out.scriptpubkey_address;
    if (!a || a === address) continue;
    const v = out.value;
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) continue;
    const sats = BigInt(Math.trunc(v));
    if (sats > bestSats) {
      bestSats = sats;
      bestAddr = a;
    }
  }
  return { recipient: bestAddr, sats: bestAddr ? bestSats : null };
}

export const btcActivityIndexWalker: IndexWalker = {
  chain: 'btc',
  source: 'esplora',
  coverageCeiling: 'complete-to-genesis',

  async fetchPage({ vaultId, address, cursor }) {
    const s = getSession();
    if (!s) throw new Error('Wallet locked');
    const dw = await getDwalletNetworkSettings(s.activeVaultId, {
      network: s.network,
      baseChain: s.activeVaultBaseChain,
    });
    const btcNet = BUILTIN_BITCOIN.find((n) => n.id === dw.btcNetworkId) ?? BUILTIN_BITCOIN[0];
    const esploraBase = btcNet!.esploraUrl.replace(/\/$/, '');

    // Esplora pagination shape: /address/:addr/txs/chain         -> newest confirmed page
    //                          /address/:addr/txs/chain/:txid    -> next page after :txid
    const path = cursor
      ? `/address/${encodeURIComponent(address)}/txs/chain/${encodeURIComponent(cursor)}`
      : `/address/${encodeURIComponent(address)}/txs/chain`;
    const r = await fetch(`${esploraBase}${path}`, {
      signal: AbortSignal.timeout(25_000),
    });
    if (!r.ok) {
      throw new Error(`Esplora HTTP ${r.status}`);
    }
    const txs = (await r.json()) as EsploraTx[];

    const rows: IndexedTx[] = [];
    let newest: string | null = null;
    let oldest: string | null = null;
    const priceCache = new PriceCache();
    for (const tx of txs) {
      if (!tx.txid) continue;
      // skip txs where our address isn't a spender (received-only txs aren't outbound).
      if (!isOutbound(address, tx)) continue;
      const blockHeight = tx.status?.block_height;
      if (blockHeight == null) continue; // unconfirmed / pending - skip from history index
      const position = String(blockHeight);
      const ts = tx.status?.block_time != null ? tx.status.block_time * 1000 : null;
      const { recipient, sats } = pickRecipient(address, tx);

      const priceUsdAtSync = sats != null
        ? await priceCache.usdValueFor('BTC', sats.toString(), 8)
        : null;
      rows.push({
        key: makeTxKey('btc', vaultId, tx.txid),
        vaultId,
        chain: 'btc',
        digest: tx.txid,
        // BTC addresses are case-sensitive (bech32 normalizes case internally; the spec
        // says addresses are mixed-case but produced as lowercase). store raw.
        perspectiveAddress: address,
        counterparty: recipient,
        position,
        timestampMs: ts,
        symbol: 'BTC',
        amountRaw: sats != null ? sats.toString() : null,
        source: 'esplora',
        status: 'success',
        kind: 'transfer', // BTC is always a transfer for our purposes (no swaps / stakes natively)
        priceUsdAtSync,
      });
      if (newest === null || BigInt(position) > BigInt(newest)) newest = position;
      if (oldest === null || BigInt(position) < BigInt(oldest)) oldest = position;
    }

    // Esplora pages are 25 items each. fewer items = we've reached the end of confirmed
    // history for this address. cursor = txid of the LAST (oldest) tx in this page.
    const nextCursor =
      txs.length === 25 && txs[txs.length - 1] ? txs[txs.length - 1]!.txid : null;

    return {
      rows,
      nextCursor,
      newestPosition: newest,
      oldestPosition: oldest,
    };
  },
};
