# how to create a dWallet

a dWallet is the ika MPC wallet (2PC-MPC) that signs on-chain transactions and dapp requests for you. each dWallet is bound to a curve (SECP256K1 for EVM/BTC, ED25519 for Sui/Solana/Aptos). this guide walks the DKG (distributed key generation) and zero-trust accept-share completion path.

## prerequisites

- a Chromatika vault is unlocked
- the active dWallet Vault is funded for DKG fees:
  - **Sui base**: a few IKA + a few SUI on the active dWallet Vault address - exact minimums change with on-chain pricing, see `getRequiredCoinAmounts` (uses pricing from `coordinatorInner.pricing_and_fee_manager.current.pricing_map` with a 10% buffer)
  - **Solana base** (pre-alpha): the in-extension fee-payer keypair has a small SOL balance for ika gRPC `approve_message` fees
- decide which curve you need

## options at a glance

- **curve**: `SECP256K1` (EVM, BTC) or `ED25519` (Sui, Solana, Aptos)
- **base chain**: inherited from the active dWallet Vault (sui or solana)
- **per-curve active dWallet**: you can have multiple dWallets per curve but only one active at a time per curve

## how to run DKG for a new dWallet

1. confirm IKA + SUI (or SOL) balances meet the current minimum via `getRequiredCoinAmounts`
2. submit `createDWallet` with the desired `curve`
3. background calls `requestDWalletDKG` (Sui base via PTB on `IkaTransaction`, Solana base via gRPC). the call needs `&mut Coin<IKA>` + `&mut Coin<SUI>` references on Sui base; split coins are returned to the owner inside the same PTB
4. dynamic pricing is read at PTB build time so a price bump between read and submit doesn't abort with code 1 / 2
5. the DKG output usually lands in `awaiting_key_holder_signature` state - **continue to the accept-share step below**

## how to complete the zero-trust accept-share step

1. monitor state via `dWalletState` (or `refreshDWalletState` to force a re-fetch)
2. once the dWallet sits in `awaiting_key_holder_signature`, run `completeDWalletZeroTrust` with the curve (and optional `dwalletId` if you have multiple in this state)
3. the wallet calls `acceptEncryptedUserShare` on-chain with the encrypted share id from the DKG event - the dWallet transitions to `Active`

## how to set the dWallet active for its curve

1. once the dWallet is `Active`, call `setActiveDwallet` with the `dwalletId` to wire it up as the active signer for its curve
2. dapp connections + sending operations now use this dWallet

## notes

- `requestDWalletDKG` returns a tuple - background reads `dkgResult[0]` (other commands like `requestSign` and `requestReEncryptUserShareFor` return no value, and `requestGlobalPresign` returns a drop-able value). this matters only if you write your own PTBs
- ika dynamic pricing means hardcoded fees abort - always go through `getRequiredCoinAmounts`
- on Solana base, all signatures from a dWallet come from a single mock signer until ika ships production MPC - never use Solana base for real value
- for a Sui-base dWallet to sign on Solana too, you need a Solana-base sibling vault. dWallets do not cross base chains; the same mnemonic on the opposite base produces a different identity
- to recover dWallets that already exist for your mnemonic / key, skip DKG and run `discoverDWallets` (see [manage-dwallets.md](/library/user/manage-dwallets))
