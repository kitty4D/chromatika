# how to stake IKA

stake IKA tokens with an Ika network validator, view your staked positions, and withdraw stake. validators are listed on-chain; stake is held in a `StakedIka` object that you withdraw from when ready.

## prerequisites

- a Chromatika vault is unlocked
- the active dWallet Vault is on Sui base
- the vault has IKA + SUI to cover stake amount + gas (use `getRequiredCoinAmounts` for current minimums)
- a dWallet exists on the active vault for signing the stake / withdraw PTBs

## options at a glance

- **stake amount**: in IKA base units (the wallet handles unit conversion)
- **validator**: chosen from `ikaStakingValidators`
- **withdraw**: per `StakedIka` object id

## how to list active Ika validators

1. call `ikaStakingValidators`
2. response is the validator list with ids, commissions, names where available

## how to list your current staked positions

1. call `ikaStakingPositions`
2. response is your `StakedIka` positions: validator id, staked amount, epoch start, etc.

## how to stake IKA with a validator

1. choose a validator from the list
2. submit `ikaStake` with `validatorId` and `amountBaseUnits`
3. background builds a staking PTB on `IkaTransaction`, requires SECP256K1 dWallet sign (signing-progress popup may appear via `signingProgress`), broadcasts on Sui
4. once landed, the new position appears in `ikaStakingPositions`

## how to withdraw stake

1. submit `ikaWithdrawStake` with the `stakedIkaObjectId` of the position you want to unwind
2. background builds the unstake PTB, signs, broadcasts. claims rewards if the validator has paid out for completed epochs

## notes

- staking ops are dWallet-signed PTBs - they need active SECP256K1 (since dWallets on Sui base sign for IKA-related ops via SECP256K1 ECDSA) and presigns from the matching pool
- hardware vaults (Ledger / Trezor / Seeker) cannot stake from the wallet UI today - this is a dWallet-only flow per architecture
- on Solana base, staking is not implemented (the Solana ika program doesn't expose the same staking surface yet) - stake from a Sui-base vault
- watch out for staking minimums and unstake epoch boundaries enforced on-chain - the wallet surfaces errors verbatim
