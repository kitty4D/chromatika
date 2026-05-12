# wallet-signature envelope

a chromatika vault can be unlocked by having an external wallet (WAAP / Seeker / Phantom-Solflare-Jupiter via WC) sign a fixed challenge string. the signature is then HKDF'd into an envelope key that unwraps the master key. relies on RFC 8032 ed25519 deterministic signing - same key + same message = same signature, every assertion.

## envelope record

```jsonc
{
  "kind": "wallet-signature",
  "source": "waap" | "seeker" | "walletconnect",
  "address": "<chain address that signs>",
  "label": "Seeker phone",
  "hint": "email" | "phone" | "google" | "discord" | ... | null,
  "challenge": "<the deterministic message bytes the wallet signs>",
  "kdfSaltB64": "<32 random bytes for HKDF salt>",
  "wrappedMasterKeyB64": "<AES-GCM(envKey, masterKey, iv)>",
  "envIvB64": "<12 random bytes>"
}
```

## the challenge

a fixed UTF-8 string the wallet always signs to unlock. typical content is a domain-separated phrase like:

```
"chromatika.unlock.v1\n" + envelope.id + "\n" + vault.id
```

the exact format is whatever `buildWalletSignatureEnvelope` constructs - includes envelope id and vault id so a captured signature for one envelope can't be replayed against another.

## creation (pairing)

```
1. user pairs the wallet (MWA local / MWA remote / WalletConnect / WAAP login)
2. wallet returns: address, public-key, transport metadata
3. determinism probe (only for WAAP-style wallets that may be non-deterministic):
   - sign challenge twice
   - if signatures differ → wallet is non-deterministic → fall back to recovery-words envelope, do NOT create a wallet-signature envelope
4. challenge = build_challenge(envelope_id, vault_id)
5. signature = wallet.signMessage(challenge) // 64-byte ed25519 sig
6. envKey = HKDF-SHA256(signature, info='chromatika wallet-signature envelope v1', salt=kdfSalt)
7. wrappedMK = AES-GCM(envKey, masterKey, randomIv)
```

the **signature itself** is not stored. only the wrapped masterKey. on every unlock, the wallet must re-sign the challenge to produce the same signature → same envKey → unwrap.

## unlock

```
1. read envelope.challenge + envelope.kdfSalt
2. wallet.signMessage(challenge)   // re-sign deterministically
3. envKey = HKDF-SHA256(signature, info='chromatika wallet-signature envelope v1', salt=kdfSalt)
4. masterKey = AES-GCM.decrypt(envKey, wrappedMasterKey, envIv)
5. session unlocks
```

## per-source notes

### Seeker (MWA remote)

- transport: `wss://reflect.solanamobile.com` reflector + persisted `auth_token`
- subsequent unlocks reauthorize against the cached `auth_token` to skip the QR rescan
- `ERROR_AUTHORIZATION_FAILED` from the wallet → `MwaSigner` flips into `needsRepair` state → re-pair via fresh QR
- the same Seeker on a different device produces the same signature (RFC 8032 determinism + Seed Vault holds the same secret) → unlock works on a fresh chromatika install with the same Seeker

### MWA local (Android same-device)

- transport: Android intent (`solana-wallet://`)
- only works when chromatika and the wallet app are on the same Android device
- otherwise identical to remote in terms of envelope structure

### WalletConnect

- transport: WalletConnect v2 relay
- session token + `topic` persisted on the envelope record
- session lives until revoked phone-side. on revoke, unlock fails with an actionable "re-pair WalletConnect" error

### WAAP

- transport: @human.tech web flow (email / phone / social login)
- WAAP may be deterministic (signature stable across sessions) or non-deterministic (e.g. randomized nonce in some flows)
- chromatika **probes** at pairing - sign twice, compare. if non-deterministic, no wallet-signature envelope is created; recovery-words is required instead

## determinism is mandatory

if any of these wallets ever produced different signatures for the same challenge between assertions, the envKey would change and unlock would fail. RFC 8032 mandates deterministic ed25519 signing - the secret expands to a deterministic per-message scalar, so given the same key + same message there is one and only one valid signature.

bitcoin / ECDSA wallets that use RFC 6979 are **also** deterministic - chromatika could in theory support a secp256k1 wallet-signature envelope, though today the surface is ed25519-only.

## the "ika USK derivation" overlap

note: the **vault unlock** challenge and the **ika user-share encryption key** derivation message (`'ika.chromatika.user-share-encryption-key.v1'`) are **different messages**. unlock signs the unlock challenge to get the envelope key. ika seed derivation signs the IKA_USK_DERIVATION_MESSAGE constant separately, and `keccak256(signature)` of that becomes the seed. two different signatures from the same wallet, two different cryptographic purposes.

## attack model

- **offline brute force**: useless. signature is high-entropy ed25519 output (~256 bits). HKDF can't be reversed without the signature.
- **wallet compromise**: if attacker controls the wallet device (Seeker stolen, Phantom seed leaked), they can produce the signature → unlock the chromatika vault. **this is by design** - if your hardware wallet is compromised, all derived flows are too. the recovery-words envelope provides an out-of-band fallback that doesn't depend on the wallet device.
- **transport replay**: signed message includes envelope id + vault id, so a captured signature for one vault doesn't unlock another. WC / MWA also include their own session-level auth.

## library

- transport-specific:
  - MWA: `@solana-mobile/mobile-wallet-adapter-protocol-web3js`
  - WalletConnect: `@walletconnect/sign-client`
  - WAAP: `@human.tech/waap-sdk`
- internal helpers: `buildWalletSignatureEnvelope(mk, sigBytes, { source, address, label, hint })`, `unlockWalletSignatureEnvelope(envelope, signature)`
- HKDF: `crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info })`
