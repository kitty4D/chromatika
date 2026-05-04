/**
 * activity feed: merged recent history for Sui, EVM (explorer when available), Solana, and Bitcoin.
 * Sui rides the vault's `SuiGraphQLClient` via `queryTransactionBlocksGraphQL` (hand-rolled
 * `transactionBlocks` doc), since `@mysten/sui` 2.13.2's `client.core.*` still only has
 * `getTransaction(digest)`: no filtered list wrapper yet. swap for a core helper when it lands.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { parsedTransactionTouchesEncrypt } from '@/background/encrypt/encrypt-solana-program-detect';
import {
  getDwalletNetworkSettings,
  resolveSolanaRpcUrl,
} from '@/background/network/tier-network-settings';
import { getSession } from '@/background/session';
import { resolveCanonicalSuiReceiveAddress } from '@/background/identity';
import { getEvmAddress } from '@/background/chains/evm';
import { getSolanaAddress } from '@/background/chains/solana';
import { getBitcoinAddresses, type BtcNetwork } from '@/background/chains/bitcoin';
import { BUILTIN_BITCOIN, findEvmNetwork } from '@/config/networks';
import { getCustomNetworks } from '@/background/network/custom-networks';
import {
  createSuiGraphQLClientFromRegistryNetworkId,
  queryTransactionBlocksGraphQL,
} from '@/background/sui-client';
import { getSignedTxsMap } from '@/background/services/tx-record';

export type ActivityItemType = 'sent' | 'received' | 'contract' | 'unknown';
export type ActivityItemStatus = 'success' | 'failure';
export type ActivityChain = 'sui' | 'evm' | 'solana' | 'bitcoin';

export type ActivityItem = {
  /** stable id for list keys (digest / tx hash / signature / txid) */
  digest: string;
  timestampMs: number | null;
  type: ActivityItemType;
  status: ActivityItemStatus;
  chain: ActivityChain;
  fromAddress: string | null;
  label: string;
  /**
   * dapp origin URL captured at sign time. populated by the local tx-record store merge for txs
   * chromatika signed itself (whether dapp-initiated or wallet-ui-initiated). `null` means we
   * recorded the tx but no dapp was involved (wallet-ui send). `undefined` means we have no local
   * record: the tx came in purely via explorer fetch (e.g. an external transfer to this address,
   * or a tx older than the local record's first-write time).
   */
  origin?: string | null;
  /**
   * whether an encrypted activity note is attached. driven by the tx-record overlay; UI uses this
   * to render a lock icon next to the row. decrypting the note requires a vault unlock + dWallet
   * ed25519 ReadCiphertext sig: that round-trip happens only when the user clicks to reveal.
   */
  hasEncryptedNote?: boolean;
  /**
   * true when chromatika has a local signed-tx record for this row (i.e. we signed the tx,
   * whether dapp-initiated or wallet-ui-initiated). UI uses this to scope the "+ note" button
   * to txs we can actually encrypt notes for (the encrypt-xyz envelope is keyed to the active
   * vault's dWallet, so only chromatika-signed txs get the affordance).
   */
  signedByThisWallet?: boolean;
  /**
   * tx-record `kind` discriminator (e.g. 'pc-wrap', 'pc-transfer-hidden'). surfaced from the
   * local tx-record store overlay; lets the UI render specific badges for hidden pcToken sends
   * vs regular sends. `undefined` for explorer-only rows.
   */
  recordKind?: string;
};

function txLabel(kind: string | null, type: ActivityItemType): string {
  // sui GraphQL reports `ProgrammableTransactionBlock`; legacy JSON-RPC used `ProgrammableTransaction`.
  // accept both so the label is stable across transports if mysten ever ships a core wrapper.
  if (kind === 'ProgrammableTransactionBlock' || kind === 'ProgrammableTransaction') {
    return type === 'sent' ? 'contract call' : 'received (contract)';
  }
  return type === 'sent' ? 'sent' : 'received';
}

export async function getSuiActivity(address: string, limit = 20): Promise<ActivityItem[]> {
  const s = getSession();
  if (!s) throw new Error('Wallet locked');

  const dw = await getDwalletNetworkSettings(s.activeVaultId, {
    network: s.network,
    baseChain: s.activeVaultBaseChain,
  });
  const client = createSuiGraphQLClientFromRegistryNetworkId(dw.suiNetworkId);
  const rows = await queryTransactionBlocksGraphQL(client, {
    filter: { affectedAddress: address },
    limit,
    includeEvents: false,
  });

  const items: ActivityItem[] = [];
  for (const row of rows) {
    const type: ActivityItemType = row.sender
      ? row.sender.toLowerCase() === address.toLowerCase()
        ? 'sent'
        : 'received'
      : 'unknown';

    items.push({
      digest: row.digest,
      timestampMs: row.timestampMs,
      type,
      status: row.status,
      chain: 'sui',
      fromAddress: row.sender,
      label: txLabel(row.kind, type),
    });
  }

  return items;
}

const SOLANA_ACTIVITY_ENCRYPT_PARSE_CAP = 12;

async function enrichSolanaActivityEncryptLabels(
  conn: Connection,
  items: ActivityItem[],
): Promise<ActivityItem[]> {
  if (items.length === 0) return items;
  const head = items.slice(0, SOLANA_ACTIVITY_ENCRYPT_PARSE_CAP);
  const tail = items.slice(SOLANA_ACTIVITY_ENCRYPT_PARSE_CAP);
  const headLabeled = await Promise.all(
    head.map(async (row) => {
      try {
        const parsed = await conn.getParsedTransaction(row.digest, {
          maxSupportedTransactionVersion: 0,
        });
        if (parsed && parsedTransactionTouchesEncrypt(parsed)) {
          return { ...row, label: 'solana · encrypt' };
        }
      } catch {
        /* rpc or parse failures stay generic label */
      }
      return row;
    }),
  );
  return [...headLabeled, ...tail];
}

async function getSolanaActivity(address: string, limit: number): Promise<ActivityItem[]> {
  const s = getSession();
  if (!s) throw new Error('Wallet locked');
  const dw = await getDwalletNetworkSettings(s.activeVaultId, {
    network: s.network,
    baseChain: s.activeVaultBaseChain,
  });
  const rpcUrl = resolveSolanaRpcUrl(dw.solana);
  const conn = new Connection(rpcUrl, dw.solana.commitment);
  const sigs = await conn.getSignaturesForAddress(new PublicKey(address), { limit });
  const out: ActivityItem[] = [];
  for (const sig of sigs) {
    const st = sig.err === null ? 'success' : 'failure';
    const ms = sig.blockTime != null ? sig.blockTime * 1000 : null;
    out.push({
      digest: sig.signature,
      timestampMs: ms,
      type: 'unknown',
      status: st,
      chain: 'solana',
      fromAddress: null,
      label: 'solana tx',
    });
  }
  if (s.activeVaultBaseChain !== 'solana') return out;
  return enrichSolanaActivityEncryptLabels(conn, out);
}

type EsploraTx = {
  txid: string;
  status?: { block_time?: number; confirmed?: boolean };
};

async function getBtcActivity(address: string, esploraBase: string, limit: number): Promise<ActivityItem[]> {
  const url = `${esploraBase.replace(/\/$/, '')}/address/${encodeURIComponent(address)}/txs`;
  const r = await fetch(url, { signal: AbortSignal.timeout(25_000) });
  if (!r.ok) return [];
  const txs = (await r.json()) as EsploraTx[];
  const out: ActivityItem[] = [];
  for (const tx of txs.slice(0, limit)) {
    const t = tx.status?.block_time;
    const ms = t != null ? t * 1000 : null;
    const ok = tx.status?.confirmed !== false;
    out.push({
      digest: tx.txid,
      timestampMs: ms,
      type: 'unknown',
      status: ok ? 'success' : 'success',
      chain: 'bitcoin',
      fromAddress: null,
      label: 'bitcoin tx',
    });
  }
  return out;
}

function btcIdToLegacy(id: string): BtcNetwork {
  if (id === 'btc-mainnet') return 'mainnet';
  return 'testnet';
}

type BlockscoutV2Tx = {
  tx_hash?: string;
  timestamp?: string;
  status?: string;
  from?: { hash?: string };
};

async function getEvmActivityBlockscout(address: string, explorerBase: string, limit: number): Promise<ActivityItem[]> {
  const base = explorerBase.replace(/\/$/, '');
  const url = `${base}/api/v2/addresses/${address}/transactions`;
  const r = await fetch(url, { signal: AbortSignal.timeout(25_000) });
  if (!r.ok) return [];
  const j = (await r.json()) as { items?: BlockscoutV2Tx[] };
  const items = j.items ?? [];
  const out: ActivityItem[] = [];
  for (const tx of items.slice(0, limit)) {
    const hash = tx.tx_hash;
    if (!hash) continue;
    const ms = tx.timestamp ? Date.parse(tx.timestamp) : null;
    const st = tx.status === 'ok' || tx.status === 'success' ? 'success' : 'failure';
    const from = tx.from?.hash ?? null;
    const type: ActivityItemType =
      from && from.toLowerCase() === address.toLowerCase() ? 'sent' : 'received';
    out.push({
      digest: hash,
      timestampMs: Number.isFinite(ms as number) ? (ms as number) : null,
      type,
      status: st,
      chain: 'evm',
      fromAddress: from,
      label: 'evm tx',
    });
  }
  return out;
}

async function getEvmActivityForActiveChain(address: string, limit: number): Promise<ActivityItem[]> {
  const s = getSession();
  if (!s) throw new Error('Wallet locked');
  const dw = await getDwalletNetworkSettings(s.activeVaultId, {
    network: s.network,
    baseChain: s.activeVaultBaseChain,
  });
  const { evmChainId } = dw;
  const { evm: customEvm } = await getCustomNetworks();
  const net =
    findEvmNetwork(evmChainId, customEvm);
  if (!net?.explorerUrl) return [];

  const explorer = net.explorerUrl.toLowerCase();
  if (explorer.includes('blockscout.com') || explorer.includes('blockscout.org')) {
    const origin = net.explorerUrl.split('/').slice(0, 3).join('/');
    return getEvmActivityBlockscout(address, origin, limit);
  }
  return [];
}

/**
 * merge recent activity across Sui, EVM (when explorer supports it), Solana, and Bitcoin.
 */
export async function getMultiChainActivity(limitPerChain = 12): Promise<ActivityItem[]> {
  const s = getSession();
  if (!s) throw new Error('Wallet locked');

  const { address: suiAddr } = await resolveCanonicalSuiReceiveAddress(s);
  const dw = await getDwalletNetworkSettings(s.activeVaultId, {
    network: s.network,
    baseChain: s.activeVaultBaseChain,
  });
  const btcNet = BUILTIN_BITCOIN.find((n) => n.id === dw.btcNetworkId);
  const esploraBase = btcNet?.esploraUrl ?? 'https://blockstream.info/api';

  const [sui, evm, sol, btc] = await Promise.all([
    getSuiActivity(suiAddr, limitPerChain).catch(() => [] as ActivityItem[]),
    (async () => {
      try {
        const evmAddr = await getEvmAddress();
        return await getEvmActivityForActiveChain(evmAddr, limitPerChain);
      } catch {
        return [] as ActivityItem[];
      }
    })(),
    (async () => {
      try {
        const solAddr = await getSolanaAddress();
        return await getSolanaActivity(solAddr, limitPerChain);
      } catch {
        return [] as ActivityItem[];
      }
    })(),
    (async () => {
      try {
        const { p2wpkh } = await getBitcoinAddresses(btcIdToLegacy(dw.btcNetworkId));
        return await getBtcActivity(p2wpkh, esploraBase, limitPerChain);
      } catch {
        return [] as ActivityItem[];
      }
    })(),
  ]);

  const merged = [...sui, ...evm, ...sol, ...btc];

  // overlay locally-recorded signed-tx data (origin URL + encrypted-note presence). the
  // tx-record store is keyed per vault and shared across chains, so we can merge once after the
  // explorer fetches by joining on `digest === txHash`. records that don't match an explorer
  // row are dropped here: they'll surface elsewhere (drain analysis, panic forensics) rather
  // than padding the activity feed with unbroadcast or pre-confirmation entries.
  const recordsMap = await getSignedTxsMap(s.activeVaultId).catch((e) => {
    console.warn('[chromatika activity] tx-record overlay failed', e);
    return new Map<string, never>();
  });
  for (const item of merged) {
    const rec = recordsMap.get(item.digest);
    if (!rec) continue;
    item.origin = rec.origin;
    item.signedByThisWallet = true;
    item.recordKind = rec.kind;
    if (rec.encryptedNote) {
      item.hasEncryptedNote = true;
    }
  }

  merged.sort((a, b) => {
    const ta = a.timestampMs ?? 0;
    const tb = b.timestampMs ?? 0;
    return tb - ta;
  });
  return merged.slice(0, Math.max(limitPerChain * 2, 30));
}
