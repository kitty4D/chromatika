import { COINGECKO_IDS } from '@/config/price-feed-registry';

export type MarketData = {
  marketCap: number | null;
  marketCapRank: number | null;
  circulatingSupply: number | null;
  totalSupply: number | null;
  contractAddress: string | null;
  chain: string | null;
};

type CachedMarket = { data: MarketData; fetchedAtMs: number };

const cache = new Map<string, CachedMarket>();
const CACHE_TTL_MS = 10 * 60_000;

export async function getMarketData(symbol: string): Promise<MarketData | null> {
  const cgId = COINGECKO_IDS[symbol.toUpperCase()];
  if (!cgId) return null;

  const hit = cache.get(cgId);
  if (hit && Date.now() - hit.fetchedAtMs < CACHE_TTL_MS) return hit.data;

  try {
    const url = `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(cgId)}?localization=false&tickers=false&community_data=false&developer_data=false&sparkline=false`;
    const r = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!r.ok) return hit?.data ?? null;

    const raw = await r.json() as {
      market_data?: {
        market_cap?: { usd?: number };
        market_cap_rank?: number;
        circulating_supply?: number;
        total_supply?: number;
      };
      platforms?: Record<string, string>;
    };

    const md = raw.market_data;
    const platforms = raw.platforms ?? {};
    const platformEntries = Object.entries(platforms).filter(([, v]) => v?.trim());
    const contractAddress = platformEntries.length > 0 ? platformEntries[0]![1]! : null;
    const chain = platformEntries.length > 0 ? platformEntries[0]![0]! : null;

    const data: MarketData = {
      marketCap: md?.market_cap?.usd ?? null,
      marketCapRank: md?.market_cap_rank ?? null,
      circulatingSupply: md?.circulating_supply ?? null,
      totalSupply: md?.total_supply ?? null,
      contractAddress,
      chain,
    };

    cache.set(cgId, { data, fetchedAtMs: Date.now() });
    return data;
  } catch {
    return hit?.data ?? null;
  }
}
