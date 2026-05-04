# multi-envelope unlock design (V4)

a chromatika vault can be unlocked by **any one of several credentials**: password, passkey, hardware-wallet signature (WAAP / Seeker / WalletConnect), or BIP39 recovery words. each credential is wrapped in its own "envelope" - a small encrypted bundle that contains the master key needed to decrypt the larger vault blob.

## the picture

```
┌─────────────────────────────────────────────────────────┐
│  chromatika_vault_v3 (AES-GCM(masterKey, vault_payload))│
│                                                         │
│   masterKey is the same for every envelope on a vault   │
│                                                         │
│   ┌────────────────────────┐                            │
│   │ PasswordEnvelope       │  argon2id(password) → mk   │
│   ├────────────────────────┤                            │
│   │ PasskeyPRFEnvelope     │  HKDF(prf_secret) → mk     │
│   ├────────────────────────┤                            │
│   │ WalletSignatureEnvelope│  HKDF(signature) → mk      │
│   ├────────────────────────┤                            │
│   │ RecoveryWordsEnvelope  │  HKDF(bip39_seed) → mk     │
│   └────────────────────────┘                            │
└─────────────────────────────────────────────────────────┘
```

every envelope wraps the **same** master key (mk). different credentials produce different KDF inputs but each KDF output is then used to AES-GCM unwrap the master key inside its envelope.

## why envelopes (vs deriving the AES key directly from each credential)

if the AES key were derived directly from each credential, **changing the password would require re-encrypting the entire vault payload** (mnemonic, ika keys, etc.). by introducing the envelope layer, changing the password just means re-wrapping `mk` under a new password-derived envelope key. the inner vault payload stays sealed under the same `mk`.

it also lets you **add or remove envelopes** without touching the vault payload. add a passkey to an existing password-only vault → wrap `mk` under a new PasskeyPRFEnvelope, append it to the vault's envelope list. remove an envelope → drop it from the list.

## envelope kinds

### PasswordEnvelope

```
{
  "kind": "password",
  "label": "primary password",
  "kdfMeta": { argon2id params, salt },
  "wrappedMasterKeyB64": "AES-GCM(envKey, masterKey, envIv)",
  "envIvB64": "<12 random bytes>"
}
```

unlock: `argon2id(password, salt) → envKey → unwrap masterKey via AES-GCM`. then `masterKey` decrypts the vault payload.

### PasskeyPRFEnvelope

```
{
  "kind": "passkey-prf",
  "label": "yubikey",
  "credentialIdB64Url": "<webauthn rawId>",
  "publicKeyCompressedB64": "<33-byte secp256r1 pubkey>",
  "rpId": "<extension origin>",
  "prfSaltB64": "<32 random bytes>",
  "wrappedMasterKeyB64": "AES-GCM(envKey, masterKey, envIv)",
  "envIvB64": "<12 random bytes>"
}
```

unlock: webauthn assertion with `prf.eval.first = prfSalt` → 32-byte PRF output → `HKDF-SHA256(prf_output, info='chromatika passkey envelope', salt=...)` → envKey → unwrap masterKey.

determinism comes from webauthn PRF (HMAC-secret) - same credential + same salt = same output, every assertion. see [webauthn-prf-hmac-secret.md](/library/tech/webauthn-prf-hmac-secret).

### WalletSignatureEnvelope

```
{
  "kind": "wallet-signature",
  "source": "waap" | "seeker" | "walletconnect",
  "address": "<chain address that signs>",
  "label": "seeker",
  "hint": "<auth method or transport>",
  "challenge": "<the message that the wallet signs to unlock>",
  "kdfSaltB64": "<32 random bytes>",
  "wrappedMasterKeyB64": "AES-GCM(envKey, masterKey, envIv)",
  "envIvB64": "<12 random bytes>"
}
```

unlock: hardware wallet signs the envelope's challenge → `HKDF-SHA256(signature, info='chromatika wallet-signature envelope', salt=kdfSalt)` → envKey → unwrap masterKey.

determinism comes from RFC 8032 ed25519 deterministic signing - same key + same message = same signature, every time. WAAP wallets are probed at pairing time (sign twice, compare) to verify determinism; if non-deterministic, that wallet falls back to a recovery-words envelope.

### RecoveryWordsEnvelope

```
{
  "kind": "recovery-words",
  "wordCount": 12 | 24,
  "label": "primary recovery",
  "kdfSaltB64": "<32 random bytes>",
  "wrappedMasterKeyB64": "AES-GCM(envKey, masterKey, envIv)",
  "envIvB64": "<12 random bytes>"
}
```

unlock: user types BIP39 phrase → `mnemonicToSeedSync(words, "")` → 64-byte BIP39 seed → `HKDF-SHA256(bip39_seed, info='chromatika recovery-words envelope', salt=kdfSalt)` → envKey → unwrap masterKey.

probes (the per-word fingerprints that let the unlock surface validate the phrase **before** running the full HKDF) are stored alongside the envelope. on type, the wallet hashes each word and compares - mismatch surfaces a "wrong phrase" error without spending the full KDF.

## what's in the wrapped masterKey

the `masterKey` is 32 random bytes generated **once** at vault creation. it never changes after creation (unless the user explicitly rotates it, which today means "recreate the vault"). every envelope wraps the same 32 bytes.

## adding an envelope

```
1. unlock the vault via any existing envelope → masterKey in memory
2. produce the new credential's envKey (e.g. webauthn register + PRF)
3. wrap the masterKey under the new envKey:
   wrappedMK = AES-GCM(envKey, masterKey, randomIv)
4. append the new envelope to vault.envelopes[]
5. re-seal the vault blob (same masterKey, new envelopes list)
```

## removing an envelope

```
1. unlock the vault
2. filter vault.envelopes[] to drop the target id
3. re-seal the vault blob
```

cannot remove the **last** envelope - that would brick the vault. UI / API enforces "at least one envelope per vault".

## listing envelope metadata (without unlocking)

`listVaultEnvelopes` returns the envelope metadata (kind, label, hint, address, etc.) **without** unlocking. this lets the unlock surface show "this vault has password + passkey + recovery words" before the user picks one. envelope `wrappedMasterKey` and `kdfMeta.salt` are exposed (they're not secrets - they're useless without the credential), but the `masterKey` itself is never exposed by this query.

## per-envelope KDF inputs

| envelope kind | KDF input | KDF | rationale |
|---------------|-----------|-----|-----------|
| password | password (string) | argon2id (slow, memory-hard) | resists offline brute force |
| passkey-prf | PRF output (32 bytes random) | HKDF-SHA256 (fast) | input is already high-entropy random |
| wallet-signature | signature (64 bytes ed25519 sig) | HKDF-SHA256 (fast) | input is already high-entropy |
| recovery-words | BIP39 seed (64 bytes from PBKDF2-HMAC-SHA512) | HKDF-SHA256 (fast) | BIP39's PBKDF2 already did the slow work |

password is the only envelope that uses argon2id because it's the only credential where the entropy comes directly from a human-chosen string. PRF / signatures / BIP39 seeds are all high-entropy random outputs that don't need additional stretching.

## a note on legacy formats

an older code path called `vaultPersistSecrets` and stored credentials in plaintext alongside the vault payload. the multi-envelope V4 design encrypts those credentials separately - moving forward, look for envelopes, not for plaintext credential fields. mnemonic and `solanaSecretKeyB64` / `suiPrivateKeyBech32` **still** sit in plaintext **inside the vault payload** because they're treated as the user's own secret material that the vault is supposed to remember; envelopes wrap the masterKey that decrypts that vault payload, not the credentials themselves.

## library

- `crypto.subtle` for AES-GCM, HKDF, and webauthn calls
- argon2id wasm port for the password envelope
- `@scure/bip39` for `mnemonicToSeedSync`
- internal helpers: `buildPasswordEnvelope`, `buildPasskeyPrfEnvelope`, `buildWalletSignatureEnvelope`, `buildRecoveryWordsEnvelopeRef`, `unlockEnvelope*`
