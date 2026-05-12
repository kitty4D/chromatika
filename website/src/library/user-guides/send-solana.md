# how to send native SOL

transfer SOL to another address from your active ED25519 dWallet on Solana. the dWallet is the canonical Solana identity for chromatika - this is the user-facing send path.

## prerequisites

- a Chromatika vault is unlocked
- the active dWallet has ED25519 (otherwise create one - see [create-dwallet.md](/library/user/create-dwallet))
- the active Solana network (mainnet / devnet) is set, RPC reachable
- the active dWallet's Solana address has enough SOL to cover `amount + fees`
- if your active dWallet Vault uses Solana base (pre-alpha), the in-extension fee-payer also has SOL for ika gRPC `approve_message` fees - see [ika-fee-management.md](/library/user/ika-fee-management)

## options at a glance

- **amount**: SOL in human-readable units (lamports conversion handled internally)
- **recipient**: any valid base58 Solana address
- **base chain**: works on both Sui base (sign via Sui-anchored ED25519 dWallet that has a Solana address) and Solana base (pre-alpha mock signer)

## how to send

1. confirm the active dWallet's Solana address with `getSolanaAddress`
2. submit `sendSolanaNative` with: `to`, `amountSol`
3. background builds a Solana versioned transaction, signs via ika MPC against the ED25519 dWallet, broadcasts on the active RPC
4. signature / tx id returns once landed

## how to send to a different Solana network

1. switch network first via `setActiveSolanaNetwork` with `networkId` and `tier: 'dwallet'`
2. submit `sendSolanaNative`

## how to send SPL tokens

transfer any SPL token (USDC, USDT, custom mints, etc.) from the active dWallet's Solana address. the wallet builds a two-instruction transaction: create the recipient's Associated Token Account if it doesn't exist, then transfer tokens.

### prerequisites (in addition to the general prerequisites above)

- the active dWallet's Solana address holds a balance of the SPL token you want to send
- you know the token's **mint address** (base58)

### options

- **mint**: the SPL token mint address (base58)
- **amount**: human-readable decimal string (e.g. `"1.5"` for 1.5 USDC) - conversion to base units (using the mint's decimals) is handled internally by `parseDecimalSplToBaseUnits`
- **recipient**: any valid base58 Solana address

### steps

1. from the send page, select the SPL token from the token dropdown (the wallet fetches your SPL balances and lists them alongside native SOL)
2. submit `sendSplToken` with: `to`, `mint`, `amount`
3. background builds a versioned transaction with two instructions:
   - `CreateAssociatedTokenAccountIdempotent` - opens the recipient's ATA for the mint if it doesn't already exist (idempotent, so it's safe even if the ATA exists)
   - SPL Token `Transfer` (instruction discriminator `3`) - moves `amountRaw` base units from the sender's ATA to the recipient's ATA
4. signs via ika MPC against the ED25519 dWallet, broadcasts on the active Solana RPC
5. confirmation uses `confirmSolanaTxByPolling` (HTTP polling, not websockets) with a progress banner
6. the signed transaction is recorded in `chromatika_signed_txs_v1` for the activity feed

### notes on SPL sends

- the sender pays for ATA creation rent (~0.002 SOL) if the recipient doesn't already have an ATA for that mint
- Token-2022 (token extensions) is **not** supported by this flow today - only classic SPL Token program transfers
- decimal parsing handles up to the mint's declared decimals (e.g. 6 for USDC, 9 for wrapped SOL)

## notes

- on Solana base (pre-alpha), the actual signature comes from a single mock signer. **never** send real-value SOL on a Solana-base dWallet
- chromatika does **not** add a software signing path that bypasses the dWallet - the dWallet is the user identity. if you want native-SOL sends from an imported keypair without a dWallet, use a hardware-vault flow with the keypair as the hardware account instead
- the dapp `solana_signTransaction` path is separate - it routes through the dapp bridge with origin consent and approval popups (see [connect-dapp.md](/library/user/connect-dapp)); `sendSolanaNative` is the wallet UI direct flow
