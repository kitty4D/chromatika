/**
 * PriceService: user-ordered waterfall (see settings + `price-preferences.ts`).
 * implemented sources: CoinGecko, DefiLlama, CoinMarketCap (optional `VITE_CMC_API_KEY`), Pyth,
 * Chainlink (subset of symbols), GeckoTerminal pool route for IKA (`dextwap`).
 * Switchboard is not implemented and is not exposed as a user-tunable step.
 * ~60s in-memory cache per symbol. BTC fiat off-chain only (no on-chain oracle for mainnet BTC).
 */

import { Contract, JsonRpcProvider } from 'ethers';
import { captureException } from '@/background/analytics/sentry';
import { getPricePreferences } from '@/background/price-preferences';
import type { PriceSourceId } from '@/config/price-sources';
import {
  CHAINLINK_ABI,
  CHAINLINK_FEEDS,
  COINGECKO_IDS,
  DEX_PRICE_ROUTES,
  PYTH_FEED_IDS,
} from '@/config/price-feed-registry';

type CachedPrice = { priceUsd: number; changePercent24h: number | null; fetchedAtMs: number };

export type PriceWithChange = { usd: number; changePercent24h: number | null };

const cache = new Map<string, CachedPrice>();
const providerCache = new Map<string, JsonRpcProvider>();
const CACHE_TTL_MS = 60_000;
const CHAINLINK_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

let prefsCache: { atMs: number; order: PriceSourceId[] } | null = null;
const PREFS_TTL_MS = 2_000;

async function loadPriceOrder(): Promise<PriceSourceId[]> {
  if (prefsCache && Date.now() - prefsCache.atMs < PREFS_TTL_MS) return prefsCache.order;
  const prefs = await getPricePreferences();
  prefsCache = { atMs: Date.now(), order: prefs.order };
  return prefs.order;
}

function getProvider(rpcUrl: string): JsonRpcProvider {
  let provider = providerCache.get(rpcUrl);
  if (!provider) {
    provider = new JsonRpcProvider(rpcUrl);
    providerCache.set(rpcUrl, provider);
  }
  return provider;
}

// --- waterfall helpers ---

type WaterfallResult = { price: number; change24h: number | null } | null;

async function tryCoingecko(symbol: string): Promise<WaterfallResult> {
  const cgId = COINGECKO_IDS[symbol.toUpperCase()];
  if (!cgId) return null;
  try {
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(cgId)}&vs_currencies=usd&include_24hr_change=true`;
    const r = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!r.ok) return null;
    const data = await r.json() as Record<string, { usd?: number; usd_24h_change?: number }>;
    const entry = data[cgId];
    if (entry?.usd == null) return null;
    const ch = typeof entry.usd_24h_change === 'number' && Number.isFinite(entry.usd_24h_change) ? entry.usd_24h_change : null;
    return { price: entry.usd, change24h: ch };
  } catch {
    return null;
  }
}

async function tryDefiLlama(symbol: string): Promise<WaterfallResult> {
  const cgId = COINGECKO_IDS[symbol.toUpperCase()];
  if (!cgId) return null;
  try {
    const key = `coingecko:${cgId}`;
    const url = `https://coins.llama.fi/prices/current/${encodeURIComponent(key)}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!r.ok) return null;
    const data = await r.json() as { coins: Record<string, { price?: number }> };
    const p = data.coins[key]?.price;
    return p != null ? { price: p, change24h: null } : null;
  } catch {
    return null;
  }
}

async function tryCoinmarketcap(symbol: string): Promise<WaterfallResult> {
  const apiKey = import.meta.env.VITE_CMC_API_KEY ?? '';
  if (!apiKey) return null;
  try {
    const url = `https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?symbol=${encodeURIComponent(symbol)}`;
    const r = await fetch(url, {
      headers: { 'X-CMC_PRO_API_KEY': apiKey },
      signal: AbortSignal.timeout(5_000),
    });
    if (!r.ok) return null;
    const data = (await r.json()) as {
      data?: Record<string, { quote?: { USD?: { price?: number; percent_change_24h?: number } } }>;
    };
    const row = data.data?.[symbol.toUpperCase()];
    const p = row?.quote?.USD?.price;
    if (typeof p !== 'number' || !Number.isFinite(p)) return null;
    const ch = row?.quote?.USD?.percent_change_24h;
    return { price: p, change24h: typeof ch === 'number' && Number.isFinite(ch) ? ch : null };
  } catch {
    return null;
  }
}

async function tryChainlink(symbol: string): Promise<WaterfallResult> {
  const feed = CHAINLINK_FEEDS[symbol.toUpperCase()];
  if (!feed) return null;
  try {
    const provider = getProvider(feed.rpcUrl);
    const contract = new Contract(feed.feedAddress, CHAINLINK_ABI, provider);
    const [roundData, decimals] = await Promise.all([
      contract.latestRoundData() as Promise<{ answer: bigint; updatedAt: bigint }>,
      contract.decimals() as Promise<number>,
    ]);
    const updatedAtMs = Number(roundData.updatedAt) * 1000;
    if (!Number.isFinite(updatedAtMs) || updatedAtMs <= 0) return null;
    if (Date.now() - updatedAtMs > CHAINLINK_STALE_AFTER_MS) return null;
    if (roundData.answer <= 0n) return null;
    return { price: Number(roundData.answer) / 10 ** Number(decimals), change24h: null };
  } catch {
    return null;
  }
}

async function tryDexTwap(symbol: string): Promise<WaterfallResult> {
  const route = DEX_PRICE_ROUTES[symbol.toUpperCase()];
  if (!route) return null;
  try {
    const url = `https://api.geckoterminal.com/api/v2/simple/networks/${route.network}/token_price/${encodeURIComponent(route.tokenAddress)}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!r.ok) return null;
    const data = await r.json() as {
      data?: {
        attributes?: {
          token_prices?: Record<string, string>;
        };
      };
    };
    const rawPrice =
      data.data?.attributes?.token_prices?.[route.tokenAddress]
      ?? data.data?.attributes?.token_prices?.[route.tokenAddress.toLowerCase()];
    if (!rawPrice) return null;
    const parsed = Number(rawPrice);
    return Number.isFinite(parsed) && parsed > 0 ? { price: parsed, change24h: null } : null;
  } catch {
    return null;
  }
}

async function tryPyth(symbol: string): Promise<WaterfallResult> {
  const feedId = PYTH_FEED_IDS[symbol.toUpperCase()];
  if (!feedId) return null;
  try {
    const url = `https://hermes.pyth.network/v2/updates/price/latest?ids[]=${feedId}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!r.ok) return null;
    const data = await r.json() as {
      parsed?: Array<{ price?: { price?: string; expo?: number } }>;
    };
    const parsed = data.parsed?.[0]?.price;
    if (!parsed?.price || parsed.expo === undefined) return null;
    return { price: parseFloat(parsed.price) * Math.pow(10, parsed.expo), change24h: null };
  } catch {
    return null;
  }
}

// --- public API ---

const inflight2 = new Map<string, Promise<CachedPrice>>();

async function runPriceWaterfall(key: string): Promise<CachedPrice> {
  const order = await loadPriceOrder();
  const runners: Record<PriceSourceId, () => Promise<WaterfallResult>> = {
    coingecko: () => tryCoingecko(key),
    defillama: () => tryDefiLlama(key),
    coinmarketcap: () => tryCoinmarketcap(key),
    pyth: () => tryPyth(key),
    chainlink: () => tryChainlink(key),
    dextwap: () => tryDexTwap(key),
  };

  let result: WaterfallResult = null;
  for (const id of order) {
    const fn = runners[id];
    if (!fn) continue;
    result = await fn();
    if (result !== null) break;
  }

  if (result === null) {
    const err = new Error(`No price found for ${key}`);
    captureException(err, { feature: 'price', chain: 'none' });
    throw err;
  }

  const entry: CachedPrice = { priceUsd: result.price, changePercent24h: result.change24h, fetchedAtMs: Date.now() };
  cache.set(key, entry);
  return entry;
}

async function resolvePrice(symbol: string): Promise<CachedPrice> {
  const key = symbol.toUpperCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.fetchedAtMs < CACHE_TTL_MS) return hit;

  const pending = inflight2.get(key);
  if (pending) return pending;

  const promise = runPriceWaterfall(key).finally(() => {
    inflight2.delete(key);
  });
  inflight2.set(key, promise);
  return promise;
}

/** returns USD price for a symbol (e.g. 'ETH', 'BTC'). throws if all sources fail. */
export async function getPrice(symbol: string): Promise<number> {
  return (await resolvePrice(symbol)).priceUsd;
}

/** batch price fetch. missing symbols get null (no throw). */
export async function getPrices(symbols: string[]): Promise<Record<string, number | null>> {
  const results = await Promise.allSettled(symbols.map((s) => getPrice(s)));
  return Object.fromEntries(
    symbols.map((s, i) => [s, results[i]?.status === 'fulfilled' ? (results[i] as PromiseFulfilledResult<number>).value : null]),
  );
}

/** returns USD price + 24h change for a symbol. throws if all sources fail. */
export async function getPriceWithChange(symbol: string): Promise<PriceWithChange> {
  const entry = await resolvePrice(symbol);
  return { usd: entry.priceUsd, changePercent24h: entry.changePercent24h };
}

/** batch fetch with 24h change. missing symbols get null (no throw). */
export async function getPricesWithChange(symbols: string[]): Promise<Record<string, PriceWithChange | null>> {
  const results = await Promise.allSettled(symbols.map((s) => getPriceWithChange(s)));
  return Object.fromEntries(
    symbols.map((s, i) => [s, results[i]?.status === 'fulfilled' ? (results[i] as PromiseFulfilledResult<PriceWithChange>).value : null]),
  );
}

/** evict the cache (e.g. on network switch or settings change). */
export function clearPriceCache(): void {
  cache.clear();
  prefsCache = null;
  inflight2.clear();
}
