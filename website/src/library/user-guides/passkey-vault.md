# how to use a passkey-backed vault

create, sign with, and recover a chromatika vault that uses a WebAuthn passkey (with the PRF / HMAC-secret extension) as the unlock credential. the passkey can be the only credential, or coexist with a password.

## prerequisites

- the device + browser supports WebAuthn with the **PRF (HMAC-secret)** extension (recent Chrome / hardware authenticators with the right firmware)
- a relying-party id (`rpId`) the wallet reaches over - in practice the chromatika extension origin
- for vault creation: no existing vault on the install (or you're adding a passkey vault as a sibling)
- for unlock / sign / recover: the matching authenticator is available

## options at a glance

- **passkey-only vault**: no password, ceremony unlocks alone
- **passkey + password vault**: either credential unlocks; useful for backup access
- **kind for sign**: `tx`, `personal`, or `raw` (passkey can sign different challenge shapes)

## how to register a new passkey vault (first vault)

1. submit `runPasskeyOnboarding` with: optional password, `rpId`, `rpName`, `userName`, `userDisplayName`, optional label
2. the orchestrator enqueues a register request; the WebAuthn ceremony runs in a popup context (where `navigator.credentials.create` is allowed)
3. the popup calls `getPasskeyRegisterRequest` to read the challenge + PRF salt, runs the ceremony, then posts artifacts back via `resolvePasskeyRegister` (credentialId, public key, PRF secret, `rpId`)
4. background commits the vault encrypted with the PRF-derived key (and the password, if provided)

## how to add a passkey to an existing vault

1. unlock the wallet (or include the password in the call)
2. submit `runPasskeyAddVault` with the same fields as onboarding
3. ceremony runs the same register / resolve loop; the new passkey envelope is appended to the vault list

## how to unlock with a passkey

1. read `listVaultEnvelopes` to find the passkey envelope
2. trigger the assertion ceremony in a popup context (the popup calls `getPasskeySignRequest`, runs `navigator.credentials.get` with PRF, posts back via `resolvePasskeySign`)
3. submit `unlockVaultPasskey` with the envelope id, PRF secret (b64), and `autoLockMinutes`

## how to sign an arbitrary challenge with a passkey

1. queue the sign request via `enqueuePasskeySign` with: vault id, credentialId, `rpId`, public key, the challenge bytes, `kind` (tx / personal / raw), optional PRF salt
2. the popup runs WebAuthn assertion, returns serialized signature (b64) and optional PRF secret via `resolvePasskeySign`
3. cancel via `rejectPasskeySign` with a reason

## how to recover a passkey vault

1. queue recovery via `enqueuePasskeyRecover` with `rpId`, two probe challenges, PRF salt
2. the popup runs the recover ceremony - it walks the user through reattesting on a backup device or restoring from a synced credential, then posts artifacts via `resolvePasskeyRecover`
3. cancel via `rejectPasskeyRecover` if the user backs out

## notes

- the PRF / HMAC-secret extension is what makes the passkey usable as an encryption credential - without it, the passkey can authenticate but cannot derive the AES key
- the PRF secret is treated like the AES key bytes path: held in `chrome.storage.session` only, dropped on lock
- platform-bound passkeys (e.g. Windows Hello) only work on the device they were registered on. cross-device sync requires a roaming or synced authenticator
- recovery requires that the original passkey envelope was set up with a recovery branch (e.g. backup BIP39 words via [recovery-words.md](/library/user/recovery-words))

## restore on a fresh install (just the passkey, no phrase)

if you've onboarded a chromatika passkey vault before AND the same passkey is available on this device (via platform sync or a roaming/hardware authenticator), reinstalling chromatika and picking "create or restore with passkey" rebuilds the same vault automatically:

1. the PRF salt is no longer per-vault random — it's a chromatika-wide constant (`keccak256("chromatika.passkey.prf-salt.v1")`), so reinstall doesn't lose it
2. same passkey credential + same constant salt = same PRF output = same ika seed via `ikaRootSeedFromPasskeyPRF`
3. on persist, `kickDiscoveryForVault` runs and finds existing dwallet caps owned by the recovered Sui address — your cross-chain accounts reappear after unlock

a fresh install with a previously-onboarded passkey produces a vault byte-for-byte identical to the original at the ika layer. only the local chromatika password / encrypted blob is fresh.

## multiple vaults from the same passkey

new in this slice: one passkey credential can back several distinct chromatika vaults via the `passkeyEncryptionIndex` field on the record. think of it as bip44 accounts on top of a passkey instead of a seed phrase. when you add a sibling vault using the same passkey, chromatika auto-picks `max(existingIndices) + 1` so the second vault gets a different ika seed → different dwallets → different EVM / BTC / Solana / Aptos addresses. same Sui address (since the passkey pubkey is fixed).

see [multi-vault-siblings.md](/library/user/multi-vault-siblings) for the cross-method UX (passkey / seeker / waap / lazor).
