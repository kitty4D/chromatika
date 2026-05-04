# how to configure price source priority

chromatika fetches USD prices through a waterfall of sources. you can reorder the waterfall to prefer one source over another. caches invalidate when the order changes so the new ranking applies immediately.

## prerequisites

- a Chromatika vault is unlocked
- if you want CoinMarketCap in the rotation, the build needs `VITE_CMC_API_KEY`

## options at a glance

- **available sources** (today): CoinGecko, DefiLlama, CoinMarketCap, Pyth, Chainlink (EVM proxy feeds), GeckoTerminal DEX TWAP (used for IKA)
- **default order**: CoinGecko → DefiLlama → CoinMarketCap → Pyth → Chainlink → GeckoTerminal
- **cache**: ~60 second TTL per source per symbol
- **Switchboard** is in the architecture comments but explicitly **dropped** from the current waterfall

## how to read the current order

1. call `getPricePreferences`
2. response is the ordered list of source ids

## how to set a new order

1. submit `setPricePreferences` with the desired ordered array (must contain at least one id, and ids must be unique)
2. caches clear; the new ordering applies on the next price fetch

## how to fetch a price (single)

1. call `getPrice` with `symbol` (e.g. `'sui'`, `'eth'`, `'btc'`, `'ika'`)
2. wallet walks the configured waterfall, returns the first successful USD value
3. failure across all sources surfaces an error; CoinGecko or DefiLlama almost always succeed for major assets

## how to fetch prices in batch

1. call `getPrices` with `symbols` (array)
2. same waterfall logic, parallelized across symbols where possible

## notes

- CoinGecko works without an API key but has rate limits. CoinMarketCap requires `VITE_CMC_API_KEY` in the build to participate
- BTC fiat conversion is sourced off-chain through this waterfall; everything else can use either the off-chain sources or the on-chain ones (Pyth, Chainlink)
- IKA price specifically falls to GeckoTerminal DEX TWAP since the centralized aggregators rarely have it. don't expect deep liquidity on that
- data services (price + NFT + kiosk) are described in architecture-final.html. the waterfall here is the real implementation - architecture's longer "target" list is for future hardening
