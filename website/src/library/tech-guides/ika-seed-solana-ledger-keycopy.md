# ika seed: Solana base + Ledger (key-copy from source vault)

a Ledger Solana hardware vault on Solana base does **not** derive its own ika seed. like the Sui-Ledger path (see [ika-seed-sui-ledger-keycopy.md](/library/tech/ika-seed-sui-ledger-keycopy)), it copies an existing vault's `ikaShareKeysB64`. the Ledger device handles fee-payer-style signing for Solana operations; the ika identity is borrowed.

## why key-copy and not signature-derivation

unlike Seeker / WalletConnect (which use the wallet's deterministic signature over `IKA_USK_DERIVATION_MESSAGE` as the ika seed source), Ledger Solana:

- exposes a sign-message API but routing it through chromatika's hardware-sign popup at vault-create time hasn't been implemented today
- is typically added as an additional account on top of an existing chromatika identity, not as a primary identity root

so today, Ledger Solana = **secondary vault** that uses an existing primary identity for ika and adds Ledger fee signing for Solana ops.

## inputs

- `hardwareAccountId`: the paired Ledger Solana account
- `ikaShareKeysSourceVaultId`: existing vault id whose USK we copy
- the Ledger account's Solana address (base58)

## step-by-step

```
1. user has an unlocked source vault with both curves populated
2. user pairs Ledger Solana account via WebHID
3. submit addVaultHardware with:
   - vendor: 'ledger', chain: 'solana'
   - hardwareAccountId
   - ikaShareKeysSourceVaultId: source vault id
   - no solanaSecretKeyB64, no ikaUskSignatureB64

4. chromatika reads source vault's ikaShareKeysB64:
   - newRecord.ikaShareKeysB64 = { ...sourceVault.ikaShareKeysB64 }

5. chromatika persists fee-payer metadata:
   - newRecord.ledgerFeePayerSolPubkeyB58 = hw.address

6. on subsequent fee-paying ops:
   - dispatch via enqueueHardwareSign({ vendor: 'ledger', chain: 'solana', ... })
   - opens hardware-sign popup → WebHID → Ledger Solana app → user confirms → signature returns
```

## what gets stored

- `record.ikaShareKeysB64`: copied from source vault (USK bytes)
- `record.ledgerFeePayerSolPubkeyB58`: the Ledger device's Solana address
- `record.hardwareAccountId`, `hardwareVendor: 'ledger'`, `hardwareChain: 'solana'`
- `record.solanaSecretKeyB64`: not present (no software keypair)
- `record.ikaGrpcFeePayerSolSecretKeyB64`: not present (Ledger pays fees directly via hardware sign)
- `record.mnemonic`: not present

## the design tradeoff (same as Sui-Ledger key-copy)

- **pro**: Ledger user gets device signing for Solana ops
- **pro**: same dWallet identity across software + Ledger vaults
- **con**: not hardware-rooted - the source vault's credential is the security floor for ika identity
- **con**: source vault credential compromise = identity compromise, even if Ledger is the active fee signer

contrast Seeker / WalletConnect Solana vaults where the ika seed is the **wallet's own signature** - the dWallet identity is fully hardware-rooted there.

## why not Seeker-style signature derivation for Ledger

a hardware-only Ledger Solana vault (ika seed derived from a Ledger-signed message) is achievable in principle:

- Ledger Solana app supports `solana_signMessage` or arbitrary-bytes signing
- a fixed message like `IKA_USK_DERIVATION_MESSAGE` could be signed at pairing
- `keccak256(signature || index)` would be the seed

what's missing today:

- the chromatika UX flow that pops the Ledger sign popup at vault-create time before any keys are committed
- testing across Ledger firmware versions (sign-message availability varies)
- handling the case where Ledger requires display approval for arbitrary bytes (the user has to physically confirm a fixed string they don't recognize)

tracked future. the key-copy path covers the practical use case for now.

## restore on a new device

```
1. user re-onboards their source vault on the new install (same mnemonic / same passkey / etc.)
2. user pairs the same Ledger Solana account
3. addVaultHardware with the source vault id
4. ikaShareKeysB64 copied (deterministically rebuilt by source vault)
5. discoverDWallets reattaches dWallets
```

requires both the source credential **and** the Ledger device. losing either prevents the Ledger vault from rebuilding (the source vault still works on its own).

## library

- `@ledgerhq/hw-app-solana` for the Ledger Solana app driver
- `@ledgerhq/hw-transport-webhid` for USB HID
- internal: `enqueueHardwareSign` for popup dispatch
- internal: `keyring/hd.ts` doesn't run a seed function for this path - keys come from `record.ikaShareKeysB64` via `buildIkaShareKeys(makeSeed=null, stored)`
