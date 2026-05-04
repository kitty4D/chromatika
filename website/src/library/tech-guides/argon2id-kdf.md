# argon2id KDF in chromatika

argon2id is the password-based key-derivation function chromatika uses to turn an app password (or recovery-phrase / signature material) into the AES-256-GCM key that wraps the vault blob. picked over PBKDF2 (legacy v2) because argon2id is memory-hard - it forces an attacker to spend RAM, not just CPU, per password guess.

## the parameters we use

per [RFC 9106 §4](https://datatracker.ietf.org/doc/html/rfc9106#section-4) the spec gives two recommended profiles. chromatika uses the **second option** (the lower-memory recommendation):

- `t = 3` (time cost / iteration count)
- `m = 65536 KiB = 64 MiB` (memory cost)
- `p = 4` (parallelism / lanes)
- output length: 32 bytes (the raw bytes that become the AES-256-GCM key)
- variant: argon2**id** (hybrid of argon2i and argon2d, side-channel resistant + GPU-resistant)

salt is a per-vault random 16 bytes generated at vault create time. associated data (`AD`) and secret (`K`) are unused (left empty).

## why these numbers

64 MiB sounds modest for an offline KDF but it's a **service-worker context**. chromium service workers can be torn down after ~30 seconds idle, and argon2id running too long in the SW risks the worker getting killed mid-derivation. 64 MiB × t=3 × p=4 lands around ~1-3 seconds on a modern desktop and ~3-6 seconds on a slow phone. that's enough to make a brute-forcer pay real money for each guess while still letting an honest user unlock without staring at a hung popup.

a future hardening pass could make these tunables (per RFC 9106 §4 first option = m=2 GiB t=1 p=4 if device profile allows). right now it's the lower profile across the board.

## where the derived key lives

- **never** as a plaintext key bytes outside the immediate derivation closure
- imported into `crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, /* extractable */ false, ['encrypt', 'decrypt'])`
- the resulting `CryptoKey` is the only thing the rest of the wallet sees
- on lock the `CryptoKey` reference drops, the GC collects it, the AES key is gone

## the unlock cache footnote

cold service-worker restarts re-import the AES key bytes from `chromatika_unlock_cache_v1` in `chrome.storage.session`. this means the **derived bytes** sit in browser-managed memory between the first unlock and the next lock - that's a deliberate compromise so users don't re-type their password every time chrome unloads the worker. **the password itself is never stored**; only the post-argon2id bytes (b64) plus KDF metadata are cached. legacy `chromatika_unlock_cache_v1_local` and any cache row containing a `password` field are removed on lock / unlock / write.

## the legacy PBKDF2 path

vault format **v2** used PBKDF2 with `iterations ≈ 900_000` against SHA-256. chromatika **rejects v2 blobs on parse** at startup - pre-release means no migration. the v3 format (current) only accepts argon2id-wrapped blobs.

## library

argon2id is provided by a wasm port of the reference implementation (loaded in the background script). check `wallet-extension/src/background/keyring/` or the relevant kdf module for the exact import; the parameters above are constants in the kdf helper.
