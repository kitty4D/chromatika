# how to send native SUI

transfer SUI to another address from the **HD fee-payer** keypair on the active dWallet Vault. note this is **not** the MPC dWallet path - it's the same fee-payer key the wallet uses to fund DKG / presigns / on-chain ika ops.

## prerequisites

- a Chromatika vault is unlocked
- the active dWallet Vault is on Sui base (see [manage-networks.md](/library/user/manage-networks) for switching base chain)
- the active Sui network (mainnet / testnet / devnet) is set; the Sui RPC / GraphQL endpoint is reachable
- the HD fee-payer has enough SUI to cover `amount + gas`

## options at a glance

- **amount**: SUI in human-readable units (the wallet handles MIST conversion)
- **recipient**: any valid Sui address

## how to send

1. confirm the active vault's HD fee-payer address (it's the address that funds ika ops on Sui base)
2. submit `sendSuiNative` with: `to` (recipient address), `amountSui`
3. background builds and submits a Sui transaction via `SuiGraphQLClient` (`client.core.*`), signs with the HD fee-payer keypair (Ed25519, native sui signing), broadcasts
4. tx digest returns once Sui finality is reached (reasonably fast on Sui)

## how to send to a different Sui network

1. switch the active Sui network first via `setActiveSuiNetwork` (with `networkId`, `tier: 'vault'`)
2. then submit `sendSuiNative` - the call uses the active network's GraphQL endpoint

## notes

- this path uses the HD fee-payer, not the dWallet. that means it's not the canonical "user identity" path on Sui - dapp connections + on-chain identity go through dWallets. the fee-payer is the gas key
- if you want to send SUI **from** a Sui-anchored dWallet's address (the user-facing identity), that's a Sui-base dWallet sign flow, not `sendSuiNative`. today the wallet UI exposes `sendSuiNative` for HD fee-payer sends; dWallet-based Sui sends route through the dapp / sign flows
- chromatika prefers GraphQL for any Sui call Mysten exposes on `client.core.*`. JSON-RPC stays for legacy code paths only. activity feed is one of the remaining JSON-RPC users (no GraphQL `listTransactions` yet)
