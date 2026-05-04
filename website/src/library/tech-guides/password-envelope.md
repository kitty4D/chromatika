# password envelope

the most common chromatika unlock path: enter the app password, argon2id derives an envelope key, the envelope unwraps the master key, the master key decrypts the vault payload.

## envelope record

```jsonc
{
  "kind": "password",
  "label": "primary password",   // human-readable, optional
  "kdfMeta": {
    "kind": "argon2id",
    "tCost": 3,
    "mCostKiB": 65536,
    "parallelism": 4,
    "saltB64": "<16 random bytes>",
    "outputLength": 32
  },
  "wrappedMasterKeyB64": "<AES-GCM ciphertext + tag>",
  "envIvB64": "<12 random bytes>"
}
```

each envelope has its own argon2id salt and its own AES-GCM IV. multiple password envelopes on the same vault is theoretically allowed (multi-password) but the UI / API expose one password envelope per vault.

## creation

```
1. user picks a password (8+ chars enforced)
2. generate 16 random bytes → salt
3. envKey = argon2id(password_bytes, salt, t=3, m=65536KiB, p=4, output=32)
4. generate 12 random bytes → envIv
5. wrappedMK = AES-GCM-256.encrypt(envKey, masterKey, envIv) // 32+16 = 48-byte ciphertext+tag
6. append envelope to vault.envelopes[]
```

password is **never** stored. the only persistent artifacts are: salt (random, public-equivalent), envIv (random, public-equivalent), wrappedMK (sealed). without the password, none of these reveal anything.

## unlock

```
1. user types password
2. envKey = argon2id(password_bytes, kdfMeta.saltB64, kdfMeta.tCost, kdfMeta.mCostKiB, kdfMeta.parallelism, kdfMeta.outputLength)
3. masterKey = AES-GCM-256.decrypt(envKey, wrappedMasterKey, envIv)
   // throws if password is wrong (auth tag verification fails)
4. import masterKey via subtle.importKey('raw', masterKey, { name: 'AES-GCM' }, false, ['decrypt'])
5. masterKey is now a non-extractable CryptoKey held in session
6. session uses masterKey to decrypt the outer vault blob
```

step 3 is the single point where wrong-password is detected. AES-GCM's auth tag verification fails on bad keys, throwing synchronously - the UI surfaces "incorrect password" without ever seeing partial plaintext.

## changing the password

```
1. unlock with old password → masterKey
2. user picks new password
3. generate fresh 16-byte salt, fresh 12-byte envIv
4. envKey_new = argon2id(new_password, new_salt, ...)
5. wrappedMK_new = AES-GCM-256.encrypt(envKey_new, masterKey, envIv_new)
6. replace the password envelope with the new wrappedMK + meta
7. re-seal the vault blob (no payload changes - only the envelope updated)
```

masterKey is **the same** before and after. inner vault payload doesn't get re-encrypted. password change is cheap.

## the unlock cache footnote

after unlock, the **derived 32-byte AES key bytes** (b64) plus argon2id params and salt are written to `chromatika_unlock_cache_v1` in `chrome.storage.session`. this is what lets a cold service worker (chrome unloaded the SW after idle but the user's autolock window hasn't expired) re-import the AES key without re-running argon2id (which would take seconds and re-prompt for password if we didn't cache).

**critical**: the cache holds the **post-argon2id key bytes**, not the password. the password is never written anywhere persistent. on lock or browser quit, `chrome.storage.session` clears.

## the legacy v2 reject

`chromatika_vault_v2` used PBKDF2-HMAC-SHA256 with `iterations ≈ 900_000` directly to produce the AES-256-GCM key (no envelope layer). on parse, v2 blobs are **rejected** - users clear extension storage and re-onboard. the password-envelope v3 design is incompatible with v2 because v2 didn't have a master-key indirection.

## attack model

- **offline brute force**: attacker exfiltrates `chromatika_vault_v3` and tries passwords. each guess costs an argon2id evaluation (~1-3 seconds × 64 MiB RAM). a 12-character random password ≈ 70 bits of entropy → 2^70 guesses → infeasible. a 6-character dictionary word ≈ 30 bits → still very expensive but not impossible if attacker has serious GPU farms. argon2id's memory hardness reduces GPU advantage.
- **session compromise**: if attacker reads `chrome.storage.session`, they get the **derived AES key bytes** and can decrypt the vault until the user locks. mitigations: lock on idle, OS screen-lock triggers wallet lock, manual lock button.
- **password capture**: if attacker has keylogger / clipboard access, they get the password directly. chromatika cannot defend against this; user must protect their endpoint.

## password length floor

8 characters is the minimum chromatika enforces. shorter passwords get rejected at the create / unlock surface with an actionable error. 8 chars is **not enough** for adversarial security - it's a "don't use 'password'" minimum. encourage users toward 16+ char random passphrases or pair with a passkey.
