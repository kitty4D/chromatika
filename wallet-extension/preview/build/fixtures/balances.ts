/**
 * Balances fixture matching the slice that SendPage / ActivityPage / AssetsPage read.
 *
 * Real shape comes from `balances` trpc procedure (background/balances.ts:getTrpcBalanceSummary).
 * Locked / unlocked variants both modeled below.
 */

import { DAVID, TOLY } from './personas';

/** David's vault balances - sui-base, hd, passkey-unlocked.
 *  fueled up: SUI + IKA both above the green-gauge threshold (>= 1 of each in their
 *  9-decimal base units), and funding.ready = true so VaultBaseCard does not show
 *  the "wallet must be funded with SUI and IKA" pill. */
export const BALANCES_DAVID = {
  locked: false as const,
  ikaBase: 'sui' as const,
  network: 'mainnet',
  vaultId: DAVID.id,
  baseChain: DAVID.baseChain,
  feePayerAddress: DAVID.addresses.sui,
  canonicalReceiveAddress: DAVID.addresses.sui,
  canonicalSource: 'dwallet_ed25519_active' as const,
  canonicalDwalletId: DAVID.dwalletId,
  address: DAVID.addresses.sui,
  // sui amount in mist (12.5 SUI = 12_500_000_000 mist) - well above the green gauge floor (>= 1 SUI)
  sui: '12500000000',
  suiUsd: 21.13,
  // ika in base units (9 decimals, same shape as SUI) - 892.48 IKA = 892_480_000_000 base
  ika: '892480000000',
  evmAddress: DAVID.addresses.evm,
  solanaAddress: DAVID.addresses.solana,
  solanaLamports: '0',
  btcSats: '0',
  funding: { ready: true as const, missing: [] as readonly string[] },
  // simplified token shape - real Balances has a richer structure but this matches what
  // the assets list reads at runtime (label + balance + usd)
  tokens: [
    { symbol: 'SUI', label: 'Sui', amount: '12.5000', usd: 21.13, chain: 'sui' as const },
    { symbol: 'IKA', label: 'Ika', amount: '892.48', usd: 0.04, chain: 'sui' as const },
    { symbol: 'USDC', label: 'USD Coin', amount: '1500.00', usd: 1500.0, chain: 'sui' as const },
    { symbol: 'WAL', label: 'Walrus', amount: '38.21', usd: 12.94, chain: 'sui' as const },
  ],
};

/** Toly's vault balances - solana-base, hardware (seeker mwa-remote).
 *  Solana base is pre-alpha so the IKA gauge stays yellow regardless of balance and
 *  the SUI/IKA funding pill is suppressed by the isSolanaPreAlpha branch in
 *  VaultBaseCard. funding.ready stays true to keep AssetsPage / other surfaces clean. */
export const BALANCES_TOLY = {
  locked: false as const,
  ikaBase: 'solana' as const,
  network: 'devnet',
  vaultId: TOLY.id,
  baseChain: TOLY.baseChain,
  feePayerAddress: TOLY.addresses.solana,
  canonicalReceiveAddress: TOLY.addresses.solana,
  canonicalSource: 'dwallet_ed25519_active' as const,
  canonicalDwalletId: TOLY.dwalletId,
  address: TOLY.addresses.solana,
  sui: '0',
  suiUsd: 0,
  ika: '0',
  evmAddress: TOLY.addresses.evm,
  solanaAddress: TOLY.addresses.solana,
  solanaLamports: '152340000000',
  btcSats: '0',
  funding: { ready: true as const, missing: [] as readonly string[] },
  tokens: [
    { symbol: 'SOL', label: 'Solana', amount: '152.34', usd: 25_643.16, chain: 'solana' as const },
    { symbol: 'IKA', label: 'Ika', amount: '0.89', usd: 0.0001, chain: 'solana' as const },
    { symbol: 'USDC', label: 'USD Coin', amount: '420.00', usd: 420.0, chain: 'solana' as const },
  ],
};

export const BALANCES_DEFAULT = BALANCES_DAVID;
