# how to manage dWallets

operations on dWallets that already exist (created or discovered) - listing, switching active, naming, ordering, looking up addresses, registering the encryption key for share transfers.

## prerequisites

- a Chromatika vault is unlocked
- at least one dWallet exists or can be discovered for the active vault

## options at a glance

- **discover**: scan the chain for dWallets owned by your derived addresses
- **set active**: per curve, choose which dWallet drives signing
- **list owned caps**: enumerate all dWallet capabilities for the vault
- **address book / chain addresses**: derive every supported chain address for one dWallet (or look up active addresses for both curves)
- **display name**: free-form per-dWallet label
- **card order**: explicit ordering for the dWallet list
- **register encryption key**: required before you can receive a transferred dWallet

## how to discover dWallets that already exist on-chain

1. call `discoverDWallets` per curve (`SECP256K1` and `ED25519`)
2. the wallet walks the chain (Sui via GraphQL `client.core.*`, Solana via pre-alpha gRPC) for dWallets your derived addresses own and adds them to the local list
3. some dWallets may be returned in `awaiting_key_holder_signature` state - run `completeDWalletZeroTrust` for those

## how to list active dWallet capabilities

1. call `listOwnedDWalletCaps` (returns the dWallet card list with curve, status, addresses, and metadata)
2. use this for any UI / agent that needs the full picture

## how to set the active dWallet per curve

1. call `setActiveDwallet` with `dwalletId`
2. the curve is inferred from the dWallet record. only one dWallet is active per curve at a time
3. dapp bridge re-emits account-changed events to connected origins

## how to look up addresses

- for both curves on the active vault: `dwalletAddressBook` returns SECP256K1 (EVM + BTC) and ED25519 (Sui + Solana + Aptos) addresses
- for any specific dWallet: `getDwalletChainAddresses` with `dwalletId` returns BTC (P2WPKH + P2TR), EVM, Solana, Sui, and Aptos addresses
- for individual chains on the active vault: `getEvmAddress`, `getSolanaAddress`, `getAptosAddress`, `getBtcAddresses` (with `network: 'mainnet' | 'testnet'`)

## how to set a display name

1. call `setDwalletDisplayName` with `dwalletId` and `name` (max 64 chars)
2. read all current names with `getDwalletDisplayNames`
3. names are scoped to the active vault and persist in vault storage

## how to reorder dWallet cards

1. call `getDwalletCardOrder` to read the current order
2. call `setDwalletCardOrder` with the desired ordered list of dWallet ids
3. missing ids are auto-filled, unmentioned ids sorted to the end

## how to register an encryption key for receiving transfers

1. call `registerEncryptionKey` with the curve - this registers your encryption keypair on-chain so other users can encrypt a share to you when transferring a dWallet
2. read status with `getSenderEncryptionKeyAddress` (returns the address of your registered encryption key)
3. without registration, you cannot receive a transferred dWallet (see [transfer-dwallet.md](/library/user/transfer-dwallet))

## how to query dWallet state

- `dWalletState` with curve - returns the current lifecycle state for the active dWallet on that curve
- `refreshDWalletState` to force a chain re-fetch
- the most common transient state is `awaiting_key_holder_signature` between DKG and accept-share

## how to sync dWallet meta to chrome.storage

1. call `syncVaultMeta` if you've poked at session-only state and want the persisted overlay (`chromatika_dwallet_meta_v2_<vaultId>`) refreshed
2. usually not needed - normal flows persist as they go

## notes

- dWallet meta is per vault: `chromatika_dwallet_meta_v2_<vaultId>` in chrome.storage. switching vaults loads a different overlay
- `DWalletMeta.baseChain` is **required** when initializing new entries; `getIkaAdapter` reads this to dispatch the right adapter (Sui PTB vs Solana gRPC)
- `SolanaIkaAdapter` still throws on Sui-only reads (`getPresignInParticularState`, `getEncryptedUserSecretKeyShare`, `getSign`, `executeTx`); DKG + sign on Solana base bypass the adapter and go through `SolanaIkaGrpcClient` directly
- always set the base chain on `DWalletMeta` so adapter dispatch works
