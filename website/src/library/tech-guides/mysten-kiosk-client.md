# `@mysten/kiosk` `KioskClient`

Sui Kiosks are on-chain object containers that hold tradeable items (often NFTs) with optional listings, transfer policies, and royalties. chromatika exposes Kiosk reads via `@mysten/kiosk` `KioskClient` - listing kiosks owned / managed by an address, fetching items, transfer policies, royalty configs.

## construction

```ts
import { KioskClient, Network } from '@mysten/kiosk';

const kioskClient = new KioskClient({
  client: suiGraphQLClient,                                 // shares the vault SuiGraphQLClient
  network: activeNetwork === 'mainnet' ? Network.MAINNET : Network.TESTNET,
});
```

the `client` parameter accepts `SuiClient` or `SuiGraphQLClient` (per `@mysten/kiosk` 1.2.x). chromatika passes the GraphQL client.

## what we expose

- `getOwnedKiosks(address)` - kiosks owned by an address (returns kiosk ids)
- `getKioskData(kioskId)` - items in a kiosk + listings + transfer policy

## listing kiosks

```ts
async function getOwnedKiosks({ address }) {
  const result = await kioskClient.getOwnedKiosks({ address });
  return result.kioskIds;
}
```

returns kiosk ids the address controls. note: "owned" includes both owned kiosks (the address is the owner) and **managed** kiosks (the address has manager rights, e.g. a transfer policy creator). the response distinguishes if needed.

## fetching kiosk contents

```ts
async function getKioskData({ kioskId }) {
  const data = await kioskClient.getKioskById({
    id: kioskId,
    options: {
      withObjects: true,
      withListings: true,
      withTransferPolicy: true,
    },
  });
  return {
    kioskId,
    items: data.items.map(item => ({
      objectId: item.objectId,
      type: item.type,
      display: item.display,                                // Display protocol metadata
      isLocked: item.isLocked,
      listing: item.listing,                                // null if not listed
    })),
    transferPolicies: data.transferPolicies,
  };
}
```

each item carries:
- object id + type
- Display protocol metadata (name, image, description from on-chain Display::Display)
- locked status (locked items can't be taken without satisfying transfer policy)
- listing info if the item is listed for sale (price, listing id)

## transfer policies + royalties

a transfer policy is a Move object that defines rules for transferring items of a specific type out of a kiosk. typical rules:
- royalty (e.g. 5% of sale price to a designated address)
- floor price (refuse listings below a min)
- cooldown (refuse re-listings within N hours of last sale)

chromatika exposes the policy info so the UI can display "this NFT has a 5% royalty" before the user lists or transfers.

## what chromatika doesn't expose today

- **listing items for sale**: the `place_and_list` PTB call
- **taking items**: the `purchase` PTB call (must satisfy transfer policy)
- **creating new kiosks**: `kiosk::new` PTB call
- **transferring kiosk ownership**: less common operation

these are read-only kiosk ops in the current chromatika surface. write ops are in the kiosk product surface roadmap; the calls go through the kiosk client + an `IkaTransaction` PTB (or the dWallet sign path).

## the patched chunking

per [mysten-sui-pinning-and-patches.md](/library/tech/mysten-sui-pinning-and-patches), `@mysten/sui` GraphQL `getObjects` / `multiGetObjects` chunks object ids by 12 (not 50). this affects KioskClient indirectly because Kiosk reads do a lot of multi-object lookups (items + listings + display) - the chunking smooths over GraphQL body-size limits.

## the future "dedicated page" intent

per architecture-final.html, kiosks should eventually be a top-level UI tab rather than a panel inside NftsPage. tracked as future. doesn't affect the underlying KioskClient calls; only the UI layout.

## library

- `@mysten/kiosk` `KioskClient`, `Network` enum
- `@mysten/sui/graphql` `SuiGraphQLClient` (passed to KioskClient)
- internal: `wallet-extension/src/background/services/sui-kiosk.ts` for `getOwnedKiosks`, `getKioskData`

## related

- [sui-graphql-client.md](/library/tech/sui-graphql-client) - the underlying transport
- [nft-api-providers.md](/library/tech/nft-api-providers) - NFT discovery that overlaps with kiosk items
- [sui-kiosks.md](/library/user/sui-kiosks) (user-guides) - the user-facing flow
