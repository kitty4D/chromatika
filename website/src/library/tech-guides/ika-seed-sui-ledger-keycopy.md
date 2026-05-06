# ika seed: Sui base + Ledger (key-copy from source vault)

a Ledger Sui hardware vault on Sui base does **not** derive its own ika seed. instead it **copies** an existing vault's serialized `ikaShareKeysB64` (per-curve user-share encryption keys) into a fresh hardware-vault record. the Ledger device handles fee-payer signing for Sui PTBs; the ika identity is borrowed from the source vault.

## why key-copy and not signature-derivation

Ledger's Sui app produces ed25519 signatures over Sui transaction bytes (and personal messages, with limits per [LEDGER_SUI_LIMITS.md](/library/tech/ledger_sui_limits)). but unlike Seeker / MWA / WalletConnect:

- Ledger doesn't expose a "sign this fixed message off-chain to derive a seed" primitive in a way that's easy to plumb through chromatika's hardware-sign popup flow today
- Ledger users typically already have a software vault (mnemonic / passkey / WAAP) - the Ledger is added as a "use my existing identity, but route fee-payer signing through hardware"
- chromatika can't introduce a hardware-only Sui base vault without solving "where does the fee-payer keypair come from?" - on Solana base, the in-extension keypair pattern works because Solana ika uses gRPC + the deterministic wallet-signature seed; on Sui base, every PTB is signed by the fee-payer keypair, and Ledger is the natural fee signer

so today, Ledger Sui = **secondary vault** on top of an existing primary identity.

## inputs

- `hardwareAccountId`: the paired Ledger Sui account (from `getHardwareAccounts`)
- `ikaShareKeysSourceVaultId`: the existing vault id whose `ikaShareKeysB64` we copy
- the Ledger device's ed25519 public key (`hw.ed25519PublicKeyB64`) for fee-signing dispatch

## step-by-step (key-copy at vault creation)

```
1. user has an unlocked source vault (mnemonic / passkey / WAAP / etc.) with both curves populated
2. user pairs Ledger Sui account via WebHID
3. submit addVaultHardware with:
   - vendor: 'ledger', chain: 'sui'
   - hardwareAccountId: the paired account
   - ikaShareKeysSourceVaultId: source vault id
   - no suiPrivateKeyBech32, no ikaUskSignatureB64, no ed25519 derivation message

4. chromatika reads source vault's ikaShareKeysB64:
   - sourceShareKeys = sourceVault.ikaShareKeysB64   // { SECP256K1, ED25519 }
   - newRecord.ikaShareKeysB64 = { ...sourceShareKeys }   // direct copy

5. chromatika persists fee-payer metadata:
   - newRecord.ledgerFeePayerEd25519PublicKeyB64 = hw.ed25519PublicKeyB64

6. on subsequent fee-paying ops (DKG, presign, sign, sendSuiNative):
   - dispatch via enqueueHardwareSign({
       vendor: 'ledger',
       chain: 'sui',
       derivationPath: hwAcct.derivationPath,
       requestKind: 'sui_tx',
       ...
     })
   - opens hardware-sign popup → WebHID → Ledger Sui app → user confirms on device → signature returns
```

## what gets stored

- `record.ikaShareKeysB64`: copied from source vault (USK bytes)
- `record.ledgerFeePayerEd25519PublicKeyB64`: the Ledger device's pubkey
- `record.hardwareAccountId`: the hardware account id
- `record.hardwareVendor: 'ledger'`, `hardwareChain: 'sui'`
- `record.mnemonic`: not present (the source vault has the mnemonic)
- `record.suiPrivateKeyBech32`: not present (no software keypair)
- `seedSource`: arguably "key-copy" or carries the source vault's `seedSource` for diagnostic - check the actual code for the canonical value

## restore on a new device

```
1. user re-onboards their source vault on the new install (re-type mnemonic / re-pair passkey / re-login WAAP)
   - this rebuilds the source vault's ikaShareKeysB64 deterministically
2. user pairs the same Ledger account on the new install
3. addVaultHardware with the same source vault id and Ledger account
4. ikaShareKeysB64 copied again - same bytes since source vault deterministically rebuilds them
5. dWallets reattach via discoverDWallets
```

restoring requires **both** the source vault's credential **and** the same Ledger device. losing either one prevents the Ledger vault from rebuilding (though dWallets owned by the source identity remain accessible from the source vault directly).

## the design tradeoff

key-copy means:

- **pro**: Ledger user gets the security of "Sui PTBs are signed on the device" for fee-paying ops
- **pro**: same dWallet identity across software + hardware vaults (no migration)
- **con**: not a true "hardware-rooted" identity - the source vault's credential is still the security floor for the ika identity
- **con**: if the source vault's credential is compromised, attacker can sign ika protocol messages with the same identity from any vault, even if Ledger is the fee signer

contrast with Solana hardware-only vaults (Seeker / WalletConnect) where the **ika seed itself** comes from the wallet's deterministic signature, so the dWallet identity is hardware-rooted.

## future: hardware-only Sui base vault

a hardware-only Sui-base vault (no source vault dependency, ika seed derived from a Ledger-signed message) is conceivable but not implemented. would require:

- a stable Ledger-signable derivation message (analog to `IKA_USK_DERIVATION_MESSAGE` for Solana wallets)
- a way to ask the Ledger Sui app to sign that message at pairing time and persist the signature
- routing fee-payer signing for Sui PTBs through the Ledger as today

tracked future. not blocking any current user since the key-copy path covers the practical use case.

## library

- `@ledgerhq/hw-app-sui` for the Ledger Sui app driver
- `@ledgerhq/hw-transport-webhid` for the USB HID transport
- internal: `enqueueHardwareSign` for popup dispatch
- internal: `keyring/hd.ts` doesn't actually run a seed derivation function for this path - the keys are copied from the source vault's `ikaShareKeysB64`. `buildIkaShareKeys(makeSeed=null, stored)` deserializes from `stored` directly
