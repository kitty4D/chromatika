# how to browse NFTs

list the NFTs your active dWallet (or any address you specify) owns, per chain. backed by chain-specific indexers; respects MediaSafetyMode for image rendering.

## prerequisites

- a Chromatika vault is unlocked
- API keys configured for the chains you want full coverage on:
  - **EVM**: `VITE_ALCHEMY_KEY` (otherwise EVM NFT lists return empty)
  - **Solana**: `VITE_HELIUS_KEY` (otherwise Solana NFT lists return empty)
  - Sui, Aptos, Bitcoin Ordinals work without keys
- the address you're querying (defaults to the active dWallet's per-chain address; can also pass any address)

## options at a glance

- **per chain** discovery functions:
  - Sui: on-chain reads + Display
  - EVM: Alchemy
  - Solana: Helius DAS
  - Aptos: Token v2 indexer
  - Bitcoin: Hiro Ordinals
- **MediaSafetyMode** filters image rendering at the request layer (see [media-safety-mode.md](/library/user/media-safety-mode))
- **API hints**: read `getNftApiHints` to know which keys are configured

## how to list Sui NFTs for an address

1. call `getSuiNfts` with `address`
2. response is the NFT list with metadata + image URLs (filtered by MediaSafetyMode)
3. uses `client.core.*` (GraphQL) on chromatika's vault-shared `SuiGraphQLClient` - no JSON-RPC anywhere

## how to list EVM NFTs for an address on a chain

1. call `getEvmNfts` with `address` and `chainId`
2. response uses Alchemy. without `VITE_ALCHEMY_KEY` the call returns empty (no error) - check `getNftApiHints` to see if the key is set
3. `chainId` lets you query NFTs on a specific EVM network independent of the active EVM chain

## how to list Solana NFTs for an address

1. call `getSolanaNfts` with `address`
2. response uses Helius DAS. without `VITE_HELIUS_KEY` the call returns empty
3. supports compressed NFTs through Helius DAS

## how to list Aptos NFTs for an address

1. call `getAptosNfts` with `address`
2. response uses the Token v2 indexer (no key required)

## how to list Bitcoin Ordinals for an address

1. call `getBtcOrdinals` with `address`
2. response uses the Hiro Ordinals indexer (no key required)
3. Ordinals are inscriptions, not NFTs in the traditional sense - the metadata shape is Ordinal-specific

## how to know which APIs are configured

1. call `getNftApiHints`
2. response is `{ alchemyConfigured: boolean, heliusConfigured: boolean }`
3. surfaces use this to display "API key required" hints when the relevant chain returns empty

## notes

- chromatika does not cache NFT lists across sessions today (no offscreen media cache yet - tracked future). every call hits the indexer
- MediaSafetyMode `none` will return the metadata but skip loading images. `ipfs-arweave` (default) only renders IPFS / Arweave URLs. `all` renders everything
- if you want NFTs across multiple addresses (e.g. you have several dWallets), call the per-chain function once per address - there's no batch primitive
- transferring NFTs is per-chain native: EVM via `sendEvmTx` calldata, Sui via dWallet sign + `IkaTransaction`, etc. there's no NFT-specific transfer wrapper today
