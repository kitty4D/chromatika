# how to unlock and lock chromatika

control the wallet's locked / unlocked state. when locked, every signing or sending operation is rejected and the dapp bridge reports disconnected. when unlocked, the session holds a non-extractable AES `CryptoKey` derived from your password (or from a passkey / hardware signature, depending on the unlock path).

## prerequisites

- a chromatika vault exists (created or imported)
- you know the password, or have a passkey / WAAP / hardware envelope registered, or have a recovery phrase

## options at a glance

- **password unlock**: classic path; works on any vault that has a password (most of them)
- **passkey unlock**: WebAuthn + PRF HMAC-secret derived key (no password needed if vault is passkey-only)
- **hardware / wallet-signature unlock**: WAAP, Seeker, or WalletConnect signature on an envelope-bound challenge
- **recovery-words unlock**: BIP39 phrase as a fallback when the primary credential is lost (only available if the envelope was set up with a recovery branch)
- **autolock window**: 1 to 1440 minutes; default 30
- **manual lock**: instant lock, broadcasts disconnect to all connected dapps

## how to unlock with a password

1. read `lockState` first to see if you're already unlocked (this call is cheap and runs before unlock prompts)
2. submit `unlockVault` with your password and the desired `autoLockMinutes` (1-1440)
3. background runs Argon2id to derive the AES key, decrypts `chromatika_vault_v3`, parks the non-extractable `CryptoKey` plus KDF meta in the session
4. dapp bridge reconnects to active permissions; presign refill alarm rearms

## how to unlock with a passkey

1. fetch unlock options via `listVaultEnvelopes` to find the passkey envelope id
2. trigger the WebAuthn ceremony (browser prompts the authenticator) - PRF returns a 32-byte secret
3. submit `unlockVaultPasskey` with: envelope id, the PRF secret (b64), `autoLockMinutes`
4. session unlocks identically to the password path

## how to unlock with a hardware / wallet signature (WAAP / Seeker / WalletConnect)

1. find the matching envelope via `listVaultEnvelopes`
2. ask the wallet device to sign the envelope challenge (the device determines the ceremony)
3. submit `unlockVaultWalletSignature` with the envelope id, the signature (b64), and `autoLockMinutes`

## how to unlock with recovery words

1. find the recovery envelope via `listVaultEnvelopes`
2. submit `unlockVaultRecoveryWords` with the envelope id, the BIP39 words, and `autoLockMinutes`
3. only works if a recovery branch was registered when the credential was created (passkey, WAAP, or Lazor flows can opt in)

## how to set or change the autolock window

1. pass `autoLockMinutes` (1-1440) on any unlock call - it sets the window for that session
2. the alarm rearms on every user interaction; once the window elapses with no activity, the wallet locks itself

## how to lock immediately

1. call `lock` - the session AES key is dropped, all pending signing requests reject, dapp bridge broadcasts disconnect to every connected origin

## notes

- the password (or passkey / signature) is **never** persisted to disk as plaintext. the unlock cache holds **derived AES key bytes** (b64) in `chrome.storage.session` only - that storage clears when chrome quits the worker
- legacy `chromatika_unlock_cache_v1_local` and any cache row containing a `password` field are removed on lock / unlock / write
- OS screen-lock (via `chrome.idle`) also triggers the wallet lock, regardless of the configured autolock minutes
- service worker cold restarts re-import the cached key bytes back into a non-extractable `CryptoKey` and forget them - you don't have to re-enter your password every time chrome unloads the worker
