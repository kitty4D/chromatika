/**
 * EVM Fast / Normal / Slow fee tiers derived from `eth_feeHistory`.
 *
 * suiKER (Android, Sui-native) shows three priority tiers on its Confirm screen with
 * emoji + token + fiat per tier; users tap to pick. Chromatika's old Send had a
 * `'network gas (estimate at send)'` placeholder - this module replaces the data path.
 *
 * approach (1559 chains):
 *   1. `eth_feeHistory(20, 'latest', [25, 50, 75])` - last 20 blocks, percentile priority fees.
 *   2. Take median across blocks per percentile to flatten one-block spikes.
 *   3. Tiers = { slow: p25, normal: p50, fast: p75 } priority fees in wei.
 *   4. `maxFeePerGas` = current base fee * 2 + tier priority fee (standard 2x base-fee headroom).
 *   5. Multiply by the gas units estimate (caller-provided, usually `eth_estimateGas`).
 *
 * legacy chains (no base fee):
 *   1. `eth_gasPrice` - single number.
 *   2. Synthesize tiers as { slow: x0.9, normal: x1.0, fast: x1.25 } around it.
 *   3. `maxFeePerGas` = tier gasPrice, `maxPriorityFeePerGas = null` (legacy path).
 *
 * the returned shape supports both kinds; UI renders the picker either way (suiKER also
 * shows a single line for chains it can't tier, we'll just degrade gracefully).
 */

import { sendEvmRpcWithRetry } from '@/background/chains/evm-send';

export type EvmFeeTier = {
  /** "slow" | "normal" | "fast" identifier. */
  tier: 'slow' | 'normal' | 'fast';
  /** total wei the user would pay (gasLimit * effective gas price). bigint as string. */
  totalWei: string;
  /** formatted display value, e.g. "0.000123 ETH". */
  totalFormatted: string;
  /** USD-equivalent of the total when a native price is provided; null otherwise. */
  totalUsd: number | null;
  /** 1559 fee params - null on legacy chains. */
  maxFeePerGas: string | null;
  maxPriorityFeePerGas: string | null;
  /** legacy gas price - null on 1559 chains. */
  gasPrice: string | null;
  /** the gas limit used for the multiplication, copied through for the caller. */
  gasLimit: string;
};

export type EvmFeeTiersResult = {
  /** true when all three tiers came from real RPC data; false if any synthesis happened
   * (legacy chain, partial feeHistory) - UI may want to footnote when this is false. */
  fromRealData: boolean;
  /** symbol of the chain's native token, for formatting (ETH / MATIC / BNB / etc.) */
  symbol: string;
  /** decimals of the native token (always 18 for EVM but plumbed for safety). */
  decimals: number;
  slow: EvmFeeTier;
  normal: EvmFeeTier;
  fast: EvmFeeTier;
};

/** parse a 0x-prefixed hex string (or bigint/number) into a bigint. used for both
 * `eth_feeHistory` block.baseFeePerGas (hex strings) and `eth_gasPrice` (hex string). */
function parseHexBigInt(v: unknown): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(Math.trunc(v));
  if (typeof v !== 'string') return 0n;
  const s = v.trim();
  if (s === '' || s === '0x') return 0n;
  return BigInt(s.startsWith('0x') ? s : `0x${s}`);
}

/** median of a number[] - used to flatten one-block percentile-priority-fee spikes. */
function median(arr: bigint[]): bigint {
  if (arr.length === 0) return 0n;
  const sorted = [...arr].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[mid]!;
  // bigint average of two values - mind the integer division.
  return (sorted[mid - 1]! + sorted[mid]!) / 2n;
}

/** ethers-ish 18-decimal format with 6 fractional digits trimmed. */
function formatNativeAmount(wei: bigint, decimals: number, symbol: string): string {
  const divisor = 10n ** BigInt(decimals);
  const whole = wei / divisor;
  const frac = wei % divisor;
  const fracPadded = frac.toString().padStart(decimals, '0').slice(0, 6).replace(/0+$/, '');
  const fracStr = fracPadded.length > 0 ? `.${fracPadded}` : '';
  return `${whole.toString()}${fracStr} ${symbol}`;
}

function buildTierFrom1559(opts: {
  tier: EvmFeeTier['tier'];
  baseFee: bigint;
  priorityFee: bigint;
  gasLimit: bigint;
  decimals: number;
  symbol: string;
  nativeUsdPrice: number | null;
}): EvmFeeTier {
  // 2x base-fee headroom is the long-standing default in ethers / wagmi; covers a couple of
  // base-fee bumps before the tx gets dropped. priority fee added on top.
  const maxFeePerGas = opts.baseFee * 2n + opts.priorityFee;
  const totalWei = maxFeePerGas * opts.gasLimit;
  const totalFormatted = formatNativeAmount(totalWei, opts.decimals, opts.symbol);
  const totalUsd =
    opts.nativeUsdPrice != null && opts.nativeUsdPrice > 0
      ? (Number(totalWei) / Number(10n ** BigInt(opts.decimals))) * opts.nativeUsdPrice
      : null;
  return {
    tier: opts.tier,
    totalWei: totalWei.toString(),
    totalFormatted,
    totalUsd,
    maxFeePerGas: maxFeePerGas.toString(),
    maxPriorityFeePerGas: opts.priorityFee.toString(),
    gasPrice: null,
    gasLimit: opts.gasLimit.toString(),
  };
}

function buildTierFromLegacy(opts: {
  tier: EvmFeeTier['tier'];
  gasPrice: bigint;
  gasLimit: bigint;
  decimals: number;
  symbol: string;
  nativeUsdPrice: number | null;
}): EvmFeeTier {
  const totalWei = opts.gasPrice * opts.gasLimit;
  const totalFormatted = formatNativeAmount(totalWei, opts.decimals, opts.symbol);
  const totalUsd =
    opts.nativeUsdPrice != null && opts.nativeUsdPrice > 0
      ? (Number(totalWei) / Number(10n ** BigInt(opts.decimals))) * opts.nativeUsdPrice
      : null;
  return {
    tier: opts.tier,
    totalWei: totalWei.toString(),
    totalFormatted,
    totalUsd,
    maxFeePerGas: null,
    maxPriorityFeePerGas: null,
    gasPrice: opts.gasPrice.toString(),
    gasLimit: opts.gasLimit.toString(),
  };
}

/**
 * fetch Fast / Normal / Slow fee tiers for an EVM chain.
 *
 * @param chainId numeric chain id (used for the RPC fallback rotation in `sendEvmRpcWithRetry`).
 * @param primaryRpcUrl the chain's primary RPC (typically `BUILTIN_EVM.find(...).rpcUrl`).
 * @param gasLimit estimated gas units for the tx being priced.
 * @param symbol native token symbol (ETH / MATIC / etc.) for display.
 * @param decimals native token decimals (always 18 for EVM in practice).
 * @param nativeUsdPrice spot USD price of the native token; null disables USD column.
 */
export async function fetchEvmFeeTiers(
  chainId: number,
  primaryRpcUrl: string,
  gasLimit: bigint,
  symbol: string,
  decimals: number,
  nativeUsdPrice: number | null,
): Promise<EvmFeeTiersResult> {
  let baseFee = 0n;
  let p25 = 0n;
  let p50 = 0n;
  let p75 = 0n;
  let fromRealData = true;

  try {
    // `eth_feeHistory(blockCount, newestBlock, rewardPercentiles)`.
    // 20 blocks ~ 4 minutes on mainnet; enough to smooth single-block spikes.
    const fh = await sendEvmRpcWithRetry(chainId, primaryRpcUrl, 'eth_feeHistory', [
      '0x14', // 20 in hex
      'latest',
      [25, 50, 75],
    ]);
    const fhAny = fh as {
      baseFeePerGas?: string[];
      reward?: string[][];
    };
    const baseFees = (fhAny.baseFeePerGas ?? []).map(parseHexBigInt);
    const rewards = (fhAny.reward ?? []).map((row) => row.map(parseHexBigInt));
    if (baseFees.length === 0 || rewards.length === 0) {
      throw new Error('feeHistory empty');
    }
    // newest base fee is the last entry; rewards are aligned per oldest..newest block.
    baseFee = baseFees[baseFees.length - 1] ?? 0n;
    const p25List = rewards.map((r) => r[0] ?? 0n).filter((x) => x > 0n);
    const p50List = rewards.map((r) => r[1] ?? 0n).filter((x) => x > 0n);
    const p75List = rewards.map((r) => r[2] ?? 0n).filter((x) => x > 0n);
    p25 = median(p25List);
    p50 = median(p50List);
    p75 = median(p75List);
    // some chains return zero rewards across the window when the block tip has empty txns;
    // fall back to a sensible floor so the picker doesn't show "0 ETH" for all tiers.
    if (p50 === 0n) p50 = 1_000_000_000n; // 1 gwei floor
    if (p25 === 0n) p25 = p50;
    if (p75 === 0n) p75 = p50 * 2n;
  } catch (e) {
    fromRealData = false;
    console.warn('[evm-fee-tiers] eth_feeHistory failed; falling back to legacy gasPrice', {
      chainId,
      error: e instanceof Error ? e.message : String(e),
    });
  }

  if (fromRealData && baseFee > 0n) {
    return {
      fromRealData: true,
      symbol,
      decimals,
      slow: buildTierFrom1559({ tier: 'slow', baseFee, priorityFee: p25, gasLimit, decimals, symbol, nativeUsdPrice }),
      normal: buildTierFrom1559({ tier: 'normal', baseFee, priorityFee: p50, gasLimit, decimals, symbol, nativeUsdPrice }),
      fast: buildTierFrom1559({ tier: 'fast', baseFee, priorityFee: p75, gasLimit, decimals, symbol, nativeUsdPrice }),
    };
  }

  // legacy fallback: synthesize tiers from `eth_gasPrice`.
  let basePrice = 20_000_000_000n; // 20 gwei sane default
  try {
    const raw = await sendEvmRpcWithRetry(chainId, primaryRpcUrl, 'eth_gasPrice', []);
    basePrice = parseHexBigInt(raw);
    if (basePrice <= 0n) basePrice = 20_000_000_000n;
  } catch (e) {
    console.warn('[evm-fee-tiers] eth_gasPrice also failed; using 20 gwei default', {
      chainId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
  const slowPrice = (basePrice * 9n) / 10n;
  const normalPrice = basePrice;
  const fastPrice = (basePrice * 5n) / 4n;
  return {
    fromRealData: false,
    symbol,
    decimals,
    slow: buildTierFromLegacy({ tier: 'slow', gasPrice: slowPrice, gasLimit, decimals, symbol, nativeUsdPrice }),
    normal: buildTierFromLegacy({ tier: 'normal', gasPrice: normalPrice, gasLimit, decimals, symbol, nativeUsdPrice }),
    fast: buildTierFromLegacy({ tier: 'fast', gasPrice: fastPrice, gasLimit, decimals, symbol, nativeUsdPrice }),
  };
}
