# passkey PRF envelope

a chromatika vault can have a **passkey** envelope that uses webauthn's PRF (HMAC-secret) extension to derive an envelope key. the same passkey credential, given the same per-vault salt, produces the same 32-byte PRF output every time - which lets us derive the envelope key deterministically without storing it.

## envelope record

```jsonc
{
  "kind": "passkey-prf",
  "label": "yubikey-1",
  "credentialIdB64Url": "<webauthn credential.rawId>",
  "publicKeyCompressedB64": "<33-byte compressed secp256r1 pubkey>",
  "rpId": "<extension chrome-extension://... origin>",
  "prfSaltB64": "<32 random bytes>",
  "wrappedMasterKeyB64": "<AES-GCM ciphertext + tag>",
  "envIvB64": "<12 random bytes>"
}
```

`prfSaltB64` is the per-vault domain separator. webauthn PRF takes a salt and returns `HMAC(hmac_secret, salt)` - same secret + same salt = same output, deterministically.

## creation (registration)

```
1. webauthn ceremony: navigator.credentials.create({
     publicKey: {
       challenge: random32,
       rp: { id: rpId, name: 'Chromatika' },
       user: { id, name, displayName },
       pubKeyCredParams: [{ alg: -7, type: 'public-key' }],   // ES256 (secp256r1)
       extensions: { prf: { eval: { first: prfSalt } } }      // optional eval at register
     }
   })
2. response includes:
   - credential.rawId → credentialIdB64Url
   - credential.response.attestationObject → cbor parse → public key bytes
   - extension result: prf.results.first (32 bytes) IF the authenticator supports PRF eval-at-register
3. some authenticators don't eval PRF at register; in that case do an immediate get() to extract PRF
4. envKey = HKDF-SHA256(prf_secret_32, info='chromatika passkey envelope v1', salt=prfSalt)
5. wrappedMK = AES-GCM-256.encrypt(envKey, masterKey, randomIv)
6. envelope = { kind, label, credentialIdB64Url, publicKeyCompressedB64, rpId, prfSaltB64, wrappedMasterKeyB64, envIvB64 }
```

## unlock (assertion)

```
1. webauthn ceremony: navigator.credentials.get({
     publicKey: {
       challenge: random32,
       rpId: rpId,
       allowCredentials: [{ id: credentialIdB64Url_decoded, type: 'public-key' }],
       extensions: { prf: { eval: { first: prfSalt_from_envelope } } }
     }
   })
2. user authenticates on device (Touch ID, Windows Hello, security key tap, etc.)
3. response.extensions.prf.results.first → 32 bytes (deterministic given same credential + salt)
4. envKey = HKDF-SHA256(prf_secret_32, info='chromatika passkey envelope v1', salt=prfSalt_from_envelope)
5. masterKey = AES-GCM-256.decrypt(envKey, wrappedMasterKey, envIv)
6. session unlocks
```

## why HKDF-SHA256 and not argon2id

the PRF output is already 32 bytes of high-entropy random material - HMAC-secret outputs cannot be brute-forced because they're 256-bit pseudorandom. argon2id's memory-hard slowness exists to slow down brute force on low-entropy passwords; with PRF that entire threat model doesn't apply.

HKDF gives us domain separation (`info='chromatika passkey envelope v1'`) and re-randomization with the per-vault salt, so reusing the same credential across multiple chromatika vaults produces different envelope keys per vault.

## determinism guarantee

webauthn PRF spec mandates that for a given (credential, salt) pair, the output is identical across:
- different assertions on the same device
- different devices that the credential has been **synced to** (e.g. iCloud Passwords sync, Google Passkey sync)
- different chromatika installs that authenticate against the same credential

this is why a passkey vault can be **restored on a new install** by re-registering the same passkey - not by exporting / importing keys, but by re-asserting and getting the same PRF output.

## non-deterministic authenticators

some older or non-conformant authenticators don't expose PRF / HMAC-secret. chromatika **does not** create a passkey envelope on those - the registration ceremony returns no PRF result, and chromatika rejects the registration with an actionable error (use a different authenticator, or use a password / WAAP / hardware envelope instead).

## platform-bound vs roaming

- **platform-bound** passkeys (Touch ID, Windows Hello, Android device biometrics): tied to the device they were registered on. cross-device requires platform sync (iCloud / Google).
- **roaming** authenticators (yubikey, solokey, hardware token): work on any device that supports webauthn over USB / NFC / Bluetooth.

chromatika doesn't distinguish in storage - the envelope record is identical for both. the user picks based on threat model + convenience.

## webauthn extension fields chromatika sets

```js
extensions: {
  prf: {
    eval: { first: prfSalt }    // 32-byte salt; we only use 'first', not 'second'
  }
}
```

we don't use `prf.evalByCredential` (per-credential salt mapping) because chromatika sends one credential at a time via `allowCredentials`. we don't use `largeBlob` because the PRF output is enough for our envelope key.

## passkey rotation

chromatika can have **multiple** passkey envelopes on the same vault (yubikey + Touch ID, for example). each envelope wraps the same masterKey with its own credential's PRF output. dropping an envelope = removing one credential without affecting others.

if a user **loses** all their passkeys, they need a recovery-words envelope (registered at create time per the option in `runPasskeyOnboarding`) or the password envelope as backup.

## library

- browser native `navigator.credentials` (webauthn)
- `crypto.subtle.deriveKey` for HKDF
- `crypto.subtle.encrypt` / `.decrypt` for AES-GCM
- helper: `wallet-extension/src/ui/passkey/passkey-provider-with-prf.ts` wraps `navigator.credentials` with the PRF extension and chromatika-specific defaults
- helper: `passkey-derive.ts` for register-time + assertion-time validation, public-key parsing, Sui address derivation (BLAKE2b-256 of `0x06 || pk_compressed`)
