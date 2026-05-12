# ika seed: Sui base + BIP39 mnemonic

vault `seedSource: 'mnemonic'`, base chain `'sui'`. this is the canonical "fresh chromatika install with 12 or 24 words" path.

## inputs

- `mnemonic`: 12 or 24 BIP39 English words (validated checksum)
- `accountIndex`: always `0` for the fee-payer (and thus the ika seed source)
- `encryption_key_index`: always `0` for the primary user-share key

## step-by-step

```
1. validate mnemonic
   validateWords(mnemonic) → throws if invalid

2. derive Sui ed25519 keypair at fee-payer path
   path = "m/44'/784'/0'/0'/0'"
   suiKp = Ed25519Keypair.deriveKeypair(mnemonic, path)
   // Ed25519Keypair.deriveKeypair internally:
   //   - mnemonicToSeedSync(mnemonic, "")              // PBKDF2-HMAC-SHA512 2048 rounds → 64-byte seed
   //   - SLIP10-ed25519 derive at path                 // hardened-only steps, HMAC-SHA512
   //   - returns Ed25519Keypair with secret + pubkey

3. extract canonical Sui keypair bytes
   suiKpBytes = decodeSuiPrivateKey(suiKp.getSecretKey())
   // decodeSuiPrivateKey decodes the bech32 'suiprivkey…' form
   // returns { scheme: 'ED25519', secretKey: Uint8Array(32) }
   suiKpBytesPreimage = [scheme_flag(0x00) || secretKey(32)]   // 33 bytes total

4. assemble the keccak preimage
   indexLe = u32_le(0)   // [0x00, 0x00, 0x00, 0x00]
   preimage = [scheme_flag(1) || secretKey(32) || indexLe(4)]   // 37 bytes

5. hash
   seed_32 = keccak256(preimage)

6. derive both curves
   uskSecp = UserShareEncryptionKeys.fromRootSeedKey(seed_32, Curve.SECP256K1)
   uskEd25519 = UserShareEncryptionKeys.fromRootSeedKey(seed_32, Curve.ED25519)

7. zero
   seed_32.fill(0)
```

## what gets stored

- `record.mnemonic`: the 12 / 24 words, **plaintext inside the encrypted vault payload**
- `record.suiPrivateKeyBech32`: not used for mnemonic vaults (the mnemonic regenerates it on demand)
- `record.ikaShareKeysB64`: the serialized USK bytes for both curves

on subsequent unlocks, the wallet can either:
- **re-derive** the USK from `record.mnemonic` → `Ed25519Keypair.deriveKeypair(...)` → `ikaRootSeedFromFeeKeypair(...)` (slow-ish, but reproducible)
- **deserialize** from `record.ikaShareKeysB64` directly (faster, doesn't touch the mnemonic)

`buildIkaShareKeys(makeSeed, stored)` picks: if `stored` has both curves, deserialize; else, call `makeSeed()` (which here is `makeSeedFromSuiKeypair(suiKp)`) and run `fromRootSeedKey` on each missing curve.

## fee-payer keypair coincidence

the same Sui keypair derived for the ika seed (`m/44'/784'/0'/0'/0'`, account 0) is **also** the fee-payer keypair that signs:
- `sendSuiNative` HD transfers
- ika DKG / presign / sign PTBs (via `IkaTransaction` on Sui base)
- any Sui-side gas funding

this is intentional - one keypair handles both "ika identity root" and "Sui gas funder" roles for mnemonic vaults. for hardware-vault flows where the keypair lives on the device and not in the extension, fee-payer signing dispatches to the device.

## restore on a new device

```
1. user types mnemonic on new chromatika install
2. importVault → mnemonic stored in fresh vault payload
3. on first unlock, since record.ikaShareKeysB64 is empty for this fresh record:
   - makeSeed = makeSeedFromSuiKeypair(deriveSuiKeypair(mnemonic))
   - seed = makeSeed()
   - both curves derived
4. discoverDWallets(curve) walks Sui chain looking for dWallets owned by the recovered USK addresses
5. dWallets that exist on-chain reattach to the new install
```

deterministic because:
- BIP39 → BIP39 seed via PBKDF2 (deterministic)
- BIP39 seed → SLIP10 derivation (deterministic)
- SLIP10 → ed25519 keypair (deterministic)
- keccak preimage = same bytes on any device (deterministic)
- keccak256 = deterministic
- USK derivation (deterministic)

→ same mnemonic + same path + same index = same USK = same dWallet.

## what doesn't work

- **swapping base chain**: same mnemonic on Solana base does **not** produce the same dWallet identity. Solana base uses a different keypair derivation path (`m/44'/501'/0'/0'`), a different keypair format (Solana's 64-byte secretKey vs Sui's 33-byte bech32-decoded form), and therefore a different keccak preimage. cross-chain mnemonic reuse is supported in the UI for convenience (one phrase, two vaults) but they're **two different identities**.
- **changing word count after creation**: the seed is path-dependent on the mnemonic - changing the mnemonic = different vault. you can `addVault` to keep both.

## library

- `@scure/bip39` for mnemonic + `mnemonicToSeedSync`
- `@mysten/sui` `Ed25519Keypair.deriveKeypair`, `decodeSuiPrivateKey`
- `@noble/hashes/sha3` `keccak_256`
- `@ika.xyz/sdk` `UserShareEncryptionKeys.fromRootSeedKey`
- internal: `wallet-extension/src/background/keyring/hd.ts` `makeSeedFromSuiKeypair`, `ikaRootSeedFromFeeKeypair`, `makeSeedForHdVault`, `deriveSuiKeypair`
