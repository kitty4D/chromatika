# how to use a WAAP-backed vault

create or unlock a chromatika vault using @human.tech's WAAP (Web Account Abstraction Protocol) - email, phone, or social login that resolves to a Sui address + public key, then signs an envelope-bound challenge to unlock the wallet.

## prerequisites

- a WAAP account on the auth method you want (email, phone, or one of the supported social providers)
- the build can talk to the WAAP service (network access to @human.tech)
- for vault creation: no existing vault (or you're adding a WAAP envelope as a sibling)
- for unlock: the same WAAP credential you used to create the envelope

## options at a glance

- **auth methods**: email, phone, google, discord, twitter, github, bluesky
- **seed source**: the WAAP envelope can carry a Sui-derived seed for the dWallet Vault, or a separate seed source
- **password coexist**: optional - either credential alone unlocks

## how to create a WAAP-backed vault (first vault)

1. complete WAAP login through @human.tech's flow - returns a Sui address + public key
2. submit `createVaultWaap` with: optional password, `waapSuiAddress`, `waapPublicKey`, `authMethod` (one of the seven), `seedSource`, optional label
3. background registers the envelope, encrypts the vault with the WAAP-derived key, writes `chromatika_vault_v3`
4. session unlocks immediately

## how to add a WAAP envelope to an existing vault

1. unlock the wallet (or include the password)
2. submit `addVaultWaap` with the same fields
3. the new envelope joins the vault list

## how to unlock with WAAP

1. read `listVaultEnvelopes` to find the WAAP envelope
2. complete WAAP login again, ask WAAP to sign the envelope's challenge
3. submit `unlockVaultWalletSignature` with envelope id, signature (b64), `autoLockMinutes`

## how to recover a WAAP vault

1. recovery uses the BIP39 recovery branch if one was registered (see [recovery-words.md](/library/user/recovery-words))
2. submit `unlockVaultRecoveryWords` with the envelope id, the words, `autoLockMinutes`

## notes

- WAAP is an external service - if it's down or your account is suspended, you fall back to the recovery branch (if registered) or you cannot unlock that envelope
- you can have multiple WAAP envelopes on the same vault (e.g. email + google) - any one of them unlocks
- the auth method is recorded on the envelope so the unlock UI can pick the right login flow per envelope
- session unlock cache behavior is identical to password / passkey paths - derived key bytes in `chrome.storage.session` only, no plaintext
