# `SuiGraphQLClient` (Mysten's Sui GraphQL transport)

chromatika prefers `SuiGraphQLClient` (`@mysten/sui` `client.core.*`) for every Sui operation Mysten exposes on GraphQL. JSON-RPC stays for legacy gaps only. ika's `IkaClient` is wired to chromatika's vault-shared `SuiGraphQLClient` - never JSON-RPC for supported paths.

## why GraphQL over JSON-RPC

Mysten is migrating Sui's read API from JSON-RPC to GraphQL. GraphQL:
- single endpoint per network (cleaner than RPC method dispatch)
- structured + typed queries (vs JSON-RPC's stringly-typed methods)
- field selection (only fetch what you need; reduces wire traffic)
- supports complex queries (graph traversal: object owner's other objects, balance changes per address, etc.)

`client.core.*` is the canonical Mysten SDK surface for GraphQL. chromatika builds on this.

## construction

```ts
import { SuiGraphQLClient } from '@mysten/sui/graphql';

const client = new SuiGraphQLClient({
  url: 'https://sui-mainnet.mystenlabs.com/graphql',
});
```

per network:
- mainnet: `https://sui-mainnet.mystenlabs.com/graphql`
- testnet: `https://sui-testnet.mystenlabs.com/graphql`
- devnet: `https://sui-devnet.mystenlabs.com/graphql`

custom networks can override via the network registry (`chromatika_custom_networks_v1`).

## the chromatika wrapper

```ts
function createSuiGraphQLClientFromRegistryNetworkId(): SuiGraphQLClient {
  const tier = sessionState.activeSuiNetworkTier;        // 'vault' or 'dwallet'
  const networkId = tier === 'dwallet'
    ? sessionState.activeDwalletSuiNetworkId
    : sessionState.activeSuiNetworkId;
  const url = SUI_NETWORK_URLS[networkId];
  return new SuiGraphQLClient({ url });
}
```

every read scopes to the right network tier (vault vs dWallet), so a vault-tier op reading "what dWallets exist on Sui mainnet" won't accidentally hit a testnet GraphQL endpoint.

## what we use it for

- ika operations: `IkaClient` is constructed with this client (`IkaClient` 0.3.x runs on `client.core.*` for `ClientWithCoreApi`). DKG, presign, sign, re-encrypt - all over GraphQL
- balance reads: `client.core.getCoins`, `getBalance` etc.
- object reads: `client.core.getObjects`, `multiGetObjects` (chunked 12 at a time per the patch; see below)
- NFT discovery (Sui via Display): `client.core.queryObjects` with `showDisplay: true`
- transaction submission: `client.core.executeTransactionBlock`
- coin pagination: `listCoins` returns `{ objects, hasNextPage, cursor }` (use `for(;;)` with explicit `break`)

## the chunking patch (`@mysten/sui@2.13.2.patch`)

chromatika applies a pnpm patch to `@mysten/sui` 2.13.2 (`wallet-extension/patches/@mysten__sui@2.13.2.patch`). it changes:
- `getObjects` and `multiGetObjects` chunk `objectIds` by **12** (instead of upstream's 50)
- 100ms pause between chunks

reason: the GraphQL POST body grows linearly with the id list. 50 ids per chunk regularly exceeds common ~5000-byte GraphQL body limits at edge proxies. chunking by 12 keeps under the limit; 100ms pause reduces burst rate-limit hits.

bumping `@mysten/sui` requires refreshing the patch. see [mysten-sui-pinning-and-patches.md](/library/tech/mysten-sui-pinning-and-patches).

## what we still use JSON-RPC for

- **activity feed**: `SuiJsonRpcClient.queryTransactionBlocks` because GraphQL `client.core.*` exposes `getTransaction` (by digest) but no filtered / address-scoped list equivalent (yet). on a Mysten SDK bump that adds `client.core.listTransactions` or a `Query.address.transactions` wrapper, migrate. tracked future
- (was: NFT and Sui Kiosk, now both on GraphQL)

if you find any ika or Sui op that's hitting JSON-RPC where GraphQL is available, that's a bug - fix at the call site.

## the per-vault sharing

ika's `IkaClient` constructor takes a `SuiGraphQLClient`. chromatika constructs **one** `SuiGraphQLClient` per session per active network tier and reuses it across:
- ika operations
- direct GraphQL reads (NFTs, balances, etc.)
- Aftermath's swap submission

avoids duplicating connection state, ensures consistent network targeting.

## error handling

GraphQL errors come back in the response body's `errors` array (HTTP 200 even on errors). `SuiGraphQLClient` parses these and throws. wrap with retry logic for transient network errors but not for `errors[].extensions.code === 'invalid_query'` (that's a code bug).

## library

- `@mysten/sui/graphql` `SuiGraphQLClient`
- `@mysten/sui/client` `SuiClient` (the JSON-RPC client; used for activity feed only)
- internal: `wallet-extension/src/background/sui-client.ts` `createSuiGraphQLClientFromRegistryNetworkId`

## related

- [mysten-sui-pinning-and-patches.md](/library/tech/mysten-sui-pinning-and-patches) - the chunking patch + version pinning
- [2pc-mpc-overview.md](/library/tech/2pc-mpc-overview) - the ika client that builds on this transport
- [nft-api-providers.md](/library/tech/nft-api-providers) - NFT reads that use this client
