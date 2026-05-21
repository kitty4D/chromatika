/**
 * registry: pick the right worker for `(chain, chainId)`. EVM is special - we need to
 * route to the correct per-chainId Alchemy URL; everything else is one walker per chain.
 *
 * returns `null` when no walker is available (e.g. EVM without VITE_ALCHEMY_KEY, or
 * Aptos which we haven't implemented yet). callers should treat null as "indexing not
 * supported for this address on this build" - the first-time-recipient verdict stays at
 * the `chromatika-only` tier and the UI shows a disabled state.
 */

import type { IndexWalker } from '@/background/services/activity-index-orchestrator';
import { btcActivityIndexWalker } from './btc-walker';
import { evmChainSupportsActivityIndex, makeEvmActivityIndexWalker } from './evm-walker';
import { solanaActivityIndexWalker } from './solana-walker';
import { suiActivityIndexWalker } from './sui-walker';
import type { ActivityIndexChain } from '@/background/services/activity-index';

export type WalkerRouteKey = {
  chain: ActivityIndexChain;
  /** required for EVM, ignored otherwise. */
  chainId?: number;
};

export function resolveWalker(key: WalkerRouteKey): IndexWalker | null {
  switch (key.chain) {
    case 'sui':
      return suiActivityIndexWalker;
    case 'solana':
      return solanaActivityIndexWalker;
    case 'btc':
      return btcActivityIndexWalker;
    case 'evm': {
      if (key.chainId == null || !evmChainSupportsActivityIndex(key.chainId)) return null;
      return makeEvmActivityIndexWalker(key.chainId);
    }
    case 'aptos':
      return null; // not implemented; matches Aptos send being stubbed
  }
}

/** boolean variant for the UI - "should the Start button be enabled?". */
export function isIndexingSupported(key: WalkerRouteKey): boolean {
  return resolveWalker(key) !== null;
}
