/**
 * Balances fixture matching the slice that SendPage / ActivityPage / AssetsPage read.
 *
 * Real shape comes from `balances` trpc procedure (background/balances.ts:getTrpcBalanceSummary).
 * Locked / unlocked variants both modeled below.
 */

import { DAVID, TOLY } from './personas';

/** David's vault balances - sui-base, hd, passkey-unlocked */
export const BALANCES_DAVID = {
  locked: false as const,
  vaultId: DAVID.id,
  baseChain: DAVID.baseChain,
  // sui amount in mist (12.5 SUI = 12_500_000_000 mist)
  sui: '12500000000',
  suiUsd: 21.13,
  canonicalReceiveAddress: DAVID.addresses.sui,
  canonicalDwalletId: DAVID.dwalletId,
  evmAddress: DAVID.addresses.evm,
  solanaAddress: DAVID.addresses.solana,
  solanaLamports: '0',
  btcSats: '0',
  // simplified token shape - real Balances has a richer structure but this matches what
  // the assets list reads at runtime (label + balance + usd)
  tokens: [
    { symbol: 'SUI', label: 'Sui', amount: '12.5000', usd: 21.13, chain: 'sui' as const },
    { symbol: 'IKA', label: 'Ika', amount: '892.48', usd: 0.04, chain: 'sui' as const },
    { symbol: 'USDC', label: 'USD Coin', amount: '1500.00', usd: 1500.0, chain: 'sui' as const },
    { symbol: 'WAL', label: 'Walrus', amount: '38.21', usd: 12.94, chain: 'sui' as const },
  ],
};

/** Toly's vault balances - solana-base, hardware (seeker mwa-remote) */
export const BALANCES_TOLY = {
  locked: false as const,
  vaultId: TOLY.id,
  baseChain: TOLY.baseChain,
  sui: '0',
  suiUsd: 0,
  canonicalReceiveAddress: TOLY.addresses.solana,
  canonicalDwalletId: TOLY.dwalletId,
  evmAddress: TOLY.addresses.evm,
  solanaAddress: TOLY.addresses.solana,
  solanaLamports: '152340000000',
  btcSats: '0',
  tokens: [
    { symbol: 'SOL', label: 'Solana', amount: '152.34', usd: 25_643.16, chain: 'solana' as const },
    { symbol: 'IKA', label: 'Ika', amount: '0.89', usd: 0.0001, chain: 'solana' as const },
    { symbol: 'USDC', label: 'USD Coin', amount: '420.00', usd: 420.0, chain: 'solana' as const },
  ],
};

export const BALANCES_DEFAULT = BALANCES_DAVID;
