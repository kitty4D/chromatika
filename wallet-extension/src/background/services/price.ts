/**
 * PriceService: user-ordered waterfall (see settings + `price-preferences.ts`).
 * implemented sources: CoinGecko, DefiLlama, CoinMarketCap (optional `VITE_CMC_API_KEY`), Pyth,
 * Chainlink (subset of symbols), GeckoTerminal pool route for IKA (`dextwap`).
 * Switchboard is not implemented and is not exposed as a user-tunable step.
 * ~60s in-memory cache per symbol. BTC fiat off-chain only (no on-chain oracle for mainnet BTC).
 */

import { Contract, JsonRpcProvider } from 'ethers';
import { getPricePreferences } from '@/background/price-preferences';
import type { PriceSourceId } from '@/config/price-sources';
import {
  CHAINLINK_ABI,
  CHAINLINK_FEEDS,
  COINGECKO_IDS,
  DEX_PRICE_ROUTES,
  PYTH_FEED_IDS,
} from '@/config/price-feed-registry';

type CachedPrice = { priceUsd: number; fetchedAtMs: number };

const cache = new Map<string, CachedPrice>();
const providerCache = new Map<string, JsonRpcProvider>();
// in-flight dedupe: concurrent callers for the same symbol share one fetch
// rather than each running the full waterfall. matters when ChromaLab's
// leaderboard fans out N dwallets x M chains and many balance probes hit
// `getPrice('eth')` at the same instant - without this, every caller pays
// full waterfall latency until the first one populates `cache`.
const inflight = new Map<string, Promise<number>>();
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

async function tryCoingecko(symbol: string): Promise<number | null> {
  const cgId = COINGECKO_IDS[symbol.toUpperCase()];
  if (!cgId) return null;
  try {
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(cgId)}&vs_currencies=usd`;
    const r = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!r.ok) return null;
    const data = await r.json() as Record<string, { usd?: number }>;
    return data[cgId]?.usd ?? null;
  } catch {
    return null;
  }
}

async function tryDefiLlama(symbol: string): Promise<number | null> {
  const cgId = COINGECKO_IDS[symbol.toUpperCase()];
  if (!cgId) return null;
  try {
    const key = `coingecko:${cgId}`;
    const url = `https://coins.llama.fi/prices/current/${encodeURIComponent(key)}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!r.ok) return null;
    const data = await r.json() as { coins: Record<string, { price?: number }> };
    return data.coins[key]?.price ?? null;
  } catch {
    return null;
  }
}

/** CoinMarketCap Pro `/v1/cryptocurrency/quotes/latest`: needs `VITE_CMC_API_KEY` at build time. */
async function tryCoinmarketcap(symbol: string): Promise<number | null> {
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
      data?: Record<string, { quote?: { USD?: { price?: number } } }>;
    };
    const row = data.data?.[symbol.toUpperCase()];
    const p = row?.quote?.USD?.price;
    return typeof p === 'number' && Number.isFinite(p) ? p : null;
  } catch {
    return null;
  }
}

/** Chainlink proxy feeds for major EVM assets. */
async function tryChainlink(symbol: string): Promise<number | null> {
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
    return Number(roundData.answer) / 10 ** Number(decimals);
  } catch {
    return null;
  }
}

/** last-resort DEX fallback via GeckoTerminal top-pool price routing. */
async function tryDexTwap(symbol: string): Promise<number | null> {
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
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
}

async function tryPyth(symbol: string): Promise<number | null> {
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
    // price = mantissa * 10^expo
    return parseFloat(parsed.price) * Math.pow(10, parsed.expo);
  } catch {
    return null;
  }
}

// --- public API ---

async function runPriceWaterfall(key: string): Promise<number> {
  const order = await loadPriceOrder();
  const runners: Record<PriceSourceId, () => Promise<number | null>> = {
    coingecko: () => tryCoingecko(key),
    defillama: () => tryDefiLlama(key),
    coinmarketcap: () => tryCoinmarketcap(key),
    pyth: () => tryPyth(key),
    chainlink: () => tryChainlink(key),
    dextwap: () => tryDexTwap(key),
  };

  let price: number | null = null;
  for (const id of order) {
    const fn = runners[id];
    if (!fn) continue;
    price = await fn();
    if (price !== null) break;
  }

  if (price === null) throw new Error(`No price found for ${key}`);

  cache.set(key, { priceUsd: price, fetchedAtMs: Date.now() });
  return price;
}

/** returns USD price for a symbol (e.g. 'ETH', 'BTC'). throws if all sources fail. */
export async function getPrice(symbol: string): Promise<number> {
  const key = symbol.toUpperCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.fetchedAtMs < CACHE_TTL_MS) return hit.priceUsd;

  const pending = inflight.get(key);
  if (pending) return pending;

  // failed promises are removed in .finally so the next caller retries from scratch
  // rather than re-resolving the cached rejection.
  const promise = runPriceWaterfall(key).finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, promise);
  return promise;
}

/** batch price fetch. missing symbols get null (no throw). */
export async function getPrices(symbols: string[]): Promise<Record<string, number | null>> {
  const results = await Promise.allSettled(symbols.map((s) => getPrice(s)));
  return Object.fromEntries(
    symbols.map((s, i) => [s, results[i]?.status === 'fulfilled' ? (results[i] as PromiseFulfilledResult<number>).value : null]),
  );
}

/** evict the cache (e.g. on network switch or settings change). */
export function clearPriceCache(): void {
  cache.clear();
  prefsCache = null;
  inflight.clear();
}
