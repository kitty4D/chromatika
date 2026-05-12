# NFT API providers (Alchemy, Helius, Hiro, Mysten Display, Aptos Indexer)

chromatika reads NFTs per chain from chain-specific indexers. no unified SDK - direct REST per provider. respects MediaSafetyMode at the URL-rendering layer (see [media-safety-mode.md](/library/user/media-safety-mode) user-guide).

## Sui (Mysten Display + GraphQL)

```ts
async function getSuiNfts({ address }) {
  // Sui's own GraphQL exposes object listings + on-chain Display protocol
  const client = createSuiGraphQLClientFromRegistryNetworkId();
  const response = await client.queryObjects({
    filter: { ObjectOwner: address },
    options: { showDisplay: true, showContent: true, showType: true },
  });
  // each object can have a Display::Display { name, image_url, ... } field
  return response.data.map(obj => ({
    objectId: obj.objectId,
    name: obj.display?.data?.name,
    imageUrl: obj.display?.data?.image_url,
    type: obj.type,
  }));
}
```

- no API key; Sui's GraphQL is the source of truth
- Display protocol is Sui's on-chain NFT metadata standard
- chunked by 12 object ids per query (per the `@mysten/sui` patch; see [mysten-sui-pinning-and-patches.md](/library/tech/mysten-sui-pinning-and-patches))

## EVM (Alchemy)

```ts
async function getEvmNfts({ address, chainId }) {
  const apiKey = import.meta.env.VITE_ALCHEMY_KEY;
  if (!apiKey) return [];   // empty when not configured
  const network = ALCHEMY_NETWORKS[chainId];   // e.g. "eth-mainnet"
  const resp = await fetch(
    `https://${network}.g.alchemy.com/nft/v3/${apiKey}/getNFTsForOwner?owner=${address}`
  );
  const data = await resp.json();
  return data.ownedNfts.map(nft => ({
    contract: nft.contract.address,
    tokenId: nft.tokenId,
    name: nft.name,
    imageUrl: nft.image?.cachedUrl ?? nft.image?.originalUrl,
  }));
}
```

- requires `VITE_ALCHEMY_KEY` build-time env var
- without the key, `getEvmNfts` returns empty array (no error, just no data)
- supports mainnet ETH, Polygon, Arbitrum, Optimism, Base, etc. via Alchemy's per-network subdomains
- check `getNftApiHints` to see if `alchemyConfigured: true` in the running build

## Solana (Helius DAS API)

```ts
async function getSolanaNfts({ address }) {
  const apiKey = import.meta.env.VITE_HELIUS_KEY;
  if (!apiKey) return [];
  const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;
  const resp = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: '1',
      method: 'getAssetsByOwner',
      params: { ownerAddress: address, page: 1, limit: 100 },
    }),
  });
  const data = await resp.json();
  return data.result.items.map(asset => ({
    id: asset.id,
    name: asset.content?.metadata?.name,
    imageUrl: asset.content?.files?.[0]?.uri,
    compressed: asset.compression?.compressed === true,
  }));
}
```

- requires `VITE_HELIUS_KEY`
- without the key, returns empty
- DAS (Digital Asset Standard) covers regular SPL NFTs **and compressed NFTs** (cNFTs)
- compressed NFT support is the main reason chromatika picked Helius over alternatives

## Bitcoin (Hiro Ordinals)

```ts
async function getBtcOrdinals({ address }) {
  const resp = await fetch(`https://api.hiro.so/ordinals/v1/inscriptions?address=${address}`);
  const data = await resp.json();
  return data.results.map(insc => ({
    inscriptionId: insc.id,
    inscriptionNumber: insc.number,
    contentType: insc.content_type,
    contentUrl: `https://api.hiro.so/ordinals/v1/inscriptions/${insc.id}/content`,
  }));
}
```

- no API key (Hiro provides free tier)
- Ordinals are bitcoin inscriptions (text, image, video, etc. embedded in tx witness data)
- not "NFTs" in the SPL or ERC-721 sense; the metadata model is different

## Aptos (Token v2 indexer)

```ts
async function getAptosNfts({ address }) {
  const network = activeAptosNetwork === 'mainnet' ? 'mainnet' : 'testnet';
  const resp = await fetch(`https://api.${network}.aptoslabs.com/v1/accounts/${address}/resources`);
  // aptos token v2 indexer offers structured queries via a GraphQL endpoint:
  const gql = await fetch(`https://api.${network}.aptoslabs.com/v1/graphql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: `query { current_token_ownerships_v2(where: {owner_address: {_eq: "${address}"}}) { ... } }`,
    }),
  });
  const data = await gql.json();
  return data.data.current_token_ownerships_v2.map(t => ({ ... }));
}
```

- no API key (Aptos public-tier indexer)
- Token v2 is the Move standard for NFTs on Aptos
- separate from Token v1 (legacy) which most modern collections don't use

## the MediaSafetyMode filter

after retrieving NFT URLs, chromatika applies `MediaSafetyMode`:
- `'all'`: render everything
- `'ipfs-arweave'` (default): only render URLs whose host resolves to IPFS or Arweave gateways (includes a known-gateway allowlist)
- `'none'`: don't load images at all (text + metadata only)

filtering happens at the `<img src=...>` rendering layer, not at the API call. metadata is returned regardless; the image just doesn't load if blocked.

## the API hints helper

```ts
getNftApiHints(): { alchemyConfigured: boolean, heliusConfigured: boolean }
```

returns whether the build has the keys for Alchemy / Helius. UI surfaces use this to display "API key required" hints when the relevant chain returns empty results.

## why no SDKs

each provider has its own SDK (`alchemy-sdk-js`, `helius-sdk`, etc.). chromatika uses raw `fetch` because:
- bundle size: each SDK adds ~100-500 KB; multiplied across 5 providers, that's a lot
- features we use are tiny (one or two endpoints per provider)
- minimal abstraction layer - direct understanding of what the wire calls look like

if a provider requires sophisticated features (websockets, complex pagination, signature schemes), we'd reconsider. for read-only NFT lists, raw fetch wins.

## library

- `fetch` (browser native)
- `@mysten/sui` GraphQL client (for Sui Display reads)
- internal: `wallet-extension/src/background/services/nft.ts` orchestration
- internal: `wallet-extension/src/background/services/sui-nft.ts`, `evm-nft.ts`, `solana-nft.ts`, `aptos-nft.ts`, `bitcoin-ordinals.ts` per-chain
- internal: `wallet-extension/src/config/nft-api.ts` for the network maps + key resolution

## related

- [media-safety-mode.md](/library/user/media-safety-mode) (user-guides) - the URL filtering
- [sui-graphql-client.md](/library/tech/sui-graphql-client) - the Sui GraphQL transport
- [mysten-sui-pinning-and-patches.md](/library/tech/mysten-sui-pinning-and-patches) - the 12-id chunking patch
- [browse-nfts.md](/library/user/browse-nfts) (user-guides) - the user-facing surface
