# ika seed: Sui base + imported private key

vault `seedSource: 'private-key'`, base chain `'sui'`. user supplies a `suiprivkey…` bech32 string (the export format Sui Wallet, sui-keytool, etc. use). chromatika reconstructs the keypair, derives the ika seed exactly like a mnemonic vault would.

## inputs

- `suiPrivateKeyBech32`: a string like `suiprivkey1qz…` (bech32 encoding of `[scheme_flag(1) || secret(32)]`)
- `encryption_key_index`: always `0`

## step-by-step

```
1. parse the bech32 input
   { scheme, secretKey } = decodeSuiPrivateKey(suiPrivateKeyBech32)
   // scheme can be 'ED25519', 'Secp256k1', 'Secp256r1' per Sui spec
   // chromatika asserts scheme === 'ED25519' for ika seed derivation

2. construct the Sui keypair
   suiKp = Ed25519Keypair.fromSecretKey(secretKey)
   // accepts the 32-byte raw ed25519 secret seed; computes pubkey internally

3. assemble keccak preimage (identical to the mnemonic path from this point)
   suiKpBytes = [scheme_flag(0x00) || secret(32)]   // 33 bytes
   indexLe = u32_le(0)
   preimage = suiKpBytes || indexLe   // 37 bytes total

4. hash
   seed_32 = keccak256(preimage)

5. derive both curves
   uskSecp = UserShareEncryptionKeys.fromRootSeedKey(seed_32, Curve.SECP256K1)
   uskEd25519 = UserShareEncryptionKeys.fromRootSeedKey(seed_32, Curve.ED25519)

6. zero seed_32
```

step 3 onward is **identical** to [ika-seed-sui-mnemonic.md](/library/tech/ika-seed-sui-mnemonic). the only difference is how the keypair is produced - imported from bech32 vs derived from a mnemonic.

## what gets stored

- `record.suiPrivateKeyBech32`: the bech32 string, plaintext inside the encrypted vault payload
- `record.mnemonic`: not used (private-key vaults skip BIP39)
- `record.ikaShareKeysB64`: serialized USK bytes for both curves

on subsequent unlocks, the wallet either deserializes from `ikaShareKeysB64` or re-derives via `Ed25519Keypair.fromSecretKey(...)` → `ikaRootSeedFromFeeKeypair(...)`.

## restore on a new device

```
1. user pastes the same suiprivkey… bech32 on a new install
2. importVaultFromPrivateKey → key stored in fresh vault payload
3. on first unlock with empty ikaShareKeysB64:
   - reconstruct Ed25519Keypair from secretKey
   - keccak preimage = scheme_flag || secret || index_le
   - seed = keccak256(preimage)
   - both curves derived
4. discoverDWallets walks Sui to find dWallets owned by the recovered identity
```

deterministic. same private key = same keypair = same preimage = same seed = same dWallet.

## what doesn't work

- **secp256k1 / secp256r1 Sui keypairs**: chromatika asserts `scheme === 'ED25519'`. Sui supports those schemes for native signing but ika seed derivation is the ed25519 path only today. importing a non-ed25519 sui privkey rejects at the API boundary.
- **cross-chain reuse**: a Sui privkey is **not** a Solana privkey - the curves and key formats differ. you cannot import a `suiprivkey…` under Solana base. the cross-chain reuse path (BIP39 mnemonic on both bases) only works for mnemonic vaults.

## key handling caveat

importing a private key permanently anchors that key inside the chromatika vault payload. if the user wanted to "rotate" the key (move funds to a new identity), that's a new vault, not an in-place rotation - chromatika can't re-derive a different identity from the same imported key.

contrast: hardware vaults (Ledger / Seeker) can rotate the **fee-payer** keypair without touching the **ika identity** because the two are decoupled there. mnemonic and private-key vaults conflate them.

## library

- `@mysten/sui` `Ed25519Keypair.fromSecretKey`, `decodeSuiPrivateKey`
- `@noble/hashes/sha3` `keccak_256`
- `@ika.xyz/sdk` `UserShareEncryptionKeys.fromRootSeedKey`
- internal: `makeSeedFromSuiKeypair`, `ikaRootSeedFromFeeKeypair` from `keyring/hd.ts`
