# `SuiGraphQLClient` (Mysten's Sui GraphQL transport)

chromatika uses `SuiGraphQLClient` (`@mysten/sui` `client.core.*`) for **every** Sui operation. the wallet no longer talks Mysten JSON-RPC at all - the migration completed 2026-05-01. ika + nft + kiosk + activity + SuiNS all ride one vault-shared `SuiGraphQLClient`, with hand-rolled queries via `client.query` for the small set of reads the SDK doesn't yet wrap.

## why GraphQL over JSON-RPC

Mysten is migrating Sui's read API from JSON-RPC to GraphQL. GraphQL:

- single endpoint per network (cleaner than RPC method dispatch)
- structured + typed queries (vs JSON-RPC's stringly-typed methods)
- field selection (only fetch what you need; reduces wire traffic)
- supports complex queries (graph traversal: object owner's other objects, balance changes per address, etc.)

`client.core.*` is the canonical Mysten SDK surface for GraphQL. chromatika builds on this.

## construction

```ts
import { SuiGraphQLClient } from "@mysten/sui/graphql";

const client = new SuiGraphQLClient({
  url: "https://sui-mainnet.mystenlabs.com/graphql",
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
  const tier = sessionState.activeSuiNetworkTier; // 'vault' or 'dwallet'
  const networkId =
    tier === "dwallet" ? sessionState.activeDwalletSuiNetworkId : sessionState.activeSuiNetworkId;
  const url = SUI_NETWORK_URLS[networkId];
  return new SuiGraphQLClient({ url });
}
```

every read scopes to the right network tier (vault vs dWallet), so a vault-tier op reading "what dWallets exist on Sui mainnet" won't accidentally hit a testnet GraphQL endpoint.

## what we use it for

- ika operations: `IkaClient` is constructed with this client (`IkaClient` 0.3.x runs on `client.core.*` for `ClientWithCoreApi`). DKG, presign, sign, re-encrypt - all over GraphQL
- balance reads: `client.core.getCoins`, `getBalance` etc.
- object reads: `client.core.getObjects`, `multiGetObjects` (auto-chunked 12 at a time via the runtime wrapper described below)
- NFT discovery (Sui via Display): `client.core.queryObjects` with `showDisplay: true`
- transaction submission: `client.core.executeTransactionBlock`
- coin pagination: `listCoins` returns `{ objects, hasNextPage, cursor }` (use `for(;;)` with explicit `break`)
- activity feed: `queryTransactionBlocksGraphQL` (hand-rolled `client.query` wrapper at `sui-client.ts:queryTransactionBlocksGraphQL`) for filtered / address-scoped tx lists - covers the gap until Mysten ships a `client.core.listTransactions` wrapper

## the chunking wrapper (`installGetObjectsChunking`)

`@mysten/sui`'s default `client.core.getObjects` batches 50 object ids per POST. that overruns common ~5000-byte GraphQL body limits at edge proxies and triggers burst rate-limits. chromatika fixes this **at runtime** instead of patching the SDK:

```ts
// wallet-extension/src/background/sui-client.ts
function installGetObjectsChunking(client: SuiGraphQLClient): void {
  const orig = client.core.getObjects.bind(client.core);
  client.core.getObjects = async (input) => {
    // chunk input.ids 12 at a time, sleep 100ms between chunks, merge results
    ...
  };
}
```

applied to **every** `new SuiGraphQLClient(...)` site (ika client, vault client, kiosk client, etc.). the wrapper is version-agnostic, so bumping `@mysten/sui` doesn't require any extra setup - the wallet rides whatever upstream version `package.json` overrides specify.

## hand-rolled queries via `client.query`

the SDK doesn't yet wrap every Sui read chromatika needs (filtered / scoped tx lists, for example). pattern at `sui-client.ts:queryTransactionBlocksGraphQL`:

```ts
const res = await client.query({
  query: gql`
    query QueryTxs($filter: TransactionBlockFilter, $limit: Int) {
      transactionBlocks(filter: $filter, first: $limit) { nodes { digest, ... } }
    }
  `,
  variables: { filter, limit },
});
```

if a future surface needs a Sui read GraphQL doesn't yet expose, write a `client.query` wrapper at the `SuiGraphQLClient` construction boundary. **don't** reach for `SuiJsonRpcClient` - it's not in the wallet anymore.

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
- internal: `wallet-extension/src/background/sui-client.ts` `createSuiGraphQLClientFromRegistryNetworkId`, `installGetObjectsChunking`, `queryTransactionBlocksGraphQL`

## related

- [2pc-mpc-overview.md](/library/tech/2pc-mpc-overview) - the ika client that builds on this transport
- [nft-api-providers.md](/library/tech/nft-api-providers) - NFT reads that use this client
