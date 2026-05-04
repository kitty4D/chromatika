# ika presign pool implementation

ika MPC signing has two phases: an **online** phase (fast, runs at the moment a signature is needed) and an **offline** phase (slower, runs ahead of time and produces "presign material" that can be combined with any future message). the presign pool stores the precomputed material so signing is fast.

## the three pools

chromatika maintains three presign pools, each scoped per active dWallet Vault:

| pool key | what it's for |
|----------|---------------|
| `SECP256K1_ECDSA` | EVM signing, generic ECDSA |
| `SECP256K1_TAPROOT` | BTC P2TR Schnorr signing |
| `ED25519_EDDSA` | Sui, Solana, Aptos ed25519 signing |

separate pools exist because the presign math differs per algorithm (see [ecdsa-secp256k1.md](/library/tech/ecdsa-secp256k1), [taproot-schnorr.md](/library/tech/taproot-schnorr), [ed25519-eddsa.md](/library/tech/ed25519-eddsa)). a SECP256K1_ECDSA presign cannot be used for a Taproot signature even though both run on secp256k1.

## storage layout

```
chrome.storage.local["chromatika_presign_pools_v3_<vaultId>"] = {
  SECP256K1_ECDSA: [
    { presignId: "0x...", state: "ready", createdAtMs: ... },
    { presignId: "0x...", state: "ready", createdAtMs: ... }
  ],
  SECP256K1_TAPROOT: [...],
  ED25519_EDDSA: [...]
}
```

per-vault scoping (`<vaultId>` suffix) means switching active vault loads a different pool set. switching back restores. presign material is **per dWallet Vault** because the user share encryption keys differ per vault.

## the auto-refill alarm

`chrome.alarms.create('chromatika-presign-refill', { periodInMinutes: 5 })` fires every 5 minutes. on each fire:

```
1. is the wallet locked? → skip (can't sign without USK)
2. for each pool key:
     count = pool[poolKey].length
     if count < LOW_WATER (2):
       refill(poolKey, REFILL_COUNT (3))   // top up by 3
3. persist updated pool to chrome.storage.local
```

constants per CLAUDE.md:
- low-water = 2
- refill count = 3

so a fully drained pool tops up to 3, and a pool with 1 entry tops up to 4. pools above the low-water mark do nothing.

## manual refill

`replenishPresign({ poolKey, count })` triggers an immediate refill of the specified pool. count range is 1-20.

```
for i in 1..count:
  if poolKey === 'SECP256K1_ECDSA' or 'SECP256K1_TAPROOT':
    presignId = await ikaClient.requestSecpPresign(poolKey, dwallet)
  else if poolKey === 'ED25519_EDDSA':
    presignId = await ikaClient.requestEddsaPresign(dwallet)
  pool[poolKey].push({ presignId, state: 'ready', createdAtMs: Date.now() })
persist
```

each `requestPresign` call is its own transaction (Sui PTB or Solana gRPC). funding requirements: same dynamic pricing as DKG / sign - call `getRequiredCoinAmounts` first.

## taking a presign

`takePresign(poolKey)` pops one entry from the pool:
```
function takePresign(poolKey):
  if pool[poolKey].length === 0:
    throw 'pool empty - call replenishPresign first'
  return pool[poolKey].shift()   // FIFO
```

shorthand: `takePresignId()` is an alias for `takePresign('SECP256K1_ECDSA')` since EVM is the most common path.

once popped, the presign id is committed to one signature. it cannot be reused (security property: each presign produces one and only one signature; reusing a presign reveals the secret key).

## consumption flow during sign

```
1. user requests a sign (e.g. signEvm(message))
2. wallet calls takePresign(SECP256K1_ECDSA) → presignId
3. wallet builds a sign PTB with the presignId + message
4. ika network completes the signature using the presign material
5. signature returns
6. on success, the popped presign stays consumed; pool moves on
7. on failure, the wallet may push the presign back if it's recoverable (rare)
```

if `takePresign` returns "pool empty" mid-sign, the wallet can synchronously call `replenishPresign(poolKey, 1)` and retry. but this defeats the point of the precomputation - it adds latency to the sign call.

## per-vault isolation

```
sessionState.activeVaultId === 'vault-a'
  → chromatika_presign_pools_v3_vault-a is the active pool
  → switching to vault-b loads chromatika_presign_pools_v3_vault-b
  → vault-a's pool stays cached on disk for when you switch back
```

presign material is **specific to a dWallet** (it's tied to the user share). pool entries from vault A's dWallet cannot be used to sign with vault B's dWallet.

## what happens if the pool drains while locked

the auto-refill alarm only fires when the wallet is **unlocked**. if the user stays locked for hours, the pool drains naturally as auto-refill skips. on next unlock, the alarm refills. in the meantime, signing requests fail with pool-empty errors and the user sees a "refilling presign material..." progress UI.

## debugging presign issues

- `presignPool` tRPC query returns counts per pool for the active vault
- `signingProgress` returns the current signing-in-progress state if a sign is mid-flight
- `replenishPresign` to manually refill if the pool is stuck
- check `chromatika_presign_pools_v3_<vaultId>` directly via dev tools if you suspect storage corruption

## what doesn't work

- using a presign for the wrong algorithm (TAPROOT presign for ECDSA sign, etc.) - the protocol rejects
- reusing a presign across two signs - second sign rejects on chain (signature already consumed)
- presigns for a dWallet that's been transferred away - they're invalid; refill against the new dWallet

## library

- `@ika.xyz/sdk` `IkaTransaction.requestSecpPresign`, `requestEddsaPresign`, `requestGlobalPresign`
- internal: `wallet-extension/src/background/ika/presign-pool.ts` for pool R/W, refill orchestration, `takePresign` / `replenishPresign`
- internal: `chrome.alarms` for the 5-min refill alarm
