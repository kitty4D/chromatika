/**
 * resolve a soft-policy declared value for a Solana sign request.
 *
 * native SOL: lamports * SOL price / 1e9.
 * SPL: hard without per-token price plumbing; v0 declares 0 (SPL transfers don't count
 * toward the daily cap). track v1 to add a per-token price oracle so caps cover SPL too.
 *
 * soft policy v0: caller-declared. hard policy v1 will parse the Solana ix layout in Move
 * (when Solana ika base ships its own policy program; tracked separately).
 */

import { getPrice } from '@/background/services/price';

const LAMPORTS_PER_SOL = 1_000_000_000n;

function lamportsToMicroUsd(lamports: bigint, priceUsd: number): bigint {
  if (lamports <= 0n) return 0n;
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) return 0n;
  const priceMicros = BigInt(Math.round(priceUsd * 1_000_000));
  const valueMicros = (lamports * priceMicros) / LAMPORTS_PER_SOL;
  const U64_MAX = (1n << 64n) - 1n;
  return valueMicros > U64_MAX ? U64_MAX : valueMicros;
}

/**
 * native SOL transfer: convert lamports -> micro-USD via current SOL price.
 */
export async function resolveSolDeclaredValueMicros(lamports: bigint): Promise<bigint> {
  if (lamports <= 0n) return 0n;
  try {
    const solPrice = await getPrice('sol');
    return lamportsToMicroUsd(lamports, solPrice);
  } catch (e) {
    console.warn('[chromatika policy-vault] resolveSolDeclaredValueMicros failed; treating as 0:', e);
    return 0n;
  }
}

/**
 * SPL transfer: v0 returns 0n. the cap doesn't apply to SPL until per-token price plumbing
 * ships. until then, SPL transfers fall through the cap; users who care should set tighter
 * panic-only caps (cap = 0 + cool-down + pre-registered actuators).
 */
export async function resolveSplDeclaredValueMicros(
  _mint: string,
  _amountRaw: bigint,
): Promise<bigint> {
  return 0n;
}

export const __test__ = { lamportsToMicroUsd };
