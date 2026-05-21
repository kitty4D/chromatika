/**
 * Solana Fast / Normal / Slow priority-fee tiers derived from `getRecentPrioritizationFees`.
 *
 * Solana fees are two parts: the base fee (5000 lamports per signature, network-wide constant)
 * + an optional priority fee (per compute unit, in micro-lamports). For a vanilla transfer:
 *   total = baseFee + (computeUnits * priorityFeeMicroLamports / 1_000_000)
 *
 * approach:
 *  1. `connection.getRecentPrioritizationFees()` returns up to 150 recent slot samples,
 *     each with `prioritizationFee` (micro-lamports per CU) and `slot`.
 *  2. Compute p25/p50/p75 percentiles of the non-zero samples.
 *  3. Multiply by `computeUnits` (caller-supplied, defaults to 200_000 for vanilla transfer).
 *  4. Add the base signature fee (5000 lamports * signers).
 *
 * the returned shape mirrors `evm-fee-tiers.ts` so the UI picker can reuse rendering logic.
 */

import type { Connection } from '@solana/web3.js';

export type SolanaFeeTier = {
  tier: 'slow' | 'normal' | 'fast';
  /** total lamports the user would pay. bigint as string. */
  totalLamports: string;
  totalFormatted: string;
  totalUsd: number | null;
  /** priority fee in micro-lamports per compute unit. bigint as string. */
  computeUnitPriceMicroLamports: string;
  /** compute units (200_000 typical for simple transfer). bigint as string. */
  computeUnits: string;
  /** base signature fee (5000 * signers) in lamports. bigint as string. */
  baseFeeLamports: string;
};

export type SolanaFeeTiersResult = {
  fromRealData: boolean;
  slow: SolanaFeeTier;
  normal: SolanaFeeTier;
  fast: SolanaFeeTier;
};

/** default compute units for a System / SPL transfer; conservative for vanilla cases. */
const SOLANA_DEFAULT_COMPUTE_UNITS = 200_000n;
/** Solana base fee per signature - network-wide constant. */
const SOLANA_BASE_FEE_PER_SIGNATURE_LAMPORTS = 5000n;

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! * (hi - rank) + sorted[hi]! * (rank - lo);
}

function formatLamportsAsSol(lamports: bigint): string {
  const whole = lamports / 1_000_000_000n;
  const frac = lamports % 1_000_000_000n;
  const fracPadded = frac.toString().padStart(9, '0').slice(0, 7).replace(/0+$/, '');
  const fracStr = fracPadded.length > 0 ? `.${fracPadded}` : '';
  return `${whole.toString()}${fracStr} SOL`;
}

function buildTier(opts: {
  tier: SolanaFeeTier['tier'];
  cuPriceMicroLamports: bigint;
  computeUnits: bigint;
  baseFeeLamports: bigint;
  solUsdPrice: number | null;
}): SolanaFeeTier {
  // priority cost in lamports = computeUnits * microLamportsPerCU / 1_000_000.
  // do the division at bigint level (integer math) to avoid floating-point drift.
  const priorityLamports =
    (opts.cuPriceMicroLamports * opts.computeUnits + 999_999n) / 1_000_000n;
  const totalLamports = opts.baseFeeLamports + priorityLamports;
  const totalSol = Number(totalLamports) / 1e9;
  const totalUsd = opts.solUsdPrice != null && opts.solUsdPrice > 0 ? totalSol * opts.solUsdPrice : null;
  return {
    tier: opts.tier,
    totalLamports: totalLamports.toString(),
    totalFormatted: formatLamportsAsSol(totalLamports),
    totalUsd,
    computeUnitPriceMicroLamports: opts.cuPriceMicroLamports.toString(),
    computeUnits: opts.computeUnits.toString(),
    baseFeeLamports: opts.baseFeeLamports.toString(),
  };
}

/**
 * fetch Fast/Normal/Slow priority-fee tiers for Solana.
 *
 * @param connection live Solana Connection (already cluster-aware).
 * @param computeUnits compute units the tx will consume. Defaults to 200_000.
 * @param signers number of signatures the tx will need. Defaults to 1 (base fee = 5000).
 * @param solUsdPrice spot USD price of SOL; null disables the USD column.
 */
export async function fetchSolanaFeeTiers(
  connection: Connection,
  computeUnits: bigint,
  signers: number,
  solUsdPrice: number | null,
): Promise<SolanaFeeTiersResult> {
  let p25 = 0n;
  let p50 = 0n;
  let p75 = 0n;
  let fromRealData = true;

  try {
    // No address arg -> network-wide recent priority fees (last ~150 slots).
    const samples = await connection.getRecentPrioritizationFees();
    const nonZero = samples
      .map((s) => Number(s.prioritizationFee ?? 0))
      .filter((n) => n > 0 && Number.isFinite(n));
    if (nonZero.length === 0) {
      // empty samples are common on devnet/testnet; degrade to a baseline price.
      fromRealData = false;
      p25 = 0n;
      p50 = 1000n; // 1000 microLamports/CU baseline (= ~0.0002 SOL extra at 200k CU)
      p75 = 5000n;
    } else {
      p25 = BigInt(Math.round(percentile(nonZero, 25)));
      p50 = BigInt(Math.round(percentile(nonZero, 50)));
      p75 = BigInt(Math.round(percentile(nonZero, 75)));
      if (p50 === 0n) p50 = 1000n;
      if (p25 === 0n) p25 = p50;
      if (p75 === 0n) p75 = p50 * 2n;
    }
  } catch (e) {
    fromRealData = false;
    console.warn('[solana-fee-tiers] getRecentPrioritizationFees failed; using baseline', e);
    p25 = 0n;
    p50 = 1000n;
    p75 = 5000n;
  }

  const cu = computeUnits > 0n ? computeUnits : SOLANA_DEFAULT_COMPUTE_UNITS;
  const baseFee = SOLANA_BASE_FEE_PER_SIGNATURE_LAMPORTS * BigInt(Math.max(1, signers));
  return {
    fromRealData,
    slow: buildTier({ tier: 'slow', cuPriceMicroLamports: p25, computeUnits: cu, baseFeeLamports: baseFee, solUsdPrice }),
    normal: buildTier({ tier: 'normal', cuPriceMicroLamports: p50, computeUnits: cu, baseFeeLamports: baseFee, solUsdPrice }),
    fast: buildTier({ tier: 'fast', cuPriceMicroLamports: p75, computeUnits: cu, baseFeeLamports: baseFee, solUsdPrice }),
  };
}
