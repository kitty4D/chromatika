# how to set MediaSafetyMode

`MediaSafetyMode` controls how chromatika renders NFT images, Bitcoin Ordinal media, and Sui kiosk item images. it filters at the HTTP request layer, not at the cache layer.

## prerequisites

- a Chromatika vault is unlocked

## options at a glance

- **`all`**: render any image URL the indexer returns (no filtering)
- **`ipfs-arweave`** (default): only render images whose URL resolves to an IPFS or Arweave gateway. blocks arbitrary HTTP image hosts
- **`none`**: do not load images at all - text + metadata only

## how to read the current mode

1. call `getMediaSafetyMode`
2. response is one of the three options above

## how to change the mode

1. submit `setMediaSafetyMode` with the chosen mode
2. takes effect immediately for new requests; in-flight loads complete with the prior policy

## notes

- enforcement is **in-request only** today. there's no offscreen media cache yet (target only - manifest does not request `offscreen` permission until that ships)
- this affects: Sui NFTs (`getSuiNfts`), EVM NFTs (`getEvmNfts`), Solana NFTs (`getSolanaNfts`), Aptos NFTs (`getAptosNfts`), Bitcoin Ordinals (`getBtcOrdinals`), and Sui kiosk items (`getKioskData`)
- if you change mode while browsing NFTs, refresh the relevant list to see the new policy applied
- IPFS / Arweave rendering does not validate content - it validates the URL host. content authenticity is still on the user
