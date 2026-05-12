# ika seed: Solana base + MWA / WalletConnect signature

vault `seedSource: 'mwa-signature'` or `'walletconnect-signature'`, base chain `'solana'`. the wallet (Seeker built-in, Phantom Android, Solflare Android, Jupiter, or any MWA-2.0-compliant wallet via WalletConnect) signs `IKA_USK_DERIVATION_MESSAGE` once at pairing time. that 64-byte ed25519 signature is keccak-hashed into the ika seed. RFC 8032 determinism guarantees the same wallet on a different device produces the same signature → same dWallet → restore-on-new-device works without any seed phrase.

this is the **canonical hardware-rooted Solana base path**. the wallet's secret bytes never leave the device.

## the IKA USK derivation message

```
IKA_USK_DERIVATION_MESSAGE = "ika.chromatika.user-share-encryption-key.v1"
```

UTF-8 bytes. defined in `wallet-extension/src/background/keyring/hd.ts`. fixed across all chromatika installs and wallets. signing this exact string produces a deterministic ed25519 signature for any RFC 8032 conforming implementation.

## inputs

- `signature`: 64-byte ed25519 signature over `IKA_USK_DERIVATION_MESSAGE` produced by the paired wallet
- `encryption_key_index`: always `0` for the user-share key
- (separately) `feePayerKeypairIndex`: `1` for the in-extension fee-payer keypair derivation - using a different index avoids collision

## step-by-step (ika user-share seed)

```
1. wallet pairs (MWA local intent / MWA remote QR / WalletConnect QR)
   - returns: address (base58), ed25519PublicKey (b64), session metadata

2. wallet signs the IKA_USK_DERIVATION_MESSAGE
   - via MWA: transact() with sign-message intent
   - via WC: enqueueHardwareSign({ vendor: 'walletconnect', kind: 'solanaTx' or 'solanaMessage', ... })
   - returns 64-byte raw ed25519 signature

3. assemble keccak preimage
   indexLe = u32_le(0)
   preimage = signature_64 || indexLe   // 68 bytes

4. hash
   seed_32 = keccak256(preimage)

5. derive both curves
   uskSecp = UserShareEncryptionKeys.fromRootSeedKey(seed_32, Curve.SECP256K1)
   uskEd25519 = UserShareEncryptionKeys.fromRootSeedKey(seed_32, Curve.ED25519)

6. zero seed_32
```

## step-by-step (in-extension fee-payer keypair)

ika on Solana needs an SOL-paying keypair for `approve_message` gRPC fees. since Seed Vault never reveals secret bytes, chromatika derives an **in-extension** Solana keypair from the same wallet signature, but at a different index to avoid collision:

```
1. preimage_fee = signature_64 || u32_le(1)   // index 1, not 0
2. fee_seed_32 = keccak256(preimage_fee)
3. feeKp = Keypair.fromSeed(fee_seed_32)
4. feeKp.secretKey is a deterministic 64-byte canonical Solana keypair
5. encode as b64 and persist in record.ikaGrpcFeePayerSolSecretKeyB64
```

determinism: same wallet signature + same index = same keccak output = same ed25519 seed → same fee-payer address. user can fund the fee-payer with ~0.1 devnet SOL once, and on a new install the same Seeker re-pairs, signs the same message, derives the same fee-payer address, and the SOL is right there waiting.

## what gets stored

- `record.hardwareAccountId`: the paired hardware account
- `record.hardwareVendor`: `'mwa'` or `'walletconnect'`
- `record.hardwareChain`: `'solana'`
- `record.mwaTransport`: `'local'` (Android same-device) or `'remote'` (desktop ↔ phone QR)
- `record.ikaUskSignatureB64`: the **encrypted** signature (inside a `WalletSignatureEnvelope` for unlock)
- `record.ikaShareKeysB64`: USK bytes for both curves
- `record.ikaGrpcFeePayerSolSecretKeyB64`: the deterministic fee-payer keypair (b64), if `feeMode === 'in_extension'`
- `record.ledgerFeePayerSolPubkeyB58`: the **paired wallet's** Solana address (NOT the fee-payer; this is the phone wallet's address - misnamed historically)
- `record.solanaSecretKeyB64`: not present (no software user-key import)
- `record.mnemonic`: not present
- multi-envelope: `WalletSignatureEnvelope` for the wallet-signature unlock branch (the same signature is used for both unlock and ika seed - see below for nuance)

## unlock vs ika seed: same signature, two purposes

the wallet signs `IKA_USK_DERIVATION_MESSAGE` **once** at pairing. that signature is used for two distinct things:
1. **ika user-share seed**: `keccak256(signature || index_0_le)` → 32-byte seed for `UserShareEncryptionKeys`
2. **unlock envelope key (optional)**: `HKDF-SHA256(signature, info='chromatika wallet-signature envelope v1', salt=kdfSalt)` → envelope key wrapping the master key

the signature itself is **encrypted** in the wallet-signature envelope. on unlock, the user re-signs the envelope's challenge string (a separate message, NOT `IKA_USK_DERIVATION_MESSAGE`) to produce the envelope key, which decrypts the persisted `ikaUskSignatureB64` (the original `IKA_USK_DERIVATION_MESSAGE` signature). that decrypted signature is then keccak'd to re-derive the ika seed if needed.

so:
- **ika seed signature**: `signature_over(IKA_USK_DERIVATION_MESSAGE)` - signed once, persisted encrypted
- **unlock signature**: `signature_over(envelope_challenge)` - signed every unlock

most of the time the seed is already cached as `ikaShareKeysB64` and re-derivation isn't needed. but when it is needed (first unlock on a new install), the encrypted ika seed signature is decrypted and re-keccak'd.

## fee mode toggle: `in_extension` vs `seeker_direct`

- `in_extension` (default): the derived fee-payer keypair signs ika gRPC `approve_message` calls. fast - one signature per ika op, no popup
- `seeker_direct`: every ika gRPC call routes through the phone wallet for signing. 3-5 phone prompts per ika tx (DKG / presign / sign each have their own sub-calls). slower but no in-extension keypair to manage

`setIkaFeeSettings({ vaultId, mode })` toggles this. the in-extension fee-payer keypair persists on the vault record either way; in `seeker_direct` mode it just isn't used. `drainAbandonedFeePayer` empties it back to the phone if you switched modes.

## restore on a new device

```
1. on new install, pair the same wallet (same Seeker / same WC-paired phone)
2. wallet signs IKA_USK_DERIVATION_MESSAGE - RFC 8032 determinism gives the same 64-byte signature
3. ika seed = keccak256(signature || index_0_le) - identical to before
4. fee-payer keypair = keccak256(signature || index_1_le) - identical to before
5. discoverDWallets reattaches existing dWallets owned by this identity
6. the previously funded fee-payer SOL is right there at the same address
```

no seed phrase, no key export. the wallet's secret stays on the phone forever.

## what doesn't work

- **changing the wallet**: a different wallet (e.g. moving from Phantom to Solflare, or a brand-new Seeker after factory reset) produces a different ed25519 key → different signature → different ika seed → different dWallet. no migration path; you'd need to send funds to the new identity over Solana
- **the WAAP determinism probe rule**: chromatika probes WAAP wallets at pairing because some are non-deterministic. for MWA / WalletConnect Solana wallets the probe is not strictly needed - the standard implementations follow RFC 8032 - but defensive code paths still verify
- **secp256k1 wallets**: this entire flow is ed25519-specific. a hypothetical secp256k1-based MWA wallet would need RFC 6979 deterministic ECDSA to plug into the same pattern; chromatika doesn't have that path today

## library

- `@solana-mobile/mobile-wallet-adapter-protocol-web3js` for MWA local + remote
- `@walletconnect/sign-client` for WalletConnect v2
- `@solana/web3.js` `Keypair.fromSeed` for the fee-payer keypair construction
- `@noble/hashes/sha3` `keccak_256`
- `@ika.xyz/sdk` `UserShareEncryptionKeys.fromRootSeedKey`
- internal: `makeSeedFromMwaSignature`, `ikaRootSeedFromMwaSignature`, `solanaFeeKeypairFromWalletSignature` from `keyring/hd.ts`
- internal: `mwa-remote.ts` for the websocket reflector flow

## related deep-dives

- [wallet-signature-envelope.md](/library/tech/wallet-signature-envelope) - the unlock-envelope side
- [mwa-remote-qr-pairing.md](/library/tech/mwa-remote-qr-pairing) - the QR + reflector pairing protocol
- [ika-fee-management.md](/library/user/ika-fee-management) - in-extension fee-payer top-up + drain flows
