# AES-256-GCM vault encryption

every chromatika vault blob (`chromatika_vault_v3` in `chrome.storage.local`) is sealed under AES-256 in GCM mode using the key derived from argon2id (see [argon2id-kdf.md](/library/tech/argon2id-kdf)). all signing material - mnemonics, imported private keys, ika user-share encryption keys, hardware-vault auth signatures, fee-payer keypairs - lives inside this single sealed blob.

## why GCM and not CBC / CTR

GCM is an authenticated encryption mode. it produces ciphertext **plus** a 16-byte authentication tag (Wegman-Carter MAC over GHASH) so we get confidentiality + integrity in one primitive. CBC needs a separate HMAC, CTR has no auth at all. GCM also parallelizes well and chrome's webcrypto offers it natively, so the implementation is `crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData? }, key, plaintext)` - no JS-side crypto needed.

## key bits

- algorithm: AES-256 (256-bit key, 14 rounds)
- mode: GCM
- IV: **96 bits** = 12 bytes, NIST-recommended length. generated fresh via `crypto.getRandomValues` for **every** seal. never reused under the same key (IV reuse in GCM is catastrophic - leaks the auth key)
- tag: 128 bits = 16 bytes appended to ciphertext (default web crypto behavior)
- AAD (additional authenticated data): unused today. could carry vault-format version bytes in a future bump if we want format-confusion resistance baked in

## the sealed payload

the plaintext that goes into AES-GCM is the JSON-encoded `{ v: 3, vaults: VaultRecord[], activeVaultId }`. each `VaultRecord` is a per-vault bundle: id, label, base chain, mnemonic (if any), `suiPrivateKeyBech32` / `solanaSecretKeyB64` (if imported), `ikaShareKeysB64` (per-curve user-share encryption keys), passkey artifacts, hardware metadata, multi-envelope state.

## the unwrap

unlock walks: argon2id(password, salt) → 32-byte raw key → `subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['decrypt'])` → non-extractable `CryptoKey`. then `subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext)` returns the plaintext bytes; JSON.parse, hand the records to the session. if the auth tag doesn't verify (wrong password, tampered blob), `decrypt` throws synchronously - we never see ciphertext fragments.

## legacy v2 reject

chromatika **does not migrate** older PBKDF2 + AES-GCM blobs (`chromatika_vault_v2`). on parse, v2 is rejected; users clear extension storage and re-onboard. pre-release means no migration cost from this rule, and it kills the kind of "we tried v2 first, fell back to v3" code path that historically introduces format-confusion vulnerabilities.

## storage key naming

`chromatika_vault_v3` lives in `chrome.storage.local` (persists across browser restarts but cleared on uninstall). bumping the schema means bumping the integer suffix - convention is documented in CLAUDE.md.

## the unlock cache (session-only)

separately, `chromatika_unlock_cache_v1` lives in `chrome.storage.session` only. it stores the **post-argon2id derived AES key bytes** (b64) plus KDF meta (salt, params) so a cold service worker can re-import them as a non-extractable `CryptoKey` and skip the argon2id round. **never** the password. **never** in `chrome.storage.local`. legacy `chromatika_unlock_cache_v1_local` and any row containing a `password` field are removed on lock / unlock / write. see [cold-sw-unlock-cache.md](/library/tech/cold-sw-unlock-cache).
