# how to swap SUI for IKA

chromatika ships a SUI → IKA swap powered by the Aftermath router on Sui. you fetch a quote, then execute. this is the **Phase B** swap path; it's feature-flagged behind `VITE_PHASE_B_SUI_SWAP` (default true today, so it's effectively shipped).

## prerequisites

- a Chromatika vault is unlocked
- the active dWallet Vault is on Sui base
- the active vault has SUI (above the minimum reserve) and you want IKA in return
- Aftermath router endpoints are reachable (`/router/trade/route` + `/router/trade/transaction`)
- `VITE_PHASE_B_SUI_SWAP` is enabled in the build (default: true)

## options at a glance

- **slippage**: 10 to 500 basis points (default 100 bps = 1%)
- **amount**: SUI in MIST (`amountInMist`) - optional input; the wallet can quote for a default fraction of available SUI if you don't supply
- **min reserve**: 50,000,000 MIST (0.05 SUI) is reserved on the vault for gas - the swap won't drain past this
- **quote cache**: 30 second TTL; quotes go stale fast in volatile markets

## how to check swap readiness

1. call `phaseBFundingSpike` to see if the swap is enabled and the spike is active
2. or call `swapStatus` for a richer snapshot - returns swap capability, balance info, spike status

## how to fetch a quote

1. submit `swapQuote` with `amountInMist` (optional) and `slippageBps` (10-500, default 100)
2. response includes: route description, expected IKA out, price impact, quote id, expiry
3. quote id is the handle to feed into `executeSwap`. quotes go stale after 30 seconds

## how to execute a quote

1. submit `executeSwap` with `quoteId` and the quote object
2. **long-running mutation** - 20s keepalive on the tRPC port (`src/lib/trpc.ts` exempts swap execution from the 12s default)
3. background fetches the serialized PTB from Aftermath (`/router/trade/transaction`), deserializes via `Transaction.from()`, signs with the active Sui keypair, broadcasts on the active Sui RPC
4. tx digest returns once Sui confirms. failure returns an actionable reason (insufficient funds, quote expired, slippage too tight, etc.)

## how to handle "swap is down" or empty IKA pool

the swap path degrades gracefully:

- if Aftermath is unreachable, `swapQuote` returns an error and the surface tells the user to fund manually
- if the IKA pool has no liquidity (e.g. a fresh testnet deploy), the quote returns zero-output and the surface offers manual funding instructions

## notes

- this is a SUI → IKA path only today. multichain funding aggregation (cross-chain bridging) is tracked as future (`docs/future/FUNDING_STRATEGY.md`)
- the swap signs with `suiKeypair` (HD fee-payer), not the dWallet. that's intentional - swaps fund the fee-payer, not the user identity
- minimum reserve `MIN_SUI_RESERVE_MIST = 50_000_000n` is a hard floor in `swap-config.ts` - the wallet will not let you swap below it
- `DEFAULT_SLIPPAGE_BPS = 100` and `QUOTE_CACHE_TTL_MS = 30_000` are also constants in `swap-config.ts`
