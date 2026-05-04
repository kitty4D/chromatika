# how to manage ika fee-payer (Solana base)

on Solana ika base, the wallet auto-generates an in-extension Solana keypair to pay ika gRPC `approve_message` fees - hardware-backed Solana wallets (Seeker / Seed Vault) never expose secret bytes, so chromatika needs its own gas-only key. this guide covers querying status, configuring fee mode, manually topping up, and draining residual SOL back to your phone wallet.

## prerequisites

- a Chromatika vault is unlocked
- the active dWallet Vault is on **Solana base** (this guide does not apply to Sui-base vaults)
- a Seeker / phone wallet is paired (for top-up and Seeker-direct mode)
- you have a small amount of devnet SOL to fund the fee-payer (~0.1 SOL is plenty)

## options at a glance

- **fee mode**:
  - `in_extension` (default): the in-extension fee-payer signs `approve_message` directly. fast, but the keypair must be funded
  - `seeker_direct`: ika ops use a per-call signature from the Seeker; slower but no in-extension keypair to manage. the deprecated `ikaEncryptionOnlySolSecretKeyB64` is still readable as a fallback for old dev installs
- **auto-refill** (for `in_extension`): when fee-payer balance dips below `thresholdLamports`, top up by `refillLamports` via Seeker hardware sign
- **manual top-up**: trigger a one-shot top-up on demand
- **drain**: send fee-payer balance back to the Seeker (default = full balance minus rent + a fee buffer)
- **drain abandoned**: drain the residual keypair on a `seeker_direct` vault that was switched away from `in_extension`

## how to read fee-payer status

1. call `ikaFeePayerStatus` with `vaultId`
2. response includes the fee-payer address, balance (lamports), thresholds, mode, and whether a keypair exists for the vault
3. quick balance check for the active vault: `activeIkaFeePayerBalance` (returns balance or null if no keypair)

## how to read or update fee settings

- read: `getIkaFeeSettings` with `vaultId` returns `{ mode, autoRefill, refillLamports, thresholdLamports }`
- update: `setIkaFeeSettings` with `vaultId` and any subset of: `mode`, `autoRefill` (boolean), `refillLamports`, `thresholdLamports`. partial update; non-supplied fields stay
- defaults reference: `ikaFeeDefaults` returns the recommended tunables (no params)

## how to manually top up the fee-payer

1. submit `topUpIkaFeePayer` with `vaultId` and `lamports`
2. wallet enqueues a Seeker hardware-sign request to send SOL from your phone to the fee-payer address
3. you approve on the phone; signature returns; transaction broadcasts
4. balance reflects after Solana confirms

## how to drain the fee-payer back to Seeker

1. submit `drainIkaFeePayerToSeeker` with `vaultId` and optional `lamports` (defaults to "full balance minus rent + fee buffer")
2. wallet builds a transfer from fee-payer to the Seeker address, signs with the in-extension keypair, broadcasts
3. no phone prompt needed - the in-extension keypair authorizes the transfer

## how to drain a residual keypair from a seeker_direct vault

1. submit `drainAbandonedFeePayer` with `vaultId`
2. used when you've switched the vault to `seeker_direct` mode but a residual `in_extension` keypair still has SOL
3. drains via the persisted keypair without prompting the phone

## notes

- the **Seed Vault never reveals secret bytes**. that's why chromatika auto-generates an in-extension Solana keypair (`ikaGrpcFeePayerSolSecretKeyB64`) for ika gRPC fees. **all chain transactions** (sends, dapp signing, dWallet authorize) still go through the Seeker. there is no software signing of "your money"
- Seeker pairing also derives the ika `UserShareEncryptionKeys` root seed from a signed `IKA_USK_DERIVATION_MESSAGE` (see [seeker-remote.md](/library/user/seeker-remote)). that seed and the fee-payer keypair are independent - one signs ika protocol, one pays gRPC fees
- the deprecated `ikaEncryptionOnlySolSecretKeyB64` field reads as a fallback for old dev installs; new writes go to `ikaGrpcFeePayerSolSecretKeyB64`. those old vaults are not portable - re-onboard to migrate
- runbook: `wallet-extension/docs/SEEKER_REMOTE_PAIRING.md`
