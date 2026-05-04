# how to manage the presign pool

ika MPC signing uses **presigns** - signature material precomputed offline so on-line signing is fast. chromatika keeps three pools, refilling them on a schedule. this guide covers querying counts and triggering manual refills.

## prerequisites

- a Chromatika vault is unlocked
- the active dWallet Vault has IKA + SUI (or SOL on Solana base) for presign DKG-style operations
- a dWallet exists for the curve you want to refill

## options at a glance

- **three pools, scoped per active dWallet Vault** (`chromatika_presign_pools_v3_<vaultId>`):
  - `SECP256K1_ECDSA` - EVM, generic ECDSA
  - `SECP256K1_TAPROOT` - BTC P2TR
  - `ED25519_EDDSA` - Sui, Solana, Aptos
- **automatic refill alarm**: every 5 minutes (`chromatika-presign-refill`); low-water = 2, refill count = 3, skipped if locked
- **manual refill**: 1 to 20 entries per call

## how to query presign pool counts

1. call `presignPool`
2. returns counts per pool key for the active vault
3. low or zero counts mean the next sign on that curve will block on a fresh presign

## how to manually refill a specific pool

1. call `replenishPresign` with: `poolKey` (one of the three above), `count` (1-20)
2. the wallet drives the refill against the active dWallet using the corresponding curve
3. on Sui base this is a PTB on `IkaTransaction`; on Solana base it's gRPC

## how to take a presign for signing

1. signing internally calls `takePresign(poolKey)` which pops one entry
2. shorthand `takePresignId()` is an alias for `takePresign('SECP256K1_ECDSA')` since EVM is the default
3. you don't usually call this directly - signing flows do it for you

## notes

- the auto-refill alarm only fires when the wallet is unlocked. if you stay locked, the pools drain
- pools are per active dWallet Vault. switching vaults loads a different pool set; switching back restores the original counts
- presign material counts as DKG-style ika ops, so each refill round needs its IKA + SUI (or SOL) per the dynamic pricing rules - low pool + insufficient funds = signing stalls until you top up
- if you see consistently low pools, increase manual refill frequency or check that the vault is staying unlocked across the alarm cadence
