/**
 * per-chain incoming transaction checker.
 *
 * polls each chain for new inbound txs since the last cursor, fires a chrome
 * notification via `maybeFireNotification` when a new tx arrives, and advances
 * the cursor so each tx only fires once.
 *
 * first-poll semantics: when cursor is null (first ever poll for an address),
 * we record the current chain head as the new cursor WITHOUT firing any
 * notifications. this prevents a flood of historical tx toasts on first unlock.
 *
 * called from the `chromatika-notify-poll` alarm handler in the service worker.
 */

import { getSession } from '@/background/session';
import { getActiveNetworks } from '@/background/network/active-network';
import { getCursorFor, setCursorFor } from './notify-prefs';
import { maybeFireNotification } from './notify-chrome';
import { CHAIN_POLL_INTERVALS } from './types';
import type { CursorEntry } from './types';

function truncateAddr(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function shouldPoll(cursor: CursorEntry | null, chain: string): boolean {
  if (!cursor) return true;
  const interval = CHAIN_POLL_INTERVALS[chain] ?? 60_000;
  return Date.now() - cursor.lastPollAtMs >= interval;
}

async function checkSui(): Promise<void> {
  const s = getSession();
  if (!s?.suiClient || !s.dwalletMeta) return;

  const suiAddr = s.suiKeypair.toSuiAddress();
  const cursorKey = `sui:${suiAddr}`;
  const cursor = await getCursorFor(cursorKey);
  if (!shouldPoll(cursor, 'sui')) return;

  try {
    const result = await s.suiClient.query({
      query: `query($addr: SuiAddress!, $after: String) {
        transactionBlocks(filter: { affectedAddress: $addr }, first: 5, after: $after) {
          nodes { digest sender { address } }
          pageInfo { endCursor }
        }
      }`,
      variables: { addr: suiAddr, after: cursor?.lastCursor ?? null },
    });

    const blocks = (result.data as Record<string, unknown> | null)?.transactionBlocks as {
      nodes: { digest: string; sender: { address: string } }[];
      pageInfo: { endCursor: string | null };
    } | undefined;
    const nodes = blocks?.nodes ?? [];
    const isFirstPoll = cursor === null;

    if (!isFirstPoll) {
      for (const tx of nodes) {
        if (tx.sender.address === suiAddr) continue;
        await maybeFireNotification('incomingTx', {
          id: `chromatika-incoming-sui-${tx.digest}`,
          title: 'Received on Sui',
          message: `From ${truncateAddr(tx.sender.address)}`,
        });
      }
    }

    await setCursorFor(cursorKey, {
      lastCursor: blocks?.pageInfo?.endCursor ?? cursor?.lastCursor ?? null,
      lastPollAtMs: Date.now(),
    });
  } catch {
    // network error, skip this tick
  }
}

async function checkSolana(): Promise<void> {
  const s = getSession();
  if (!s?.dwalletSolanaConnection || !s.solanaFeePayer) return;

  const pubkey = s.solanaFeePayer.publicKey;
  const addr = pubkey.toBase58();
  const cursorKey = `solana:${addr}`;
  const cursor = await getCursorFor(cursorKey);
  if (!shouldPoll(cursor, 'solana')) return;

  try {
    const sigs = await s.dwalletSolanaConnection.getSignaturesForAddress(pubkey, {
      limit: 5,
      ...(cursor?.lastCursor ? { until: cursor.lastCursor } : {}),
    });

    const isFirstPoll = cursor === null;

    if (!isFirstPoll && sigs.length > 0) {
      for (const sig of sigs) {
        await maybeFireNotification('incomingTx', {
          id: `chromatika-incoming-solana-${sig.signature.slice(0, 20)}`,
          title: 'Activity on Solana',
          message: `Transaction ${truncateAddr(sig.signature)}`,
        });
      }
    }

    await setCursorFor(cursorKey, {
      lastCursor: sigs[0]?.signature ?? cursor?.lastCursor ?? null,
      lastPollAtMs: Date.now(),
    });
  } catch {
    // network error, skip
  }
}

async function checkEvm(): Promise<void> {
  const s = getSession();
  if (!s) return;

  const { evmChainId } = await getActiveNetworks();

  // derive evm address from the dWallet (same path as the activity service)
  let evmAddr: string;
  try {
    const { getEvmAddress } = await import('@/background/chains/evm');
    evmAddr = await getEvmAddress();
  } catch {
    // no SECP256K1 dWallet available yet
    return;
  }

  const cursorKey = `evm:${evmChainId}:${evmAddr}`;
  const cursor = await getCursorFor(cursorKey);
  if (!shouldPoll(cursor, 'evm')) return;

  try {
    const { getRpcProviderForChain } = await import('@/background/chains/evm-send');
    const { provider } = await getRpcProviderForChain(evmChainId);
    const latestBlock = await provider.getBlockNumber();
    const lastBlock = cursor?.lastCursor ? parseInt(cursor.lastCursor, 10) : latestBlock;
    const isFirstPoll = cursor === null;

    if (!isFirstPoll && latestBlock > lastBlock) {
      const block = await provider.getBlock(latestBlock, true);
      if (block?.prefetchedTransactions) {
        for (const tx of block.prefetchedTransactions) {
          if (tx.to?.toLowerCase() === evmAddr.toLowerCase()) {
            await maybeFireNotification('incomingTx', {
              id: `chromatika-incoming-evm-${tx.hash.slice(0, 20)}`,
              title: 'Received on EVM',
              message: `From ${truncateAddr(tx.from)}`,
            });
          }
        }
      }
    }

    await setCursorFor(cursorKey, {
      lastCursor: String(latestBlock),
      lastPollAtMs: Date.now(),
    });
  } catch {
    // network error, skip
  }
}

async function checkBtc(): Promise<void> {
  const s = getSession();
  if (!s) return;

  const { btcNetworkId } = await getActiveNetworks();

  const { BUILTIN_BITCOIN } = await import('@/config/networks');
  const net = BUILTIN_BITCOIN.find((n) => n.id === btcNetworkId);
  if (!net) return;

  // derive btc address from the dWallet (same path as the activity service)
  let btcAddr: string;
  try {
    const { getBitcoinAddresses } = await import('@/background/chains/bitcoin');
    const btcNetwork = btcNetworkId === 'btc-mainnet' ? 'mainnet' : 'testnet';
    const { p2wpkh } = await getBitcoinAddresses(btcNetwork as 'mainnet' | 'testnet');
    btcAddr = p2wpkh;
  } catch {
    // no SECP256K1 dWallet available yet
    return;
  }

  const cursorKey = `btc:${btcAddr}`;
  const cursor = await getCursorFor(cursorKey);
  if (!shouldPoll(cursor, 'btc')) return;

  try {
    const url = `${net.esploraUrl}/address/${btcAddr}/txs`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!resp.ok) return;
    const txs = (await resp.json()) as {
      txid: string;
      vin: { prevout?: { scriptpubkey_address?: string } }[];
    }[];

    const isFirstPoll = cursor === null;
    const lastTxid = cursor?.lastCursor;

    if (!isFirstPoll) {
      for (const tx of txs) {
        if (tx.txid === lastTxid) break;
        const isSentByUs = tx.vin.some(
          (v) => v.prevout?.scriptpubkey_address === btcAddr,
        );
        if (!isSentByUs) {
          await maybeFireNotification('incomingTx', {
            id: `chromatika-incoming-btc-${tx.txid.slice(0, 20)}`,
            title: 'Received on Bitcoin',
            message: `Transaction ${truncateAddr(tx.txid)}`,
          });
        }
      }
    }

    await setCursorFor(cursorKey, {
      lastCursor: txs[0]?.txid ?? cursor?.lastCursor ?? null,
      lastPollAtMs: Date.now(),
    });
  } catch {
    // network error, skip
  }
}

export async function checkIncomingTransactions(): Promise<void> {
  await Promise.allSettled([checkSui(), checkSolana(), checkEvm(), checkBtc()]);
}
