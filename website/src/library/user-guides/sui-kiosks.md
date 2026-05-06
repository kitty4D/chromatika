# how to use Sui Kiosks

Sui Kiosks are on-chain object containers that hold tradeable items (often NFTs) with optional listings, transfer policies, and royalties. chromatika exposes kiosks owned or managed by an address, the items inside, and the listing / policy state.

## prerequisites

- a Chromatika vault is unlocked
- the active dWallet Vault or the address you query has at least one Sui kiosk (otherwise the list returns empty)
- the active Sui network is the one where your kiosks live (mainnet / testnet)

## options at a glance

- **owned kiosks**: kiosks where the address is the owner
- **managed kiosks**: kiosks the address has manager rights on (different from ownership)
- **per-kiosk data**: items, listings, transfer policies, royalty config
- backed by `@mysten/kiosk` `KioskClient`

## how to list kiosks for an address

1. call `getOwnedKiosks` with `address`
2. response is a list of kiosk ids (both owned and managed where applicable, returned together)

## how to view what's inside a kiosk

1. call `getKioskData` with `kioskId`
2. response is the detailed kiosk state: items list (with display metadata), listings, transfer policies, royalty configs
3. images respect MediaSafetyMode

## how to interact with kiosk items

today chromatika exposes **read** for kiosks. listing items, taking items, transferring kiosk ownership, etc. are part of the kiosk product surface. those calls go through the kiosk client + an `IkaTransaction` PTB (or the dWallet sign path) and surface in the kiosk panel inside NFTs

## notes

- kiosks are currently a panel inside the NFTs surface; promoting kiosks to a dedicated page is tracked future per architecture-final.html
- transfer policies enforce royalty rules at the protocol level - a transfer that doesn't satisfy the policy aborts at simulation. always read the policy before crafting a transfer
- managed kiosks (where you're the manager but not owner) have a different operations set than owned kiosks; kiosk-client surfaces both but distinguishes them in the response
- chromatika runs `KioskClient` on chromatika's vault-shared `SuiGraphQLClient` - kiosk reads ride the same GraphQL transport as the rest of the wallet (no JSON-RPC fallback anywhere)
