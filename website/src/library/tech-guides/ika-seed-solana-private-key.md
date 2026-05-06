# ika seed: Solana base + imported private key

vault `seedSource: 'private-key'`, base chain `'solana'`. user supplies a 64-byte canonical Solana secret key as base64 (the same shape Phantom and `solana-keygen` JSON-export). chromatika reconstructs the keypair, derives the ika seed exactly like a mnemonic-based Solana vault would.

requires `VITE_SOLANA_IKA_BASE=true`. pre-alpha disclaimer applies (single mock signer, not production MPC).

## inputs

- `solanaSecretKeyB64`: base64 encoding of the 64-byte secretKey (`[seed(32) || pubkey(32)]`)
- `encryption_key_index`: always `0`

## step-by-step

```
1. decode the b64 input
   secretKey64 = base64Decode(solanaSecretKeyB64)
   assert secretKey64.length === 64

2. construct the Solana keypair
   solKp = Keypair.fromSecretKey(secretKey64)
   // Keypair.fromSecretKey takes the 64-byte form directly; the constructor
   // does NOT verify that the embedded pubkey matches the seed. if you pass
   // a tampered keypair, signing will produce signatures verifiable under
   // the embedded pubkey but inconsistent with what other tools expect from
   // the seed alone

3. assemble keccak preimage (identical to mnemonic Solana from step 3 onward)
   indexLe = u32_le(0)
   preimage = solKp.secretKey || indexLe   // 68 bytes

4. hash
   seed_32 = keccak256(preimage)

5. derive both curves
   uskSecp = UserShareEncryptionKeys.fromRootSeedKey(seed_32, Curve.SECP256K1)
   uskEd25519 = UserShareEncryptionKeys.fromRootSeedKey(seed_32, Curve.ED25519)

6. zero seed_32
```

## what gets stored

- `record.solanaSecretKeyB64`: the b64 string, plaintext inside the encrypted vault payload
- `record.mnemonic`: not present
- `record.ikaShareKeysB64`: USK bytes for both curves
- `record.ikaGrpcFeePayerSolSecretKeyB64`: the same secretKey b64 (the imported keypair pays ika gRPC fees)

## the Phantom-export equivalence

`solana-keygen new -o my-keypair.json` produces a JSON array of 64 bytes:

```
[12, 45, 233, ..., 12, 89, 76]
```

base64-encoding that array (treating it as 64 raw bytes) gives `solanaSecretKeyB64`. Phantom's "export private key" produces base58 of the same 64 bytes - chromatika accepts b64 because it's the chrome-platform-friendly format; users coming from Phantom can convert via:

```js
import bs58 from "bs58";
const b58 = phantomExportString;
const bytes = bs58.decode(b58); // 64 bytes
const b64 = btoa(String.fromCharCode(...bytes));
```

(or just use a wallet that already exports as b64).

## restore on a new device

```
1. user pastes the same solanaSecretKeyB64 on a new install
2. importVaultFromPrivateKey with baseChain='solana'
3. keccak preimage = secretKey64 || index_le
4. seed = keccak256(preimage)
5. both curves derived
6. discoverDWallets reattaches existing dWallets
```

deterministic, identical to the mnemonic-Solana path from step 3 onward.

## the Seeker / Phantom interop angle

a Solana-only onboarding flow uses this exact path: the user already has a Solana wallet (Phantom, Seeker bundled, Solflare) and exports the secret. they import into chromatika under Solana ika base and now drive ika operations with the same identity their phone wallet uses.

contrast: Seeker remote MWA pairing uses **the wallet's signature**, not the secret bytes - because Seed Vault never reveals secret bytes. so:

- Phantom export → import-private-key vault (this doc)
- Seeker pairing → MWA-signature vault (see [ika-seed-solana-mwa-walletconnect.md](/library/tech/ika-seed-solana-mwa-walletconnect))

both produce a Solana-base identity but via different paths.

## the security tradeoff

**important**: importing a private key gives chromatika the **secret bytes** in plaintext (within the encrypted vault payload). if an attacker compromises the unlocked vault, they can sign **any** transaction with that key, on Solana or via ika.

with Seeker remote MWA, the secret stays on the phone. attacker compromising the unlocked chromatika vault gets the **wallet-signature** (signed once, used as ika seed) but cannot produce new arbitrary signatures - the phone remains the gatekeeper.

so import-private-key is convenient but less secure than hardware-rooted paths. the user is making the tradeoff explicitly when they paste their secret.

## what doesn't work

- **secret keys from non-standard formats**: chromatika expects the canonical 64-byte form (`[seed || pubkey]`). some tools export only the 32-byte ed25519 seed (the "private key" without the embedded pubkey) - that's incompatible. user has to expand to 64 bytes via `Keypair.fromSeed(seed32).secretKey` before importing
- **ed25519 keypairs from non-Solana sources**: a Sui ed25519 keypair has a different canonical form (`scheme_flag || secret`, 33 bytes). pasting Sui privkey under Solana base will fail decoding or produce a wrong identity. import paths are flavor-locked
- **cross-base reuse**: same private key under Sui base = different ika seed (different preimage layout). the `previewCrossChainReuseMnemonic` flow is BIP39-only; private-key vaults don't get cross-chain preview because there's no canonical conversion between sui privkey format and solana secret-key format

## library

- `@solana/web3.js` `Keypair.fromSecretKey`
- `@noble/hashes/sha3` `keccak_256`
- `@ika.xyz/sdk` `UserShareEncryptionKeys.fromRootSeedKey`
- internal: `makeSeedFromSolanaKeypair`, `ikaRootSeedFromSolanaKeypair` from `keyring/hd.ts`
