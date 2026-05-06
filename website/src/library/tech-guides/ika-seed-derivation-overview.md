# ika `UserShareEncryptionKeys` seed derivation overview

every chromatika dWallet has a per-curve `UserShareEncryptionKeys` (USK) - the local half of the ika 2PC-MPC threshold key. the USK is derived from a **32-byte root seed**. how the seed gets produced depends on the credential type the vault uses. this doc maps the matrix; the per-credential docs go deep on each path.

## the four root-seed factories

all four use `keccak256(preimage_bytes || encryption_key_index_le_4bytes)` (see [keccak256-uses.md](/library/tech/keccak256-uses)) - they only differ in **what `preimage_bytes` is**:

| factory                               | preimage_bytes                                                           | preimage length |
| ------------------------------------- | ------------------------------------------------------------------------ | --------------- |
| `ikaRootSeedFromFeeKeypair(suiKp)`    | `SuiKeyPair.to_bytes()` = `[scheme_flag(1) \|\| secret(32)]` for ed25519 | 33 bytes        |
| `ikaRootSeedFromSolanaKeypair(solKp)` | canonical 64-byte `Keypair.secretKey` (`[seed(32) \|\| pubkey(32)]`)     | 64 bytes        |
| `ikaRootSeedFromMwaSignature(sig)`    | raw 64-byte ed25519 signature over `IKA_USK_DERIVATION_MESSAGE`          | 64 bytes        |
| `ikaRootSeedFromPasskeyPRF(prf)`      | 32-byte WebAuthn PRF / hmac-secret output                                | 32 bytes        |
| `ikaRootSeedFromRecoveryWords(words)` | 64-byte BIP39 PBKDF2 seed (`mnemonicToSeedSync(words, "")`)              | 64 bytes        |

`encryption_key_index_le_4bytes` is the 4-byte LE encoding of a `u32` index. almost always `0` for the primary user-share key. an index > 0 would be how you produce a sibling user-share key from the same credential without collision (not exposed in the API today).

after derivation:

```
seed_32 = keccak256(preimage || index_le)
ikaUskSecpk1 = UserShareEncryptionKeys.fromRootSeedKey(seed_32, Curve.SECP256K1)
ikaUskEd25519 = UserShareEncryptionKeys.fromRootSeedKey(seed_32, Curve.ED25519)
seed_32.fill(0)   // zero the buffer to limit memory lifetime
```

both curves are derived from the same seed - meaning a single chromatika vault can have one SECP256K1 dWallet (for EVM, BTC) and one ED25519 dWallet (for Sui, Solana, Aptos), and they share an "identity" rooted in this same 32-byte seed.

## per-credential matrix

| credential                        | base chain    | factory used                    | how preimage gets produced                                                   |
| --------------------------------- | ------------- | ------------------------------- | ---------------------------------------------------------------------------- |
| BIP39 mnemonic                    | Sui           | `ikaRootSeedFromFeeKeypair`     | mnemonic → SLIP10 ed25519 derive `m/44'/784'/0'/0'/0'` → Sui ed25519 keypair |
| BIP39 mnemonic                    | Solana        | `ikaRootSeedFromSolanaKeypair`  | mnemonic → BIP39 seed → SLIP10 derive `m/44'/501'/0'/0'` → Solana keypair    |
| imported `suiprivkey…` bech32     | Sui           | `ikaRootSeedFromFeeKeypair`     | bech32 decode → Ed25519Keypair.fromSecretKey                                 |
| imported 64-byte solana b64       | Solana        | `ikaRootSeedFromSolanaKeypair`  | b64 decode → Keypair.fromSecretKey                                           |
| Passkey (WebAuthn PRF)            | Sui only      | `ikaRootSeedFromPasskeyPRF`     | webauthn assertion with `prf.eval.first` salt → 32-byte HMAC-secret output   |
| WAAP (deterministic)              | Sui only      | `ikaRootSeedFromMwaSignature`   | WAAP signs `IKA_USK_DERIVATION_MESSAGE` → 64-byte sig                        |
| WAAP (non-deterministic fallback) | Sui only      | `ikaRootSeedFromRecoveryWords`  | user provides BIP39 phrase → mnemonicToSeedSync                              |
| Lazor                             | Solana only   | `ikaRootSeedFromRecoveryWords`  | required BIP39 phrase → mnemonicToSeedSync                                   |
| Seeker MWA (local + remote)       | Solana        | `ikaRootSeedFromMwaSignature`   | wallet signs `IKA_USK_DERIVATION_MESSAGE` → 64-byte sig                      |
| WalletConnect                     | Solana        | `ikaRootSeedFromMwaSignature`   | wallet signs `IKA_USK_DERIVATION_MESSAGE` → 64-byte sig                      |
| Ledger key-copy                   | Sui or Solana | (none - copy from source vault) | `ikaShareKeysB64` copied verbatim from another vault's record                |

## the `IKA_USK_DERIVATION_MESSAGE` constant

```
IKA_USK_DERIVATION_MESSAGE = "ika.chromatika.user-share-encryption-key.v1"
```

UTF-8 bytes. defined in `wallet-extension/src/background/keyring/hd.ts`. used by all signature-based seed derivation paths (Seeker, WalletConnect, WAAP-deterministic). signing this fixed string produces a deterministic 64-byte ed25519 signature per RFC 8032 - we keccak256 that with the index to get the seed.

**this is a different message than vault-unlock challenges**. unlock challenges include vault id + envelope id; this is a constant. the same wallet on the same key produces the same signature here, regardless of which chromatika vault is asking.

## why curves share a seed

ika's `UserShareEncryptionKeys.fromRootSeedKey(seed, curve)` performs internal domain separation per curve. the same seed produces different USK material for SECP256K1 and ED25519 - they're not the same key, just rooted in the same entropy. a single chromatika vault can drive both curves from one user identity without collision.

if you need **different identities** per curve (e.g. one for "personal" SECP256K1 and one for "work" ED25519), that's two different vaults, not two indices on the same vault.

## where the seed lives in memory

- derived in `buildIkaShareKeys(makeSeed, stored)` in the keyring helper
- `seed = makeSeed()` returns the 32 bytes
- `UserShareEncryptionKeys.fromRootSeedKey(seed, curve)` is called once per curve
- `seed.fill(0)` zeros the buffer
- the seed is **never stored** - it's re-derived on every unlock from the vault's credential material (or skipped if both curves are already in `record.ikaShareKeysB64`)
- only the resulting **`UserShareEncryptionKeys` serialized bytes** are persisted (encrypted in the vault payload)

this means: lose the credential, lose the ability to re-derive the seed. but if `ikaShareKeysB64` is already populated (and the user knows the password to decrypt the vault), they can still load the USK without re-deriving from the seed source.

## library

- `wallet-extension/src/background/keyring/hd.ts` - the canonical home of `ikaRootSeed*` helpers, `makeSeedFrom*` factory functions, `makeSeedForHdVault`, and `buildIkaShareKeys`
- `@noble/hashes/sha3` for `keccak_256`
- `@ika.xyz/sdk` `UserShareEncryptionKeys.fromRootSeedKey`
- `@scure/bip39`, `@noble/ed25519`, `@solana/web3.js` `Keypair`, `@mysten/sui` `Ed25519Keypair` for keypair production

## per-credential deep dives

- [ika-seed-sui-mnemonic.md](/library/tech/ika-seed-sui-mnemonic)
- [ika-seed-sui-private-key.md](/library/tech/ika-seed-sui-private-key)
- [ika-seed-sui-passkey.md](/library/tech/ika-seed-sui-passkey)
- [ika-seed-sui-waap.md](/library/tech/ika-seed-sui-waap)
- [ika-seed-sui-ledger-keycopy.md](/library/tech/ika-seed-sui-ledger-keycopy)
- [ika-seed-solana-mnemonic.md](/library/tech/ika-seed-solana-mnemonic)
- [ika-seed-solana-private-key.md](/library/tech/ika-seed-solana-private-key)
- [ika-seed-solana-mwa-walletconnect.md](/library/tech/ika-seed-solana-mwa-walletconnect)
- [ika-seed-solana-ledger-keycopy.md](/library/tech/ika-seed-solana-ledger-keycopy)
- [ika-seed-solana-lazor.md](/library/tech/ika-seed-solana-lazor)
