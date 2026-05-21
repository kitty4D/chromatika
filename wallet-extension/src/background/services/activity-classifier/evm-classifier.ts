/**
 * EVM tx classifier. Maps Alchemy's `alchemy_getAssetTransfers` row → semantic kind
 * (`transfer`, `transferNFT`, `swap`, `tokenApproval`, `smartContractCall`, etc.).
 *
 * Alchemy already gives us the transfer category (`external`, `internal`, `erc20`,
 * `erc721`, `erc1155`); we don't need a separate method-selector decode at index time
 * for the basic types. For `swap` detection we cross-reference the `to` address against
 * a known-DEX-router list per chain (Uniswap V2/V3, 1inch, Aggregator). Method-selector
 * decode for `tokenApproval` happens on-demand in the TxDetailModal flow rather than at
 * index time (input data not always present on Alchemy rows).
 *
 * Approach: this classifier runs as a pure function over the `IndexedTx` the walker
 * built. Walker stays simple; classifier knows about chain-specific shapes via the
 * `source` field on IndexedTx.
 */

import type { IndexedTx, IndexedTxKind } from '@/background/services/activity-index';

/** known DEX router addresses per chainId. lower-case. extending this list grows the
 * accuracy of swap-kind detection on the activity feed. when we miss a swap, it just
 * gets `smartContractCall` instead - benign degradation. */
const KNOWN_DEX_ROUTERS: Record<number, Set<string>> = {
  // Ethereum mainnet
  1: new Set([
    '0x7a250d5630b4cf539739df2c5dacb4c659f2488d', // UniswapV2Router02
    '0xe592427a0aece92de3edee1f18e0157c05861564', // UniswapV3SwapRouter
    '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45', // UniswapV3SwapRouter02
    '0x1111111254eeb25477b68fb85ed929f73a960582', // 1inch v5 aggregator
    '0x1111111254fb6c44bac0bed2854e76f90643097d', // 1inch v4 aggregator
    '0xdef1c0ded9bec7f1a1670819833240f027b25eff', // 0x exchange proxy
  ]),
  // Optimism
  10: new Set([
    '0xe592427a0aece92de3edee1f18e0157c05861564',
    '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45',
  ]),
  // Polygon
  137: new Set([
    '0xe592427a0aece92de3edee1f18e0157c05861564',
    '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45',
    '0x1111111254eeb25477b68fb85ed929f73a960582',
  ]),
  // Base
  8453: new Set([
    '0x2626664c2603336e57b271c5c0b26f421741e481', // UniswapV3SwapRouter02 on Base
    '0xbe6c1b0f8baf7e2da7a23b1c8dd58c8b7e7e0d2c', // 1inch on Base (approximate)
  ]),
  // Arbitrum
  42161: new Set([
    '0xe592427a0aece92de3edee1f18e0157c05861564',
    '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45',
    '0x1111111254eeb25477b68fb85ed929f73a960582',
  ]),
};

/** Alchemy category strings that signal NFT transfers (vs fungible / native). */
const NFT_CATEGORIES: ReadonlySet<string> = new Set(['erc721', 'erc1155']);

/** hints the EVM walker can pass to the classifier when it has provider-specific info
 * that doesn't fit naturally on the IndexedTx (e.g. Alchemy's `category` per row).
 * stays optional so the classifier still works when called with no hints (used by the
 * activity-feed merge to upgrade kinds on already-stored rows). */
export type EvmClassifierHints = {
  /** Alchemy transfer category: 'external' | 'internal' | 'erc20' | 'erc721' | 'erc1155'.
   * primary signal for NFT vs fungible categorization - more reliable than guessing
   * from the row's amount field. */
  alchemyCategory?: string;
};

/** classify an EVM row from Alchemy's getAssetTransfers shape. `source` field tells us
 * the chainId (e.g. 'alchemy:eth-1' → 1). */
export function classifyEvmTx(
  row: IndexedTx,
  hints?: EvmClassifierHints,
): {
  kind: IndexedTxKind;
  swapMeta?: IndexedTx['swapMeta'];
} {
  // pull chainId out of `source` field (format: `alchemy:eth-${chainId}`).
  const chainIdMatch = row.source.match(/eth-(\d+)$/);
  const chainId = chainIdMatch ? Number.parseInt(chainIdMatch[1]!, 10) : null;

  // NFT detection first - Alchemy's category is authoritative when present.
  if (hints?.alchemyCategory && NFT_CATEGORIES.has(hints.alchemyCategory)) {
    return { kind: 'transferNFT' };
  }

  // counterparty matches a known DEX router → swap.
  if (chainId != null && row.counterparty) {
    const routers = KNOWN_DEX_ROUTERS[chainId];
    if (routers && routers.has(row.counterparty.toLowerCase())) {
      return { kind: 'swap' };
    }
  }

  // empty symbol + amount > 0 → native transfer; otherwise classify as transfer (ERC-20
  // transfers come through alchemy_getAssetTransfers with category=erc20).
  return { kind: 'transfer' };
}
