/**
 * EVM activity-index worker (Alchemy `alchemy_getAssetTransfers`).
 *
 * Why Alchemy specifically: it's the only general-purpose provider that paginates back
 * to genesis with a single endpoint covering native + ERC-20 + ERC-721 + ERC-1155
 * transfers. RPC-level `eth_getLogs` covers the same ground but requires you to know
 * every token contract address up front, and has a 2k-block range cap per call - not
 * usable for a "give me everything this address ever sent" query.
 *
 * coverage ceiling: `'complete-to-genesis'` when VITE_ALCHEMY_KEY is set. without the
 * key, the worker errors at construction (caller should branch on availability).
 *
 * supported chains: same set as Alchemy's product matrix - ethereum mainnet, arbitrum,
 * optimism, base, polygon. other EVM chains (BSC, avalanche, monad, ink) fall back to
 * a no-op walker that records the unsupported status; caller can still call
 * `firstTimeRecipientCheck` and get the `chromatika-only` tier on those.
 */

import type { IndexWalker } from '@/background/services/activity-index-orchestrator';
import { makeTxKey, type IndexedTx } from '@/background/services/activity-index';
import { classifyEvmTx } from '@/background/services/activity-classifier/evm-classifier';
import { PriceCache } from './price-cache';

/** subdomain table for Alchemy's per-chain API host. only chains we ship in BUILTIN_EVM
 * that Alchemy supports under `alchemy_getAssetTransfers`. */
const ALCHEMY_SUBDOMAIN_FOR_CHAIN: Record<number, string> = {
  1: 'eth-mainnet',
  10: 'opt-mainnet',
  137: 'polygon-mainnet',
  8453: 'base-mainnet',
  42161: 'arb-mainnet',
};

/** transfer "category" set Alchemy supports. we want all of them for a complete view -
 * native (external + internal), plus all ERC standards. */
const ALCHEMY_CATEGORIES = ['external', 'internal', 'erc20', 'erc721', 'erc1155'] as const;

const PAGE_SIZE = 1000; // Alchemy's max per page

type AlchemyTransfer = {
  category: string;
  blockNum: string;
  /** outbound: present on `external` + `internal` categories. */
  from?: string | null;
  /** outbound recipient. */
  to?: string | null;
  /** decoded amount in native or token units (decimal, NOT wei). may be null for NFT transfers. */
  value?: number | null;
  /** chain-side hash, the txid. */
  hash: string;
  /** unix metadata timestamp from Alchemy's enriched response. */
  metadata?: { blockTimestamp?: string | null } | null;
  /** ERC-20 token symbol when category=erc20; null for natives. */
  asset?: string | null;
  /** decimals when category=erc20. */
  rawContract?: { decimal?: string | null } | null;
};

type AlchemyResp = {
  jsonrpc?: string;
  id?: number;
  result?: {
    transfers?: AlchemyTransfer[];
    pageKey?: string;
  };
  error?: { code?: number; message?: string };
};

/** turn a metadata.blockTimestamp ISO-8601 into ms; null on parse failure. */
function parseAlchemyTimestamp(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/** parse a hex block number (`"0x1234abc"`) into a bigint as string. always returns a
 * non-null string; falls back to "0" on a malformed input. */
function blockNumPosition(raw: string | null | undefined): string {
  if (!raw) return '0';
  try {
    return BigInt(raw).toString();
  } catch {
    return '0';
  }
}

/** convert Alchemy's decimal `value` + token decimals into base units (wei / token base). */
function toAmountRaw(transfer: AlchemyTransfer): string | null {
  if (transfer.value == null || !Number.isFinite(transfer.value)) return null;
  // native txs (external / internal): decimals = 18.
  let decimals = 18;
  if (transfer.category === 'erc20' && transfer.rawContract?.decimal != null) {
    const d = parseInt(transfer.rawContract.decimal, 16);
    if (Number.isFinite(d) && d >= 0) decimals = d;
  }
  if (transfer.category === 'erc721' || transfer.category === 'erc1155') {
    // count of NFTs, not divisible. value is the count, not base units.
    return Math.trunc(transfer.value).toString();
  }
  // Alchemy gives `value` as a decimal token amount; multiply by 10^decimals carefully.
  // we lose some precision past Number.MAX_SAFE_INTEGER but for storage-only this is fine.
  const baseUnits = BigInt(Math.trunc(transfer.value * 10 ** Math.min(decimals, 18)));
  return baseUnits.toString();
}

/** Alchemy URL builder for a chain + key. */
function alchemyUrlFor(chainId: number): string | null {
  const subdomain = ALCHEMY_SUBDOMAIN_FOR_CHAIN[chainId];
  if (!subdomain) return null;
  const key = (import.meta.env.VITE_ALCHEMY_KEY ?? '').trim();
  if (!key) return null;
  return `https://${subdomain}.g.alchemy.com/v2/${encodeURIComponent(key)}`;
}

/** factory: build a per-chain walker. callers pass the chainId so the same worker file
 * can serve multiple EVM chains without duplicate boilerplate. */
export function makeEvmActivityIndexWalker(chainId: number): IndexWalker {
  return {
    chain: 'evm',
    source: `alchemy:eth-${chainId}`,
    coverageCeiling: 'complete-to-genesis',

    async fetchPage({ vaultId, address, cursor }) {
      const url = alchemyUrlFor(chainId);
      if (!url) {
        throw new Error(
          `Alchemy support not configured for chain ${chainId}. ` +
            `Either VITE_ALCHEMY_KEY is missing or this chain isn't in the Alchemy product matrix.`,
        );
      }
      const params = {
        fromAddress: address,
        category: ALCHEMY_CATEGORIES,
        maxCount: `0x${PAGE_SIZE.toString(16)}`,
        excludeZeroValue: false,
        withMetadata: true,
        order: 'desc' as const,
        ...(cursor ? { pageKey: cursor } : {}),
      };
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'alchemy_getAssetTransfers',
          params: [params],
        }),
        signal: AbortSignal.timeout(25_000),
      });
      if (!res.ok) {
        throw new Error(`Alchemy HTTP ${res.status}`);
      }
      const body = (await res.json()) as AlchemyResp;
      if (body.error) {
        throw new Error(`Alchemy: ${body.error.message ?? 'unknown error'}`);
      }
      const transfers = body.result?.transfers ?? [];
      const pageKey = body.result?.pageKey ?? null;

      const rows: IndexedTx[] = [];
      let newest: string | null = null;
      let oldest: string | null = null;
      const priceCache = new PriceCache();
      // dedupe by tx hash; one tx can appear under multiple categories (e.g. an external
      // call that also moved ERC-20 tokens). keep the first row we see (the
      // category-ordering is external first which gives us native value when relevant).
      const seen = new Set<string>();
      for (const t of transfers) {
        if (!t.hash || seen.has(t.hash)) continue;
        seen.add(t.hash);
        const position = blockNumPosition(t.blockNum);
        const ts = parseAlchemyTimestamp(t.metadata?.blockTimestamp);
        const counterparty = (t.to ?? '').toLowerCase() || null;
        const base: IndexedTx = {
          key: makeTxKey('evm', vaultId, t.hash),
          vaultId,
          chain: 'evm',
          digest: t.hash,
          perspectiveAddress: address.toLowerCase(),
          counterparty,
          position,
          timestampMs: ts,
          symbol: t.asset ?? null,
          amountRaw: toAmountRaw(t),
          source: `alchemy:eth-${chainId}`,
          status: 'success', // historical rows from Alchemy are by definition mined
        };
        // Bucket B: classifier upgrades `kind` (and optionally `swapMeta`). Alchemy's
        // category field is the authoritative NFT signal - pass it as a hint so the
        // classifier doesn't have to guess from amount/symbol heuristics.
        const classified = classifyEvmTx(base, { alchemyCategory: t.category });
        // Bucket D fix: stamp USD value at sync time. for ERC-20 use the row's decimals;
        // for native EVM, default to 18. NFT rows skip USD (amount is a token count).
        let priceUsdAtSync: number | null = null;
        if (classified.kind !== 'transferNFT' && base.amountRaw && base.symbol) {
          const decimals =
            t.category === 'erc20' && t.rawContract?.decimal != null
              ? parseInt(t.rawContract.decimal, 16)
              : 18;
          priceUsdAtSync = await priceCache.usdValueFor(base.symbol, base.amountRaw, decimals);
        }
        rows.push({
          ...base,
          kind: classified.kind,
          swapMeta: classified.swapMeta,
          priceUsdAtSync,
        });
        if (newest === null || BigInt(position) > BigInt(newest)) newest = position;
        if (oldest === null || BigInt(position) < BigInt(oldest)) oldest = position;
      }

      return {
        rows,
        nextCursor: pageKey ?? null,
        newestPosition: newest,
        oldestPosition: oldest,
      };
    },
  };
}

/** chains Alchemy covers. used by the dropdown to enable / disable the option. */
export function evmChainSupportsActivityIndex(chainId: number): boolean {
  if (!(import.meta.env.VITE_ALCHEMY_KEY ?? '').trim()) return false;
  return chainId in ALCHEMY_SUBDOMAIN_FOR_CHAIN;
}
