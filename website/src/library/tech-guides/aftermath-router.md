# Aftermath router (Sui swap)

chromatika's **Phase B** SUI → IKA swap is powered by Aftermath's REST router API. zero new npm deps - just `fetch()`. fetch a quote at `/router/trade/route`, then build the tx at `/router/trade/transaction`, deserialize via `Transaction.from(...)`, sign with the HD fee-payer keypair, broadcast on the active Sui RPC.

## the call sequence

```
1. swapStatus / phaseBFundingSpike    - is swap available + active?
2. swapQuote { amountInMist?, slippageBps? }   - get a quote (cached 30s)
3. executeSwap { quoteId, quote }     - build, sign, broadcast (long-running)
```

## the quote call

```ts
async function getAftermathQuote({ amountInMist, slippageBps }) {
  const params = new URLSearchParams({
    coin_in: SUI_TYPE,                                      // '0x2::sui::SUI'
    coin_out: IKA_TYPE,                                     // ika coin object type
    amount_in: amountInMist.toString(),
    slippage: (slippageBps / 100).toString(),               // basis points → percent
  });
  const resp = await fetch(`https://api.aftermath.finance/router/trade/route?${params}`);
  const route = await resp.json();
  return {
    quoteId: route.id,
    amountIn: BigInt(route.amount_in),
    amountOut: BigInt(route.amount_out),
    priceImpact: route.price_impact,
    routeDescription: route.route,
    expiresAtMs: Date.now() + QUOTE_CACHE_TTL_MS,           // 30_000 ms
  };
}
```

returns the route description plus expected output amount + price impact. the route may go through multiple pools (e.g. SUI → wUSDC → IKA) - Aftermath optimizes.

## the build call

```ts
async function buildAftermathTx({ quoteId, quote, sender }) {
  const resp = await fetch('https://api.aftermath.finance/router/trade/transaction', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      route_id: quoteId,
      walletAddress: sender,
      slippage: quote.slippageBps / 100,
    }),
  });
  const data = await resp.json();
  return data.tx_bytes_b64;   // base64-encoded serialized Sui Transaction
}
```

response is a base64-encoded serialized PTB. chromatika deserializes via `Transaction.from(base64Decode(tx_bytes_b64))`, signs with the HD fee-payer Sui keypair, broadcasts.

## the execute path

```ts
async function executeSwap({ quoteId, quote }) {
  const txBytes = await buildAftermathTx({ quoteId, quote, sender: hdFeePayerAddress });
  const tx = Transaction.from(base64Decode(txBytes));

  const sigResult = await suiKeypair.signTransaction(tx, suiGraphQLClient);
  // suiKeypair is the HD fee-payer Ed25519 keypair, NOT a dWallet
  // it signs locally - not via ika MPC

  const result = await suiGraphQLClient.executeTransactionBlock({
    transactionBlock: tx,
    signature: sigResult.signature,
    options: { showEffects: true, showObjectChanges: true },
  });

  return { digest: result.digest, status: result.effects?.status };
}
```

note this signs with the **HD fee-payer keypair**, not a dWallet. swaps fund the fee-payer, not the user identity - so signing them with the HD key (which lives in extension memory) is consistent with the fee-payer's role.

## why HD fee-payer signs (not dWallet)

the swap moves SUI **from the HD fee-payer's address** to receive IKA **at the HD fee-payer's address**. it's a self-transfer through Aftermath's router. the HD fee-payer is the natural signer because:
- it's the address holding the SUI to swap
- it's the address that should receive the IKA
- ika MPC PTBs need IKA to fund DKG / presign / sign; this swap is the "where does that IKA come from" answer

if dWallet-anchored swaps were the design (swap user-facing SUI from a dWallet), that'd be a different flow.

## constants

```ts
MIN_SUI_RESERVE_MIST = 50_000_000n;   // 0.05 SUI minimum reserve in fee-payer
DEFAULT_SLIPPAGE_BPS = 100;            // 1% default slippage
QUOTE_CACHE_TTL_MS = 30_000;           // quote stale after 30s
```

`MIN_SUI_RESERVE_MIST` is a hard floor - the wallet won't let you swap so much that the fee-payer drops below 0.05 SUI. otherwise the next ika op might fail to pay gas.

`DEFAULT_SLIPPAGE_BPS = 100` (1%) is the default; user can override 10-500 bps (0.1%-5%) per call.

## the long-running mutation

`executeSwap` is a **long-running tRPC mutation** with a 20-second keepalive (rather than the default 12s timeout exempted in `src/lib/trpc.ts`). swaps can take longer because:
- Aftermath's `/router/trade/transaction` builds the PTB (slow if the route has many hops)
- network latency to Sui's GraphQL endpoint
- on-chain confirmation can be a few seconds

the 20s keepalive prevents the tRPC port from auto-disconnecting mid-swap.

## degraded modes

- **Aftermath unreachable**: `swapQuote` throws "swap service unavailable"; user sees an error and can retry
- **IKA pool empty / no liquidity** (e.g. fresh testnet deploy): quote returns `amount_out: 0`. UI surfaces "no liquidity" with a manual-fund fallback (send IKA from another source)
- **slippage exceeded**: tx aborts on-chain at the actual swap step. user sees a tx error; retry with higher slippage
- **stale quote**: if `executeSwap` is called >30s after quote, the quote may no longer reflect current pool state. Aftermath may build a tx that fails. user re-quotes

## feature flag

```ts
const enabled = import.meta.env.VITE_PHASE_B_SUI_SWAP === 'true';   // default true today
```

`VITE_PHASE_B_SUI_SWAP` is the build-time gate. default is true; can be disabled by setting `'false'` in env.

## library

- `fetch` (browser native)
- `@mysten/sui` `Transaction.from`, `Ed25519Keypair`, `SuiGraphQLClient`, `executeTransactionBlock`
- internal: `wallet-extension/src/background/services/swap.ts` `swapQuote`, `executeSwap`
- internal: `wallet-extension/src/background/services/swap-config.ts` for constants

## related

- [sui-tx-sign-via-ika.md](/library/tech/sui-tx-sign-via-ika) - the dWallet path (different from the HD fee-payer path used here)
- [sui-graphql-client.md](/library/tech/sui-graphql-client) - the GraphQL transport for execution
- [sui-ika-swap.md](/library/user/sui-ika-swap) (user-guides) - the user-facing flow
