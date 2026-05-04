/**
 * user-configurable USD price waterfall (see `price-preferences.ts` + settings UI).
 * switchboard is intentionally not a selectable source - it is not implemented in Chromatika.
 */

export const PRICE_SOURCE_IDS = [
  'coingecko',
  'defillama',
  'coinmarketcap',
  'pyth',
  'chainlink',
  'dextwap',
] as const;

export type PriceSourceId = (typeof PRICE_SOURCE_IDS)[number];

export const PRICE_SOURCE_LABELS: Record<PriceSourceId, string> = {
  coingecko: 'CoinGecko',
  defillama: 'DefiLlama',
  coinmarketcap: 'CoinMarketCap',
  pyth: 'Pyth Hermes',
  chainlink: 'Chainlink (EVM feeds)',
  dextwap: 'GeckoTerminal pool (IKA-style routes)',
};

/** default try order; user may reorder or drop entries in settings. */
export const DEFAULT_PRICE_SOURCE_ORDER: PriceSourceId[] = [
  'coingecko',
  'defillama',
  'coinmarketcap',
  'pyth',
  'chainlink',
  'dextwap',
];

export function normalizePriceSourceOrder(value: unknown): PriceSourceId[] {
  if (!Array.isArray(value)) return [...DEFAULT_PRICE_SOURCE_ORDER];
  const out: PriceSourceId[] = [];
  const seen = new Set<PriceSourceId>();
  for (const raw of value) {
    if (typeof raw !== 'string') continue;
    if (!(PRICE_SOURCE_IDS as readonly string[]).includes(raw)) continue;
    const id = raw as PriceSourceId;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  if (out.length === 0) return [...DEFAULT_PRICE_SOURCE_ORDER];
  return out;
}
