/**
 * swap-config.ts - constants for phase B Sui-native auto-top-up.
 *
 * swap quotes and PTBs use `aftermath-ts-sdk` (Router + Mysten Transaction build).
 */

/** minimum SUI to keep after a swap so the user can still pay gas for ika PTBs */
export const MIN_SUI_RESERVE_MIST = 50_000_000n; // 0.05 SUI

/**
 * default IKA to acquire in a single swap, enough for ~10 ika operations
 * (registerKey + DKG + acceptShare + 3 presigns + several sign PTBs).
 * each op splits 1_000_000 IKA base units.
 */
export const DEFAULT_IKA_TARGET_BASE_UNITS = 10_000_000n;

/** slippage defaults in basis points */
export const DEFAULT_SLIPPAGE_BPS = 100; // 1%
export const MAX_SLIPPAGE_BPS = 500; // 5%

/** quote freshness: aftermath quotes go stale fast */
export const QUOTE_CACHE_TTL_MS = 30_000; // 30s

/**
 * SUI coin type (the 0x2 one). used as the "from" side of the swap.
 * re-exported here so swap-service doesn't need to import from coins.ts directly.
 */
export const SUI_COIN_TYPE =
  '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';
