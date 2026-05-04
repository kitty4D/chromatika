/**
 * resolve a soft-policy declared value for a Bitcoin sign request.
 *
 * BTC native sends sign one preimage per input. to avoid the cap counting an N-input tx
 * as N times the value, the caller declares the FULL sendSats value on the first sign call
 * and 0 on the rest. net effect on the policy module's `spent_today_micros`: same as the
 * actual USD value of the tx.
 *
 * soft policy v0: caller-declared. hard policy v1 will parse the BIP143 sighash preimage
 * itself in Move, which exposes the input value + output values as raw bytes.
 */

import { getPrice } from '@/background/services/price';

/** convert sats + BTC/USD price to u64-saturated micro-USD. mirrors the EVM helper. */
function satsToMicroUsd(sats: bigint, priceUsd: number): bigint {
  if (sats <= 0n) return 0n;
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) return 0n;
  const priceMicros = BigInt(Math.round(priceUsd * 1_000_000));
  // valueMicros = sats * priceMicros / 1e8 (sats -> BTC -> USD)
  const valueMicros = (sats * priceMicros) / 100_000_000n;
  const U64_MAX = (1n << 64n) - 1n;
  return valueMicros > U64_MAX ? U64_MAX : valueMicros;
}

/**
 * resolve declared value (in micro-USD) for a BTC native send. returns 0n on price-lookup
 * failure or zero sats.
 */
export async function resolveBtcDeclaredValueMicros(sendSats: bigint): Promise<bigint> {
  if (sendSats <= 0n) return 0n;
  try {
    const btcPrice = await getPrice('btc');
    return satsToMicroUsd(sendSats, btcPrice);
  } catch (e) {
    console.warn('[chromatika policy-vault] resolveBtcDeclaredValueMicros failed; treating as 0:', e);
    return 0n;
  }
}

/**
 * convert a USD-per-BTC price to micro-USD-per-satoshi.
 *
 * math: micro-USD/sat = (priceUsdPerBtc * 1_000_000) / 100_000_000 = priceUsdPerBtc / 100
 * at $50_000/BTC -> 500 micro-USD/sat
 * at $100_000/BTC -> 1000 micro-USD/sat
 *
 * the Move-side `sign_btc_with_policy` multiplies `value_sats * price_micros_per_satoshi`
 * directly, so this helper produces the right granularity. sub-cent rounding is fine for
 * the cap (we floor; the policy module saturates u64).
 */
function priceMicrosPerSatoshi(priceUsdPerBtc: number): bigint {
  if (!Number.isFinite(priceUsdPerBtc) || priceUsdPerBtc <= 0) return 0n;
  // priceUsdPerBtc * 1e6 / 1e8 = priceUsdPerBtc / 100; round nearest, floor at 0.
  const v = Math.round((priceUsdPerBtc * 1_000_000) / 100_000_000);
  return v <= 0 ? 0n : BigInt(v);
}

/**
 * resolve the BTC/USD price as micro-USD per satoshi for the Move hard-policy decoder.
 * returns 0n on price-lookup failure (caller falls back to soft policy).
 */
export async function resolveBtcPriceMicrosPerSatoshi(): Promise<bigint> {
  try {
    const btcPrice = await getPrice('btc');
    return priceMicrosPerSatoshi(btcPrice);
  } catch (e) {
    console.warn('[chromatika policy-vault] resolveBtcPriceMicrosPerSatoshi failed; returning 0:', e);
    return 0n;
  }
}

export const __test__ = { satsToMicroUsd, priceMicrosPerSatoshi };
