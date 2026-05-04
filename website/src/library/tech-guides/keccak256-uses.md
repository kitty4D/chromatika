# keccak256 in chromatika

keccak256 is the unmodified-padding variant of the SHA-3 family that ethereum standardized on (note: NIST's SHA3-256 uses a different padding rule and produces different output for the same input). chromatika uses keccak256 in three places, all of them load-bearing.

## 1. ika `UserShareEncryptionKeys` root seed derivation

every ika user-share encryption key chromatika derives, regardless of base chain, runs through this 32-byte keccak output. the formula is always:

```
seed_32 = keccak256(preimage_bytes || encryption_key_index_le_4bytes)
```

`encryption_key_index` is a `u32` little-endian, almost always `0` for the primary user-share key. `preimage_bytes` differs per credential type (see [ika-seed-derivation-overview.md](/library/tech/ika-seed-derivation-overview) and the per-credential docs):

- **Sui base + keypair-based credential** (`ikaRootSeedFromFeeKeypair`): preimage = full `SuiKeyPair.to_bytes()` = `[scheme_flag(1) || secret_key(32)]` = 33 bytes. for ed25519 that's `0x00 || secret`. total preimage 33 + 4 = 37 bytes.
- **Solana base + keypair-based credential** (`ikaRootSeedFromSolanaKeypair`): preimage = canonical 64-byte `Keypair.secretKey` (`[seed(32) || pubkey(32)]` per ed25519 RFC 8032). total preimage 64 + 4 = 68 bytes.
- **Solana hardware (MWA / Seeker / WalletConnect)** (`ikaRootSeedFromMwaSignature`): preimage = the raw 64-byte ed25519 signature over `IKA_USK_DERIVATION_MESSAGE`. total preimage 64 + 4 = 68 bytes.
- **Passkey (Sui base)** (`ikaRootSeedFromPasskeyPRF`): preimage = the 32-byte WebAuthn PRF / hmac-secret output. total preimage 32 + 4 = 36 bytes.
- **Recovery words / Lazor / WAAP-fallback** (`ikaRootSeedFromRecoveryWords`): preimage = the BIP39 PBKDF2-derived 64-byte seed (`mnemonicToSeedSync(words)`). total preimage 64 + 4 = 68 bytes.

after derivation the seed is fed into `UserShareEncryptionKeys.fromRootSeedKey(seed, curve)` - one call per curve (SECP256K1 + ED25519). the seed buffer is zeroed (`seed.fill(0)`) immediately after to limit lifetime in memory.

## 2. EVM transaction digesting + signature `v` recovery

EVM signing (`signBytesEvm`) hands ika the **preimage** bytes - either `tx.unsignedSerialized` for a transaction send or the EIP-191 wrapped bytes for `personal_sign` - and ika hashes once internally with KECCAK256. chromatika **never** double-hashes; passing the digest already-hashed would cause ika to keccak256 the digest again and produce a totally wrong recovered address.

after the 64-byte compact `r||s` sig comes back, chromatika computes the digest itself via `keccak256(unsignedSerialized)` and tries `recoverAddress(digest, { r, s, v: 27 })` and `v: 28`. whichever recovers to the dWallet's known EVM address wins. for typed-data v4 the same rule applies: pass `TypedDataEncoder.encode(...)` (preimage), not `TypedDataEncoder.hash(...)`.

## 3. EVM address derivation

an EVM address = `last 20 bytes of keccak256(uncompressed_public_key_64bytes)` per yellow paper. dWallet ed25519 / secp256k1 public keys are derived per ika; chromatika applies the keccak rule to produce the EIP-55 checksummed address surfaced via `getEvmAddress` (and `dwalletAddressBook` / `getDwalletChainAddresses`).

## library

provided by `@noble/hashes` (`keccak_256` from `@noble/hashes/sha3`). pure-JS, no wasm. zero deps beyond `@noble/hashes` itself. faster than the historical js-keccak-bundle and audit-grade per noble's release process.

## not used for

- BLAKE2b (Sui native PersonalMessage intent digest)
- SHA-512 (ika ed25519 signing path)
- SHA-256 (BIP39 PBKDF2, BIP32 HMAC, Bitcoin tx ids - all separate primitives)

if you see code that keccak256's something it shouldn't (e.g. running it on an already-keccaked digest, or substituting for BLAKE2b in the Sui flow), that's a bug - flag it, don't merge it.
