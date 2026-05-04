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

## notes

- on Solana base (pre-alpha), the actual signature comes from a single mock signer. **never** send real-value SOL on a Solana-base dWallet
- chromatika does **not** add a software signing path that bypasses the dWallet - the dWallet is the user identity. if you want native-SOL sends from an imported keypair without a dWallet, use a hardware-vault flow with the keypair as the hardware account instead
- the dapp `solana_signTransaction` path is separate - it routes through the dapp bridge with origin consent and approval popups (see [connect-dapp.md](/library/user/connect-dapp)); `sendSolanaNative` is the wallet UI direct flow
