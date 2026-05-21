/**
 * Per-walker-run price cache. Walkers pass each indexed row's symbol through this helper
 * to populate `IndexedTx.priceUsdAtSync`. The cache memoizes results across one walker
 * page so we don't make N getPrice() calls for the same symbol (e.g. 50 USDC rows on one
 * page → 1 price lookup, 49 cache hits).
 *
 * Lifetime: instance per walker page. Workers `new PriceCache()` at the start of
 * `fetchPage` and discard at the end. The underlying `getPrice` already has its own
 * minute-scale memory cache, so even if walkers shared a long-lived instance the upstream
 * pressure would be the same - the per-page scope is just defensive.
 */

import { getPrice } from '@/background/services/price';

export class PriceCache {
  private readonly cache = new Map<string, number | null>();

  /** look up USD price for a symbol. case-insensitive. `null` cached separately so
   * subsequent lookups for an unknown symbol don't re-call upstream. */
  async lookup(symbol: string | null | undefined): Promise<number | null> {
    if (!symbol) return null;
    const key = symbol.trim().toUpperCase();
    if (!key) return null;
    if (this.cache.has(key)) return this.cache.get(key) ?? null;
    let price: number | null = null;
    try {
      const v = await getPrice(key);
      // getPrice returns 0 (not null) for unknown - treat 0 as "no useful price".
      price = typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
    } catch {
      price = null;
    }
    this.cache.set(key, price);
    return price;
  }

  /** convenience: compute the USD value for `amountRaw` (base units, bigint-as-string)
   * given the row's `symbol` + `decimals`. returns null when the price is unknown or
   * the amount can't be parsed. */
  async usdValueFor(
    symbol: string | null,
    amountRaw: string | null,
    decimals: number,
  ): Promise<number | null> {
    if (!amountRaw) return null;
    const price = await this.lookup(symbol);
    if (price == null) return null;
    try {
      const raw = BigInt(amountRaw);
      const divisor = 10n ** BigInt(decimals);
      // Number conversion is lossy for huge balances, but USD value at 6 decimal places
      // doesn't need full bigint precision. Cap divisor to avoid Number overflow.
      const whole = Number(raw / divisor);
      const fracMicros = Number(raw % divisor) / Number(divisor);
      return (whole + fracMicros) * price;
    } catch {
      return null;
    }
  }
}
