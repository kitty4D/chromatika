# `chrome.storage.local` + `chrome.storage.session`

chromatika persists state in two chrome storage areas with very different semantics. `chrome.storage.local` survives chrome restarts (but is cleared on uninstall); `chrome.storage.session` only survives until chrome quits or the SW is unloaded. choosing the right area is security-critical.

## the two areas

| area                     | persists across browser quit? | persists across SW unload?    | quota                                                                            | use for                                                           |
| ------------------------ | ----------------------------- | ----------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `chrome.storage.local`   | yes (until uninstall)         | yes                           | 5 MB default, can request more via `'storage'` permission with unlimited storage | encrypted vault blob, dWallet meta, registry, settings            |
| `chrome.storage.session` | **no**                        | yes (within a chrome session) | a few MB                                                                         | unlock cache (post-KDF AES key bytes), in-flight pending requests |

`chrome.storage.sync` (a third area that syncs across browser profiles) is **not used** by chromatika - per-install scoping is intentional.

## chromatika's keys in `chrome.storage.local`

per the chromatika storage-key convention `chromatika_<domain>_v<N>`:

| key                                     | content                                             |
| --------------------------------------- | --------------------------------------------------- |
| `chromatika_vault_v3`                   | encrypted multi-vault blob                          |
| `chromatika_dwallet_meta_v2_<vaultId>`  | per-vault dWallet overlay (cap ids, addresses)      |
| `chromatika_presign_pools_v3_<vaultId>` | per-vault ika presign pools                         |
| `chromatika_active_networks_v1`         | per-chain active network selection                  |
| `chromatika_custom_networks_v1`         | user-added EVM (and others) custom networks         |
| `chromatika_media_safety_v1`            | MediaSafetyMode value                               |
| `chromatika_dapp_permissions_v1`        | dapp connection permissions                         |
| `chromatika_hw_accounts_v1`             | hardware account list (Ledger / Trezor / MWA / WC)  |
| `chromatika_advanced_mode_v1`           | advanced UI toggle                                  |
| `chromatika_ika_base_mode_v1`           | global ika base preference (sui / solana)           |
| `chromatika_mcp_v1`                     | MCP agent surface state (token, port, enabled flag) |
| `chromatika_x402_caps_v1`               | x402 spending caps                                  |
| `chromatika_x402_receipts_v1`           | x402 payment receipts (capped at 200)               |

bumping the integer suffix denotes a schema change. parser rejects older versions on load (chromatika is pre-release; no migration path yet).

## chromatika's keys in `chrome.storage.session`

| key                              | content                                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------- |
| `chromatika_unlock_cache_v1`     | post-argon2id AES key bytes + KDF meta (b64)                                          |
| `chromatika_pending_<requestId>` | in-flight tx-approval / sign-approval / x402-approval requests waiting on user action |

note: a legacy `chromatika_unlock_cache_v1_local` (in `local`, not `session`) is **explicitly removed on lock / unlock / write** by the current code. plaintext password fields are also defensively removed. session storage is the only correct place for unlock material. see [cold-sw-unlock-cache.md](/library/tech/cold-sw-unlock-cache).

## reading + writing

```ts
// async API; returns a promise (or accepts callback in legacy code)
const { chromatika_vault_v3 } = await chrome.storage.local.get("chromatika_vault_v3");
await chrome.storage.local.set({ chromatika_vault_v3: newBlob });
await chrome.storage.local.remove("chromatika_unlock_cache_v1_local");

// session same shape
const cached = await chrome.storage.session.get("chromatika_unlock_cache_v1");
```

`webextension-polyfill` (the cross-browser shim chromatika uses) wraps these; works on Firefox + Chrome with the same API.

## the change-event subscription

```ts
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && "chromatika_vault_v3" in changes) {
    // reload vault state
  }
});
```

useful for cross-context sync. e.g. one popup updates `chromatika_dapp_permissions_v1`, another popup's listener picks it up immediately.

## quota considerations

- the encrypted vault blob can grow (each vault record adds bytes). 100 vaults each with mnemonic + ika keys + multiple envelopes ~ a few MB. fits comfortably in default quota
- presign pools can grow to ~1 KB per entry × ~50 entries × 3 pools × N vaults
- x402 receipts capped at 200 - bounded
- if quota becomes an issue, request `'unlimitedStorage'` permission

## clear-on-uninstall

uninstalling chromatika **wipes** `chrome.storage.local` and `chrome.storage.session` for chromatika's origin. the encrypted vault blob is gone. user has to re-onboard with the mnemonic / passkey / hardware path on reinstall.

this is **the only** way to truly delete chromatika's local state. clearing browser cache / cookies doesn't touch extension storage.

## the offscreen storage absence

chromatika does **not** use `chrome.offscreen` (a relatively new MV3 surface for background DOM contexts). target architecture has an offscreen media cache for NFT images; not implemented today. when it ships, manifest will request the `offscreen` permission - until then, no.

## library

- `webextension-polyfill` for cross-browser API parity
- browser native `chrome.storage.local`, `chrome.storage.session`, `chrome.storage.onChanged`
- internal: per-domain helpers in `wallet-extension/src/background/storage/*` (e.g. `vault-storage.ts`, `dwallet-meta-storage.ts`, etc.)

## related

- [cold-sw-unlock-cache.md](/library/tech/cold-sw-unlock-cache) - the session-storage unlock cache details
- [vault-blob-v3-format.md](/library/tech/vault-blob-v3-format) - the largest single record
- [chrome-alarms-and-idle.md](/library/tech/chrome-alarms-and-idle) - storage-adjacent SW lifetime primitives
