import { describe, it, expect } from 'vitest';
import {
  WC_SOLANA_CHAIN_ID_DEVNET,
  WC_SOLANA_CHAIN_ID_MAINNET,
  wcSolanaChainIdForCluster,
} from './wc';

describe('wcSolanaChainIdForCluster', () => {
  it('returns the devnet CAIP-2 for sol-devnet', () => {
    expect(wcSolanaChainIdForCluster('sol-devnet')).toBe(WC_SOLANA_CHAIN_ID_DEVNET);
  });

  it('returns the mainnet CAIP-2 for sol-mainnet', () => {
    expect(wcSolanaChainIdForCluster('sol-mainnet')).toBe(WC_SOLANA_CHAIN_ID_MAINNET);
  });

  // anything we don't explicitly recognize defaults to mainnet because:
  //   1. Phantom-class wallets pin user's authorized account to mainnet regardless;
  //   2. off-chain `solana_signMessage` signs (no blockhash, no simulation) work on any
  //      cluster, so defaulting to mainnet matches the most common case.
  it('defaults to mainnet for null', () => {
    expect(wcSolanaChainIdForCluster(null)).toBe(WC_SOLANA_CHAIN_ID_MAINNET);
  });

  it('defaults to mainnet for undefined', () => {
    expect(wcSolanaChainIdForCluster(undefined)).toBe(WC_SOLANA_CHAIN_ID_MAINNET);
  });

  it('defaults to mainnet for unknown registry ids', () => {
    expect(wcSolanaChainIdForCluster('sol-testnet')).toBe(WC_SOLANA_CHAIN_ID_MAINNET);
    expect(wcSolanaChainIdForCluster('sol-localnet')).toBe(WC_SOLANA_CHAIN_ID_MAINNET);
    expect(wcSolanaChainIdForCluster('')).toBe(WC_SOLANA_CHAIN_ID_MAINNET);
  });
});
