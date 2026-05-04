# ed25519 EdDSA in chromatika

ed25519 is the elliptic curve + signature scheme that Sui, Solana, Aptos, ika ED25519 dWallets, and a chunk of the WebAuthn surface use. chromatika does **not** locally sign with ed25519 except for HD fee-payer Sui sends - everything else routes through ika MPC (2PC-MPC ED25519 EDDSA) or hardware wallets.

## the curve

- curve: Edwards25519 (twisted Edwards form of curve25519)
- secret seed: 32 bytes (the "key" you generate / hold)
- secret scalar: derived deterministically from the seed via SHA-512(seed) → first 32 bytes clamped → scalar `a`
- public key: 32-byte point `A = a * B` where `B` is the base point
- canonical Solana / Phantom / `solana-keygen` "secret key" format: 64 bytes = `[seed(32) || pubkey(32)]`. this is the format that feeds `ikaRootSeedFromSolanaKeypair`

## signature shape

per RFC 8032, an ed25519 signature is 64 bytes = `R(32) || S(32)`. signing produces:
```
nonce_prefix = SHA-512(seed)[32..64]
r = SHA-512(nonce_prefix || message) mod L   // L = curve order
R = r * B
k = SHA-512(R || A || message) mod L
S = (r + k * a) mod L
sig = R || S
```

verify:
```
check 8 * S * B == 8 * R + 8 * SHA-512(R || A || message) * A
```

## the determinism property (RFC 8032)

ed25519 is **deterministic**: signing the same message with the same key produces the **same signature, every time**. this matters because chromatika's Solana hardware-vault flow (Seeker remote, WalletConnect) leans on this:

```
seeker.sign(IKA_USK_DERIVATION_MESSAGE = "ika.chromatika.user-share-encryption-key.v1")
  → 64-byte signature (deterministic)
ika_user_share_seed = keccak256(signature || encryption_key_index_le)
```

restore on a new device works because:
1. user pairs the same Seeker
2. asks Seeker to sign the same message
3. RFC 8032 determinism = same signature
4. same keccak preimage = same ika seed
5. same ika user-share encryption key = same dWallet

if Seeker (or any wallet) used a non-deterministic ed25519 implementation, this restore-on-new-device flow would fail. chromatika probes WAAP wallets at pairing time (sign twice, compare) to detect non-determinism and fall back to the recovery-words branch instead.

## ika ED25519 EDDSA signing path

ika MPC produces an ed25519 signature for a given preimage:

```
1. chromatika hands ika the message bytes (raw, not pre-hashed)
2. ika MPC servers + chromatika local share collaboratively run the EdDSA protocol
3. internally ika hashes with SHA-512 per RFC 8032
4. result: 64-byte (R || S) ed25519 signature
5. parseSignatureFromSignOutput(Curve.ED25519, SignatureAlgorithm.EdDSA) returns (R, S)
```

**rule**: pass raw bytes, not a digest. ika hashes internally per RFC 8032.

## the Sui SHA-512 vs Mysten BLAKE2b divergence

`sui_signPersonalMessage` is where ika and Mysten disagree. ika hands the raw user message to its EdDSA protocol → SHA-512 → R, S. Mysten's native flow wraps the message in an intent prefix and then BLAKE2b-256s it before ed25519 signing. dapps that use Mysten's `verifyPersonalMessageSignature` won't accept the ika sig until the BLAKE2b-intent path is added. see [sha512-and-blake2b.md](/library/tech/sha512-and-blake2b).

## ika curve / signature-algorithm constants

ika's protocol numbers (from CLAUDE.md):
- `Curve.SECP256K1 = 0`
- `Curve.SECP256R1 = 1`
- `Curve.ED25519 = 2`
- `Curve.RISTRETTO = 3`
- `SignatureAlgorithm.ECDSASecp256k1 = 0`
- `SignatureAlgorithm.Taproot = 1`
- `SignatureAlgorithm.ECDSASecp256r1 = 2`
- `SignatureAlgorithm.EdDSA = 3`
- `SignatureAlgorithm.SchnorrkelSubstrate = 4`

`fromCurveToNumber` is **not** exported from `@ika.xyz/sdk` main entry (it's internal to `hash-signature-validation.js`). if you need the mapping, hardcode the constants above; don't try to import the helper.

## chain-side public-key serialization

different chains serialize ed25519 public keys differently:
- **Sui**: `flag_byte || pubkey(32)` where `flag_byte = 0x00` for ed25519. address = `blake2b_256(flag || pubkey)`
- **Solana**: bare 32-byte pubkey, address = base58 of pubkey (no hash)
- **Aptos**: `blake2b_256(pubkey || 0x00)` for single-key (legacy). multi-key uses different layout
- **WebAuthn (passkey)**: COSE-encoded pubkey (cbor wrapping), or compressed secp256r1 - **not ed25519** for passkey vaults. WebAuthn supports both ed25519 and secp256r1 as algorithms; chromatika passkey vaults use **secp256r1** today (Sui SIP-9 with flag `0x06`)

## libraries

- `@noble/ed25519` for ed25519 keypair construction, signing, verification
- `@solana/web3.js` `Keypair` for Solana-side keypair serialization
- `@mysten/sui` `Ed25519Keypair` for Sui-side keypair serialization (wraps `@noble/ed25519`)
- ika MPC for the actual signature production (chromatika holds half the share, ika servers hold the other half)

## what chromatika does **not** do locally

- chromatika does not locally produce ed25519 signatures over user-facing messages. all such signing goes through ika MPC (or hardware via WebHID / MWA / WC)
- the **exception** is Sui HD fee-payer signing for `sendSuiNative` and the Sui PTB ops that pay fees - those use the locally-derived ed25519 keypair to sign the Sui transaction. this is a "we hold the gas key in software" tradeoff documented elsewhere
- locally-derived public keys (e.g. for address display, BLAKE2b-of-pubkey for Sui addresses) are computed without signing - those are pure derivations, no signing involved
