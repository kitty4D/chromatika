# EncryptionBackend (chromatika)

> status: prereq slice (2026-04-29). EncryptXyzBackend ships as the default for self-recipient cases. **DirectEd25519Backend cross-recipient envelope shipped 2026-05-01** via option-b (HD-derived X25519 inbox key); see "DirectEd25519Backend (shipped 2026-05-01)" section below. SealBackend is deferred. See `wallet-extension/docs/STATUS.md` for the live pointer.

## TL;DR

chromatika has multiple encryption surfaces with different needs:

- **encrypted dWallet labels** (already shipped, encrypt.xyz, self-recipient)
- **encrypted activity notes** (this slice, encrypt.xyz, self-recipient)
- **encrypted vault backup** (future, encrypt.xyz envelope + walrus body, self-recipient)
- **drain reports → chromatika team** (future, cross-recipient, blocked on encrypt.xyz pre-alpha gap)
- **gift envelopes / P2P chat** (future, cross-recipient, same gap)
- **nft-gated full-res media** (future, sui Move policy, Seal)

A single `EncryptionBackend` interface ([`src/background/encryption/types.ts`](../src/background/encryption/types.ts)) abstracts the per-use-case choice between three real / planned backends:

| backend | id | self-recipient | cross-recipient | threshold | inline body | shipped? |
|---|---|---|---|---|---|---|
| `EncryptXyzBackend` | `encrypt-xyz` | yes | **no** (pre-alpha gap) | no | yes (≤8KB) | yes |
| `DirectEd25519Backend` | `direct-ed25519` | yes (round-trip via inbox) | yes | no | yes (≤8KB) | **yes (2026-05-01)** |
| `SealBackend` | `seal` | yes | yes | yes | no (walrus body) | not yet |

## What encrypt.xyz pre-alpha actually supports today

The prereq spike (2026-04-29) confirmed encrypt.xyz pre-alpha is **self-recipient only**. Evidence:

- [`encrypt-protobuf-wire.ts`](../src/background/encrypt/encrypt-protobuf-wire.ts) `CreateInputRequestWire` has fields `chain`, `inputs`, `proof`, `authorized`, `networkEncryptionPublicKey` - **no recipient**. The `authorized` field is program access control (which Solana program may invoke FHE ops on the ciphertext), not encryption recipient.
- [`encrypt-read-msg.ts`](../src/background/encrypt/encrypt-read-msg.ts) `encodeReadCiphertextMessage` accepts a `reencryptionKey` parameter, but `encrypt-lab-service.ts:248` always passes `new Uint8Array(0)` and the executor returns plaintext to whoever signs the request.
- The encrypt skill's `references/grpc-api.md` says the `value` field will be "re-encrypted under user key" in the future. Today it's plaintext to the signing pubkey.
- `ReadCiphertext` caches per `(ciphertext_identifier, signer, epoch)` - the signer is always the reader's own ed25519 pubkey. There is no way to decrypt as / for another user.

This means **every cross-user envelope in chromatika** (drain reports, gift envelopes, P2P chat, NFT-gated reveals) needs a non-encrypt.xyz path until upstream lands recipient-keyed.

## Per-use-case backend choice

| use case | backend | recipient kind | rationale |
|---|---|---|---|
| dWallet labels (shipped) | encrypt-xyz | self | already shipped, no migration |
| activity notes (shipped) | encrypt-xyz | self | smallest delta, exercises envelope pattern |
| vault backup (future) | encrypt-xyz | self | self-recipient = works in pre-alpha; pair with walrus for body |
| address book sync (future) | encrypt-xyz | self | self-recipient |
| activity notes >8KB (future) | encrypt-xyz | self | envelope + walrus body |
| x402 receipts (future) | encrypt-xyz | self | self-recipient |
| drain report → chromatika team (future) | direct-ed25519 | ed25519 | cross-recipient, encrypt.xyz pre-alpha gap |
| gift envelope (future) | direct-ed25519 | ed25519 | cross-recipient |
| P2P chat (future) | direct-ed25519 | ed25519 | cross-recipient |
| NFT-gated full-res media (future) | seal | sui-address | wants on-chain Move policy gating; encrypt.xyz can't express "any holder of NFT X" |

## How EncryptXyzBackend works (envelope pattern)

For payloads larger than ~64 bytes (the cap for direct multi-chunk EUint128 encryption used by labels), the backend uses an envelope:

1. Generate random 256-bit AES key K (32 bytes)
2. Body: AES-GCM-256(K, plaintext, iv) — encrypted off-chain in the wallet
3. K wrap: split K into chunk0 = K[0..16], chunk1 = K[16..32]; submit both as EUint128 inputs to encrypt.xyz `CreateInput` in a **single** gRPC round-trip → returns 2 ciphertext_identifier hexes
4. Persisted ref: `{ wrappedKeyCiphertextIdHexes, bodyCiphertextB64, bodyIvB64, recipientPubkeyB64, chain, programId }`. The body ciphertext can live anywhere - chrome.storage for activity notes, walrus blob for vault backup, solana account for x402 receipts.
5. Decrypt: signMessageSol on each of the 2 ciphertext_identifiers via `ReadCiphertext`, recover the chunks, reassemble K, AES-GCM-decrypt the body.

The chunking pattern matches the existing dWallet labels feature (4× EUint128 chunks for ≤64 utf-8 bytes); we just use 2 chunks because K is exactly 32 bytes.

## DirectEd25519Backend (shipped 2026-05-01)

Cross-recipient via X25519 ECDH + HKDF-SHA256 + AES-GCM-256. Replaces the prior stub. Architecture per option-b: each user has an HD-derived X25519 inbox keypair distinct from the dWallet ed25519 identity, used only for ECDH-decrypt.

**Wire format** ([`DirectEd25519Payload`](../src/background/encryption/types.ts)):

```
sender:
  (es, eP) = x25519.keygen()
  shared  = x25519(es, recipientX25519Pubkey)
  K       = HKDF-SHA256(shared, info='chromatika.direct-ed25519.envelope.v1', length=32)
  body    = AES-GCM-256.encrypt(K, plaintext, iv)
  ref     = { ephemeralPubkeyB64: eP, bodyCiphertextB64, bodyIvB64, recipientPubkeyB64 }

receiver:
  inboxSecret = x25519InboxSecretFromBytes(rootSecret, 0)
  shared      = x25519(inboxSecret, ephemeralPubkey)
  K           = HKDF-SHA256(shared, info='chromatika.direct-ed25519.envelope.v1', length=32)
  plaintext   = AES-GCM-256.decrypt(K, ciphertext, iv)
```

**Inbox key derivation** ([`hd.ts:x25519InboxSecretFromBytes`](../src/background/keyring/hd.ts)):

```
inboxSecret = keccak256(
  utf8('chromatika.inbox-x25519.v1') || rootSecret || index_le4
)
```

Root secret source varies by vault kind: bip39 mnemonic seed (hd), wallet signature over `IKA_USK_DERIVATION_MESSAGE` (hardware/seeker), or PRF hmac-secret output (passkey). Same source as the ika seed, but with a domain prefix so the two keys cannot collide.

**Cross-vault property**: the same Seeker on a fresh device produces the same inbox secret (deterministic from the wallet signature). Encrypted inbox messages survive reinstall.

**Trust + threat model**:
- The inbox X25519 secret is decoupled from the dWallet ed25519 MPC identity, so `decrypt` does NOT touch ika. No MPC round-trip per envelope.
- Sender lying about the recipient pubkey is detected on decrypt: the active vault's inbox pubkey is compared to `ref.recipientPubkeyB64`; mismatch surfaces `EncryptionBackendError(reason='wrong-vault')`.
- Tamper-resistance: AES-GCM auth tag fails cleanly on any modification of ciphertext / iv / wrong shared secret.
- Cap at 8KB inline body; pair with walrus for larger payloads (same envelope as before).

**Use cases this unlocks**: drain reports → chromatika team, gift envelopes, P2P chat.

**Tests**: [`direct-ed25519-backend.test.ts`](../src/background/encryption/direct-ed25519-backend.test.ts) covers round-trip, cross-vault, wrong-vault sanity, ciphertext tamper, iv tamper, ref-backend-tag rejection, deterministic inbox derivation, and ika-seed collision-freedom.

## Why SealBackend isn't shipped yet

~~Seal verifies the Mysten-standard `signPersonalMessage` signature, which uses BLAKE2b under the IntentScope. Chromatika's `sui_signPersonalMessage` uses ika's SHA-512 path instead.~~ **BLAKE2b parity shipped 2026-04-30** (see [`WALLET_SECURITY.md`](WALLET_SECURITY.md) "Dapp compatibility: Sui `signPersonalMessage`"). Chromatika now produces Mysten-standard personalMessage signatures, so Seal's `SessionKey` flow accepts them.

The remaining work to ship `SealBackend` is the actual implementation: wire `@mysten/seal` `SessionKey` against chromatika's now-Mysten-compatible `sui_signPersonalMessage`, plumb the Move-policy `seal_approve*` PTB construction, and decide on the per-vault key-server allowlist. Estimated 1-2 weeks once a Seal use case is queued (e.g. NFT-gated full-res media in tier 3 of the brainstorm).

Walrus uploads themselves do NOT depend on this gap (ordinary sui PTBs, not personalMessage). Walrus-as-body-storage works without any of this once we add the dep.

## Upstream contribution opportunity

A recipient-keyed PR to encrypt.xyz pre-alpha would:

1. Add `recipient_pubkey: bytes` to `CreateInputRequest` (proto change).
2. Update the executor mock to remember the per-recipient pubkey.
3. Update `ReadCiphertext` to populate the `reencryptionKey` field with bytes encrypted under the recipient's ed25519 → X25519 derived key (or whatever the production scheme will use).
4. Document the change in `references/grpc-api.md`.

A working pre-alpha PR would close the cross-recipient gap and let chromatika unify on encrypt.xyz for both self and cross use cases.

## Operational gotchas

- **encrypt.xyz devnet wipe**: ciphertexts may disappear when devnet wipes (this is part of pre-alpha policy and applies to all encrypt.xyz pre-alpha integrators). The backend translates "ciphertext not found" responses into `EncryptionBackendError(reason='devnet-wipe')` with a clear message. Long-lived envelopes (vault backup) need refresh / re-encrypt; broadcast channel's "missing pill" pattern from labels is the model.
- **pre-alpha disclaimer**: encrypt.xyz pre-alpha ciphertexts may be plaintext on-chain in the mock executor. Every UI surface that uses `EncryptionBackend` MUST show a "encrypt.xyz pre-alpha - dev preview" badge so users never confuse this with production-grade encryption. Never present this as production custody or confidentiality.
- **lock-state guard**: `decrypt` requires the active vault to be unlocked - the dWallet ed25519 sign that unwraps K can't run otherwise. tRPC procedures must use `authedProcedure` or equivalent.
- **wrong-vault errors**: encrypted refs are tied to the active vault's dWallet ed25519 pubkey at encrypt time. Switching vaults and clicking "decrypt" throws `EncryptionBackendError(reason='wrong-vault')` cleanly rather than producing a confusing downstream sign error.
- **K chunks land in the same gRPC round-trip**: `CreateInput` is a single round-trip for batched chunks. Wrap K (2 chunks) in one call; do not loop per chunk. The backend already does this.
- **decrypt is slow**: 2 sequential `signMessageSol` round-trips (one per K chunk), each is a real ika MPC sign + gRPC round-trip. ~1-3 seconds total on devnet. UI should spinner.
- **K bytes leak into JS heap**: the AES-GCM `CryptoKey` import requires K to exist as raw bytes briefly. The backend doesn't `K.fill(0)` because the imported `CryptoKey` holds a reference. Live with this until walrus-body / out-of-process key holding lands.

## API summary

```ts
import { getEncryptionBackend, decryptRefViaRegistry } from '@/background/encryption';

// Encrypt to active vault's own dWallet (self-recipient).
const backend = getEncryptionBackend('self-recipient-default'); // → EncryptXyzBackend
const ref = await backend.encryptForRecipient(new TextEncoder().encode('paid alice for rent'), { kind: 'self' });
// store `ref` somewhere (chrome.storage on tx-record, walrus, etc.)

// Decrypt later.
const plaintext = await decryptRefViaRegistry(ref); // dispatches by ref.backend
```

For cross-recipient:

```ts
const backend = getEncryptionBackend('cross-recipient-default'); // → DirectEd25519Backend (stub today)
await backend.encryptForRecipient(...); // throws EncryptionBackendError(reason='not-implemented')
```

## Related docs

- [`STATUS.md`](STATUS.md) - shipped / gated / future status index
- [`WALLET_SECURITY.md`](WALLET_SECURITY.md) - vault crypto + BLAKE2b parity tracking
