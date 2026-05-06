# ika seed: Solana base + BIP39 mnemonic

vault `seedSource: 'mnemonic'`, base chain `'solana'`. the Solana-base equivalent of [ika-seed-sui-mnemonic.md](/library/tech/ika-seed-sui-mnemonic). uses `ikaRootSeedFromSolanaKeypair` instead of `ikaRootSeedFromFeeKeypair` because Solana keypairs have a different canonical byte layout than Sui keypairs.

requires `VITE_SOLANA_IKA_BASE=true` in the build (Solana ika base is **pre-alpha** with a single mock signer; never trust for real value).

## inputs

- `mnemonic`: 12 or 24 BIP39 English words
- `accountIndex`: always `0` for the fee-payer
- `encryption_key_index`: always `0`

## step-by-step

```
1. validate mnemonic
   validateWords(mnemonic)

2. derive Solana ed25519 keypair at fee-payer path
   path = "m/44'/501'/0'/0'"   // 4 segments, all hardened, per Solana convention
   bip39_seed = mnemonicToSeedSync(mnemonic, "")   // 64-byte seed, hex-encoded
   childKey = slip10Ed25519DerivePath(path, bip39_seed_hex)   // SLIP10 ed25519 walk
   ed25519_seed_32 = childKey.key   // first 32 bytes of the derived node
   solKp = solana.Keypair.fromSeed(ed25519_seed_32)
   // Keypair.fromSeed produces canonical 64-byte secretKey:
   //   secretKey64 = [seed(32) || pubkey(32)]
   //   pubkey is computed as A = a*B from the clamped scalar derived from the seed

3. assemble keccak preimage
   indexLe = u32_le(0)
   preimage = solKp.secretKey || indexLe   // 64 + 4 = 68 bytes

4. hash
   seed_32 = keccak256(preimage)

5. derive both curves
   uskSecp = UserShareEncryptionKeys.fromRootSeedKey(seed_32, Curve.SECP256K1)
   uskEd25519 = UserShareEncryptionKeys.fromRootSeedKey(seed_32, Curve.ED25519)

6. zero seed_32
```

## why the canonical 64-byte secretKey

Solana's `Keypair.secretKey` is **always** 64 bytes by convention - the ed25519 seed (32) concatenated with the public key (32). this is the same shape Phantom and `solana-keygen` JSON-export use:

```
solana-keygen new -o keypair.json
cat keypair.json
# => "[12, 45, 233, ..., 12, 89, 76]"   // 64 numbers, the bytes
```

chromatika uses this exact 64-byte form as the keccak preimage so:

- importing a Phantom export produces the same secretKey64
- importing the same mnemonic into Phantom and into chromatika produces the same secretKey64
- → same ika seed across tools

## what gets stored

- `record.mnemonic`: 12 / 24 words, plaintext inside the encrypted vault payload
- `record.solanaSecretKeyB64`: not used for mnemonic vaults (mnemonic regenerates it)
- `record.ikaShareKeysB64`: serialized USK bytes for both curves
- `record.dwalletMeta` entries persist `dwalletAttestationBytesB64` + `dwalletPublicKeyB64` per Solana dWallet (a schema break vs `@ika.xyz/pre-alpha-solana-client@0.1.0` dev installs - re-run DKG after upgrade)

## the fee-payer keypair (Solana base specific)

on Solana base, the same mnemonic-derived Solana keypair is **also**:

- the in-extension fee-payer for ika gRPC `approve_message` calls (`ikaGrpcFeePayerSolSecretKeyB64` is set to `btoa(String.fromCharCode(...feeKp.secretKey))`)
- the canonical Solana wallet address for the dWallet Vault

so a mnemonic-rooted Solana-base vault has one keypair doing three jobs:

1. deriving the ika user-share encryption keys (via keccak256)
2. paying ika gRPC fees (via direct ed25519 sign)
3. signing native Solana transactions (via the dWallet flow if both curves are linked, or via `sendSolanaNative` if you opt into the HD direct path)

## restore on a new device

```
1. user types mnemonic on new install with VITE_SOLANA_IKA_BASE=true
2. importVault with baseChain='solana'
3. on first unlock with empty ikaShareKeysB64:
   - deriveSolanaKeypair(mnemonic, 0)
   - keccak preimage = solKp.secretKey || index_le
   - seed_32 = keccak256(preimage)
   - both curves derived
4. discoverDWallets walks the Solana ika program to find dWallets owned by this identity
```

deterministic per:

- BIP39 → seed (PBKDF2-HMAC-SHA512, deterministic)
- SLIP10 ed25519 derive at `m/44'/501'/0'/0'` (deterministic)
- `Keypair.fromSeed` → canonical 64-byte secretKey (deterministic, ed25519 RFC 8032)
- keccak256 (deterministic)

## what doesn't work

- **same mnemonic on Sui base**: produces a totally different identity. Sui-base uses `[scheme_flag(1) || secret(32)]` (33 bytes) as preimage, Solana-base uses `[seed(32) || pubkey(32)]` (64 bytes). different preimage → different keccak → different seed → different dWallet
- **importing a Phantom mnemonic that used a non-default derivation path**: chromatika hardcodes `m/44'/501'/0'/0'`. some old Phantom versions used different paths; if your Phantom address doesn't match what chromatika derives, the paths differ. there's no UI to override the path today
- **Solana ika base on production**: per the Solana ika pre-alpha disclaimer, all Solana ika signatures come from a single mock signer until ika ships production MPC. **do not** sign mainnet value with a Solana-base vault

## library

- `@scure/bip39` for `mnemonicToSeedSync`
- internal `slip10Ed25519DerivePath` helper for the SLIP10 ed25519 walk
- `@solana/web3.js` `Keypair.fromSeed`
- `@noble/hashes/sha3` `keccak_256`
- `@ika.xyz/sdk` `UserShareEncryptionKeys.fromRootSeedKey`
- internal: `wallet-extension/src/background/keyring/hd.ts` `makeSeedFromSolanaKeypair`, `ikaRootSeedFromSolanaKeypair`, `deriveSolanaKeypair`
