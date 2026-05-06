# cold-SW unlock cache (`chromatika_unlock_cache_v1`)

chrome MV3 service workers get torn down after ~30 seconds of inactivity. when the user comes back, the service worker spins up "cold" - empty memory, no session state. without a cache, every cold start would force the user to re-enter their password (or re-run their passkey / hardware unlock). the unlock cache fixes that without ever persisting plaintext credentials.

## the cache record

stored in `chrome.storage.session`:

```jsonc
{
  "chromatika_unlock_cache_v1": {
    "vaultBlobIvB64": "<the v3 vault blob's IV>",
    "masterKeyBytesB64": "<32 raw bytes of the master AES key>",
    "envelopeKindHint": "password" | "passkey-prf" | ...,
    "lockAtMs": 1700000123000,   // when autolock should fire
    "createdAtMs": 1700000000000
  }
}
```

**the `masterKeyBytesB64` is the post-envelope-unwrap master key bytes** - what would normally be re-derived by going envelope → envKey → AES-GCM unwrap. by caching the bytes after unwrap, cold restarts skip both argon2id (slow!) and webauthn / wallet-signature ceremonies (UI-prompt!). the key bytes themselves are 32 random bytes - useful only if attacker can read `chrome.storage.session`, which is itself ephemeral.

## why `chrome.storage.session` and not `chrome.storage.local`

`chrome.storage.session`:

- cleared when the **chrome browser quits** (not just when the SW idles)
- cleared on **manual lock**
- cleared on **uninstall**
- cleared if the user clears site data
- not synced across devices
- not visible to content scripts

`chrome.storage.local`:

- persists across browser quits
- can be read by extension code from any context
- backed by disk (sqlite under the hood)
- persists until explicit `.clear()` or uninstall

caching the master key bytes in `chrome.storage.local` would **defeat the entire point** of the unlock - chrome restart would unlock the vault without any user action. session storage is the only correct place.

## the legacy `chromatika_unlock_cache_v1_local` reject

an older code path mistakenly cached unlock material in `chrome.storage.local`. that key (`chromatika_unlock_cache_v1_local`) is **explicitly removed on lock / unlock / write** by the current code. if you're poking at storage and see it, that's a stale leftover - safe to delete.

similarly: any cache row containing a `password` field (a plaintext password, ever) is **removed on touch**. plaintext passwords have **never** been correct in this cache; the rule is enforced defensively.

## the rehydrate flow

```
1. service worker cold-starts (e.g. user opens the popup after 5 min idle)
2. tRPC handler initializes; reads chrome.storage.session for chromatika_unlock_cache_v1
3. if cache exists AND cache.lockAtMs > now:
     - import cache.masterKeyBytesB64 as a non-extractable AES CryptoKey
     - decrypt the v3 vault blob with this key
     - reconstruct sessionState from the decrypted records
     - resume autolock alarm with the remaining time until lockAtMs
4. if cache missing OR cache.lockAtMs <= now:
     - clear cache
     - require a fresh unlock (password / passkey / signature / words)
```

## the lock flow

```
1. user clicks lock OR autolock alarm fires OR OS screen-lock detected via chrome.idle:
     - clear chrome.storage.session keys related to chromatika
     - drop the in-memory CryptoKey reference
     - dapp bridge broadcasts disconnect to all connected origins
     - emit 'locked' event so UI surfaces re-render
```

## the autolock interaction

autolock window is set per-unlock (1-1440 minutes, default 30). when the user unlocks:

```
lockAtMs = now + autolockMinutes * 60_000
chrome.alarms.create('chromatika-autolock', { when: lockAtMs })
chrome.storage.session.set({ chromatika_unlock_cache_v1: { ..., lockAtMs } })
```

each user action (tRPC call, UI interaction routed through tRPC) **resets** the alarm by computing a fresh `lockAtMs = now + autolockMinutes * 60_000`. user idleness lets the alarm fire on schedule.

## attack model

- **`chrome.storage.session` exfiltration**: if an attacker can read session storage, they get the master key bytes. they can decrypt the vault until the lock fires. mitigation: lock manually before you walk away; OS screen-lock triggers wallet lock. session storage is per-origin, so other extensions can't read it without exploit.
- **service worker memory dump**: if an attacker can dump SW memory, they get the imported `CryptoKey` (non-extractable, but the underlying buffer exists). same mitigations.
- **password leak via unlock cache**: not possible. password is never written to the cache. only the post-argon2id master key bytes are.

## what the cache holds, exactly

| field               | what                                        | is it a secret                              |
| ------------------- | ------------------------------------------- | ------------------------------------------- |
| `vaultBlobIvB64`    | the AES-GCM IV for the vault blob           | no (random, public-equivalent)              |
| `masterKeyBytesB64` | 32-byte master AES key                      | YES - root of trust during unlocked session |
| `envelopeKindHint`  | which envelope was used to unlock (display) | no                                          |
| `lockAtMs`          | when autolock fires                         | no                                          |
| `createdAtMs`       | when this unlock happened                   | no                                          |

`masterKeyBytesB64` is the only sensitive item. its lifetime is bounded by `chrome.storage.session`'s clear-on-quit + the autolock window.

## not in the cache

- the password (never)
- the passkey credential id (in vault blob; not needed for cache rehydrate since masterKey is already unwrapped)
- the BIP39 mnemonic (in vault blob; ditto)
- any hardware-wallet signature (in envelopes; ditto)
- ika user-share encryption keys (in vault blob; ditto)
- presign material (in `chromatika_presign_pools_v3_<vaultId>`)

the cache only stores what's needed to **decrypt the vault payload on cold start**. everything else lives in the (still-encrypted) vault blob.

## library

- `chrome.storage.session.get` / `.set` / `.remove` for cache R/W
- `chrome.alarms` for the autolock timer
- `chrome.idle` for OS screen-lock detection
- `crypto.subtle.importKey` to rehydrate the AES `CryptoKey`
