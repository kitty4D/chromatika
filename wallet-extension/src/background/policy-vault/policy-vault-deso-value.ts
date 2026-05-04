/**
 * resolve a soft-policy declared value for a DeSo sign request.
 *
 * DeSo native sends pass `amountNanos` to `sendDeSoNative`; that's the value being moved.
 * post txs pass no amount (just a body); declared value = 0. Diamond / creator-coin /
 * NFT bid txs (deferred) will need their own resolvers per shape.
 *
 * soft policy v0: caller-declared. hard policy v1 will parse the DeSo unsigned tx bytes
 * in Move (DeSo's binary tx format includes the BasicTransfer outputs explicitly).
 */

import { getPrice } from '@/background/services/price';

const NANOS_PER_DESO = 1_000_000_000n;

/** convert nanos + DESO/USD price to u64-saturated micro-USD. */
function nanosToMicroUsd(nanos: bigint, priceUsd: number): bigint {
  if (nanos <= 0n) return 0n;
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) return 0n;
  const priceMicros = BigInt(Math.round(priceUsd * 1_000_000));
  // valueMicros = nanos * priceMicros / 1e9
  const valueMicros = (nanos * priceMicros) / NANOS_PER_DESO;
  const U64_MAX = (1n << 64n) - 1n;
  return valueMicros > U64_MAX ? U64_MAX : valueMicros;
}

/**
 * resolve declared value (in micro-USD) for a DeSo native send. returns 0n on price-lookup
 * failure or zero-value txs (posts).
 */
export async function resolveDeSoDeclaredValueMicros(amountNanos: bigint): Promise<bigint> {
  if (amountNanos <= 0n) return 0n;
  try {
    const desoPrice = await getPrice('deso');
    return nanosToMicroUsd(amountNanos, desoPrice);
  } catch (e) {
    console.warn('[chromatika policy-vault] resolveDeSoDeclaredValueMicros failed; treating as 0:', e);
    return 0n;
  }
}

/**
 * convert a USD-per-DESO price to micro-USD-per-DESO for the Move-side hard decoder.
 * the Move `sign_deso_with_policy` multiplies `output_sum_nanos * price_micros_per_deso /
 * 1e9` to get micro-USD; this helper produces the per-DESO factor.
 *
 * at $30/DESO -> 30_000_000 micro-USD/DESO. at $50/DESO -> 50_000_000.
 */
function priceMicrosPerDeso(priceUsdPerDeso: number): bigint {
  if (!Number.isFinite(priceUsdPerDeso) || priceUsdPerDeso <= 0) return 0n;
  const v = Math.round(priceUsdPerDeso * 1_000_000);
  return v <= 0 ? 0n : BigInt(v);
}

/**
 * resolve the DESO/USD price as micro-USD per DESO for the Move hard-policy decoder.
 * returns 0n on price-lookup failure (caller falls back to soft policy).
 */
export async function resolveDeSoPriceMicrosPerDeso(): Promise<bigint> {
  try {
    const desoPrice = await getPrice('deso');
    return priceMicrosPerDeso(desoPrice);
  } catch (e) {
    console.warn('[chromatika policy-vault] resolveDeSoPriceMicrosPerDeso failed; returning 0:', e);
    return 0n;
  }
}

export const __test__ = { nanosToMicroUsd, priceMicrosPerDeso };
