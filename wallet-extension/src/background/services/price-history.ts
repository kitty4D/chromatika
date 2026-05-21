import { COINGECKO_IDS } from '@/config/price-feed-registry';

export type ChartPoint = { timestamp: number; price: number };

type CachedChart = { points: ChartPoint[]; fetchedAtMs: number };

const SESSION_KEY = 'chromatika_price_history_cache_v1';

function ttlForDays(days: number): number {
  if (days <= 1) return 5 * 60_000;
  if (days <= 7) return 15 * 60_000;
  return 60 * 60_000;
}

function cacheKey(symbol: string, days: number): string {
  return `${symbol.toUpperCase()}_${days}`;
}

async function readCache(key: string): Promise<CachedChart | null> {
  return new Promise((resolve) => {
    chrome.storage.session.get([SESSION_KEY], (r) => {
      const all = (r[SESSION_KEY] ?? {}) as Record<string, CachedChart>;
      resolve(all[key] ?? null);
    });
  });
}

async function writeCache(key: string, entry: CachedChart): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.session.get([SESSION_KEY], (r) => {
      const all = ((r[SESSION_KEY] ?? {}) as Record<string, CachedChart>);
      all[key] = entry;
      chrome.storage.session.set({ [SESSION_KEY]: all }, () => resolve());
    });
  });
}

export async function getChartData(symbol: string, days: number): Promise<ChartPoint[]> {
  const cgId = COINGECKO_IDS[symbol.toUpperCase()];
  if (!cgId) return [];

  const ck = cacheKey(symbol, days);
  const cached = await readCache(ck);
  if (cached && Date.now() - cached.fetchedAtMs < ttlForDays(days)) return cached.points;

  const url = `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(cgId)}/market_chart?vs_currency=usd&days=${days}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  if (!r.ok) return cached?.points ?? [];

  const data = await r.json() as { prices?: [number, number][] };
  if (!Array.isArray(data.prices)) return cached?.points ?? [];

  const points: ChartPoint[] = data.prices
    .filter((p) => Array.isArray(p) && p.length >= 2)
    .map(([ts, price]) => ({ timestamp: ts!, price: price! }));

  await writeCache(ck, { points, fetchedAtMs: Date.now() });
  return points;
}
