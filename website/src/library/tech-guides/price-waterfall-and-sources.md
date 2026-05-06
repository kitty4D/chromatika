# price waterfall + sources

chromatika's USD price oracle is a **waterfall**: try sources in user-configured order until one returns a value, cache for ~60s. defaults: CoinGecko → DefiLlama → CoinMarketCap → Pyth → Chainlink → GeckoTerminal. user can reorder via `setPricePreferences`. no SDK imports - pure `fetch()` for off-chain sources, on-chain reads for Pyth / Chainlink.

## the cache

```ts
const cache = new Map<string, { priceUsd: number; fetchedAtMs: number }>();
const CACHE_TTL_MS = 60_000;

async function getPrice(symbol: string): Promise<number> {
  const cached = cache.get(symbol);
  if (cached && Date.now() - cached.fetchedAtMs < CACHE_TTL_MS) {
    return cached.priceUsd;
  }
  const order = await getPricePreferences();
  for (const source of order) {
    try {
      const price = await sourceFns[source](symbol);
      if (price > 0) {
        cache.set(symbol, { priceUsd: price, fetchedAtMs: Date.now() });
        return price;
      }
    } catch (e) {
      // fall through to next source
    }
  }
  throw new Error(`no price for ${symbol}`);
}
```

## CoinGecko

```ts
async function fetchCoingeckoPrice(symbol: string): Promise<number> {
  const id = COINGECKO_IDS[symbol]; // e.g. "ethereum" for "eth"
  if (!id) throw "unknown symbol";
  const resp = await fetch(
    `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`
  );
  const data = await resp.json();
  return data[id]?.usd ?? 0;
}
```

- no API key required (free tier)
- rate-limited (~30 req/min on free tier; chromatika's per-second usage is well under this)
- works for all major assets + many long-tail tokens

## DefiLlama

```ts
async function fetchDefiLlamaPrice(symbol: string): Promise<number> {
  const id = DEFILLAMA_IDS[symbol]; // e.g. "coingecko:ethereum"
  const resp = await fetch(`https://coins.llama.fi/prices/current/${id}`);
  const data = await resp.json();
  return data.coins[id]?.price ?? 0;
}
```

- no API key
- aggregates from CoinGecko + on-chain DEX TWAPs
- slightly slower than CoinGecko but better coverage for DeFi tokens

## CoinMarketCap (key required)

```ts
async function fetchCmcPrice(symbol: string): Promise<number> {
  const apiKey = import.meta.env.VITE_CMC_API_KEY;
  if (!apiKey) return 0; // not configured
  const sym = symbol.toUpperCase();
  const resp = await fetch(
    `https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?symbol=${sym}`,
    { headers: { "X-CMC_PRO_API_KEY": apiKey } }
  );
  const data = await resp.json();
  return data.data?.[sym]?.quote?.USD?.price ?? 0;
}
```

- requires `VITE_CMC_API_KEY` build-time env var
- adds redundancy beyond free tiers
- if not configured, the source is a no-op (returns 0, falls through)

## Pyth (on-chain oracle)

```ts
async function fetchPythPrice(
  symbol: string,
  chain: "solana" | "evm" | "sui" | "aptos"
): Promise<number> {
  const feedId = PYTH_FEED_IDS[chain]?.[symbol];
  if (!feedId) throw "no Pyth feed";
  // Pyth has a "Hermes" service with REST + price update API
  const resp = await fetch(`https://hermes.pyth.network/api/latest_price_feeds?ids[]=${feedId}`);
  const data = await resp.json();
  const feed = data[0];
  return Number(feed.price.price) * Math.pow(10, feed.price.expo);
}
```

- Pyth aggregates publisher-signed prices on-chain across many feeds
- pull-model: clients request the latest price, optionally post the update on-chain to use it in a tx
- Hermes is Pyth's REST gateway for browsers; chromatika uses it for off-chain reads

## Chainlink (EVM-only)

```ts
async function fetchChainlinkPrice(symbol: string, chainId: number): Promise<number> {
  const feedAddr = CHAINLINK_FEEDS[chainId]?.[symbol];
  if (!feedAddr) throw "no Chainlink feed";
  const provider = await getRpcProviderForChain(chainId);
  const aggregator = new ethers.Contract(feedAddr, AGGREGATOR_V3_ABI, provider);
  const [, answer] = await aggregator.latestRoundData();
  const decimals = await aggregator.decimals();
  return Number(answer) / Math.pow(10, decimals);
}
```

- direct on-chain read of Chainlink's `AggregatorV3Interface`
- only works for EVM chains where Chainlink has feeds (mainnet, BNB, Polygon, Arbitrum, etc.)
- accurate + decentralized but slow (one RPC round-trip per asset per call)

## GeckoTerminal (DEX TWAP)

```ts
async function fetchGeckoTerminalPrice(symbol: string): Promise<number> {
  const route = DEX_PRICE_ROUTES[symbol]; // e.g. for IKA: { network, poolAddress }
  if (!route) throw "no DEX route";
  const resp = await fetch(
    `https://api.geckoterminal.com/api/v2/networks/${route.network}/pools/${route.poolAddress}`
  );
  const data = await resp.json();
  return Number(data.data?.attributes?.base_token_price_usd ?? 0);
}
```

- DEX TWAP from GeckoTerminal
- used primarily for IKA (which centralized aggregators don't always carry)
- no API key

## the SUI / IKA peculiarity

IKA price specifically falls to GeckoTerminal because:

- CoinGecko / DefiLlama / CMC don't always list IKA
- Pyth doesn't have a feed today
- Chainlink is EVM-only
- the DEX (Aftermath on Sui) is the canonical price source

so `getPrice('ika')` typically traverses several sources before landing on GeckoTerminal. cache TTL of 60s smooths the noise.

## price preferences API

```ts
getPricePreferences(): { order: string[] }
setPricePreferences({ order: string[] }): void
// order is a list of source ids; first match wins
// must contain at least 1 entry; entries must be unique
```

`setPricePreferences` clears the cache so the new order applies immediately.

## what got dropped

- **Switchboard**: listed in `architecture-final.html` but **explicitly dropped** from `src/config/price-sources.ts`. either remove from architecture-final or implement; tracked
- **on-chain Sui DEX TWAP** beyond GeckoTerminal: not implemented; we read GT instead of querying Sui pools directly. simpler, fewer chain-specific code paths

## library

- `fetch` (browser native)
- `ethers` v6 for the Chainlink on-chain read
- internal: `wallet-extension/src/background/services/price.ts` for `getPrice`, `getPrices`, the cache
- internal: `wallet-extension/src/background/services/price-sources.ts` for individual source implementations + maps
- internal: `wallet-extension/src/config/price-sources.ts` for source ids + default order

## related

- [price-source-priority.md](/library/user/price-source-priority) (user-guides) - the user-facing reorder flow
- [manage-networks.md](/library/user/manage-networks) (user-guides) - active EVM chain (used by Chainlink lookups)
