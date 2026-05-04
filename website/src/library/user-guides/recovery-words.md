# how to use BIP39 recovery words

a recovery branch is a BIP39 phrase registered alongside another credential (passkey, WAAP, or Lazor) so you can still unlock the matching envelope if the primary credential is lost.

## prerequisites

- the envelope was created with a recovery branch (you supplied `recoveryWords` at create time, or chose the equivalent option for passkey / WAAP)
- you have the BIP39 words written down somewhere safe
- the chromatika vault still exists locally (recovery words restore an unlock path, not the encrypted blob - if storage is wiped you also need the original install + envelope record)

## options at a glance

- **passkey envelope** with recovery branch
- **WAAP envelope** with recovery branch
- **Lazor envelope** with recovery branch
- recovery words **cannot** unlock a password-only or hardware-only envelope - those have their own primary credentials

## how to register recovery words

recovery is registered when the envelope is created:

- **Lazor**: pass `recoveryWords` to `createVaultLazor` or `addVaultLazor`
- **passkey** / **WAAP**: register a recovery probe at envelope create time per the create flow

if the envelope was created without a recovery branch, you cannot retroactively bolt one on - create a sibling envelope (or a new vault) that has one

## how to unlock with recovery words

1. call `listVaultEnvelopes` to find the target envelope id
2. submit `unlockVaultRecoveryWords` with: `envelopeId`, the BIP39 words, `autoLockMinutes` (1-1440, default 30)
3. the background derives the recovery key from the words, decrypts the envelope, parks the AES `CryptoKey` in session

## how to rotate primary credential after recovery

after unlocking via recovery, you usually want to register a fresh primary credential:

1. for passkey: `runPasskeyAddVault` to add a new passkey envelope to the same vault
2. for WAAP: `addVaultWaap` with a fresh WAAP login
3. for Lazor: `addVaultLazor` with a fresh smart wallet credential
4. optionally `removeVault` on the old envelope after the new one is verified

## notes

- BIP39 words for recovery are **not** the same as the dWallet Vault mnemonic - they are envelope-bound recovery probes. confusion here means failed unlocks
- treat these words like any other seed phrase: offline, never typed into a website, never shared
- if you lose both the primary credential and the recovery words, the envelope is unrecoverable. you can still use other envelopes / vaults on the same install
