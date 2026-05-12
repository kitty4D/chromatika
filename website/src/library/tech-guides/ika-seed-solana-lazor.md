# ika seed: Solana base + Lazor

vault `seedSource: 'lazor-recovery-words'` (effectively `'recovery-words'`), base chain `'solana'`. Lazor is a Solana smart-wallet portal (`@lazorkit/wallet`) that uses WebAuthn at the portal iframe layer plus a Solana anchor program. because the WebAuthn ceremony runs **inside the Lazor portal iframe at `portal.lazor.sh`**, chromatika can't access the raw PRF / HMAC-secret output. so Lazor vaults **require a 24-word BIP39 phrase at create time**, and that phrase is the ika seed source.

requires `VITE_SOLANA_IKA_BASE=true`. pre-alpha disclaimer applies.

## why recovery words and not PRF

a passkey-PRF approach would let us derive the ika seed deterministically from the WebAuthn assertion (see [ika-seed-sui-passkey.md](/library/tech/ika-seed-sui-passkey)). but PRF / HMAC-secret outputs are returned by **`navigator.credentials.get` in the calling document**. when the WebAuthn ceremony runs inside an iframe (`portal.lazor.sh`), only the iframe's parent (Lazor's portal page) sees the PRF result - chromatika does not.

so chromatika takes the BIP39 phrase route: deterministic from typed words, no need to reach into the iframe.

## inputs

- `recoveryWords`: 24 BIP39 English words (12 not allowed for Lazor; agent's exploration found `recoveryWords` is enforced at 24)
- `lazorSmartWalletPubkeyB58`: the Solana smart-wallet PDA address Lazor returns
- `lazorCredentialIdB64`, `lazorPasskeyPubkeyB64`: passkey artifacts from the portal
- `lazorProgramId`, `lazorNetwork` (mainnet | devnet), `lazorPortalUrl`
- `encryption_key_index`: always `0`

## step-by-step

```
1. user picks Lazor flow, completes the portal-side passkey registration at portal.lazor.sh
   - returns lazorSmartWalletPubkeyB58, lazorCredentialIdB64, etc.

2. user supplies 24-word BIP39 phrase (chromatika UI prompts)
3. validateWords(words) → throws if invalid

4. derive in-extension fee-payer Solana keypair from the same words
   path = "m/44'/501'/0'/0'"
   feeKp = deriveSolanaKeypair(words, accountIndex=0)
   - bip39_seed = mnemonicToSeedSync(words, "")     // 64 bytes
   - SLIP10 ed25519 derive at path → 32-byte ed25519 seed
   - Keypair.fromSeed → 64-byte canonical secretKey

5. ika seed derivation
   bip39_seed_64 = mnemonicToSeedSync(words, "")    // 64 bytes (same as step 4 inner)
   indexLe = u32_le(0)
   preimage = bip39_seed_64 || indexLe              // 68 bytes
   seed_32 = keccak256(preimage)
   uskSecp = UserShareEncryptionKeys.fromRootSeedKey(seed_32, Curve.SECP256K1)
   uskEd25519 = UserShareEncryptionKeys.fromRootSeedKey(seed_32, Curve.ED25519)
   seed_32.fill(0)
```

step 4 and step 5 use **the same BIP39 seed**:
- step 4: feeds SLIP10 derivation to produce a Solana keypair (for paying ika gRPC fees and as a known Solana address for funding)
- step 5: feeds keccak directly (no SLIP10) to produce the ika user-share encryption keys seed

different cryptographic outputs from the same source, fully deterministic.

## what gets stored

- `record.lazorSmartWalletPubkeyB58`: the user-facing Solana address (Lazor PDA)
- `record.lazorCredentialIdB64`, `lazorPasskeyPubkeyB64`: portal-returned passkey artifacts
- `record.lazorProgramId`, `lazorNetwork`, `lazorPortalUrl`: network metadata
- `record.lazorWalletDevicePubkeyB58`: optional device PDA (Lazor client can resolve)
- `record.lazorIkaFeePayerSolSecretKeyB64`: the Solana fee-payer keypair derived from words (b64-encoded canonical 64-byte form)
- `record.recoveryWordsEncryptedB64`: the **24 BIP39 words plaintext inside the encrypted vault payload** - so unlock can rebuild the fee-payer without prompting again
- `record.ikaShareKeysB64`: USK bytes for both curves
- multi-envelope:
  - `PasswordEnvelope` (always - chromatika requires a password for Lazor)
  - `RecoveryWordsEnvelope` (the 24 words, also wrap the master key)

both envelopes unwrap the same master key. user can unlock with the password OR the 24 words.

## the "phrase encrypted in vault" twist

unlike WAAP-recovery or passkey-recovery (where the phrase only matters as an envelope branch), Lazor stores the phrase **inside the encrypted vault payload**. why?

because the **fee-payer keypair** has to be available on every Solana ika operation, and re-prompting for the 24 words on every fee-paying op would be terrible UX. so chromatika decrypts the vault (which requires either the password or the words via envelope), reads `record.recoveryWordsEncryptedB64`, derives the fee-payer keypair, signs ika gRPC `approve_message` calls.

once the vault is unlocked, the words sit in memory inside the session state. on lock, that memory is dropped.

## restore on a new device

```
1. user types 24 BIP39 words on new install
2. unlocks via RecoveryWordsEnvelope (or via password if both envelopes set up)
3. ika seed = keccak256(bip39_seed || index) - identical
4. fee-payer keypair = SLIP10 derive at m/44'/501'/0'/0' - identical
5. user re-pairs Lazor at the portal
   - Lazor's smart-wallet PDA is determined by lazorPasskeyPubkey + program; if user uses the same passkey at the portal, they get the same PDA
   - if the passkey was synced (iCloud / Google), the PDA reattaches automatically
6. discoverDWallets reattaches dWallets owned by the recovered identity
```

deterministic per BIP39 + the Lazor portal returning the same smart-wallet PDA on the same passkey.

## what doesn't work

- **12-word phrases**: Lazor enforces 24 words. 128 bits of entropy isn't enough margin given the dual role (envelope unlock + fee-payer + ika seed)
- **passing through the Lazor portal's PRF output**: cross-frame WebAuthn extension result access is blocked by browser security model. chromatika can ask the portal for the PDA + credential id but not the PRF secret
- **mainnet vs devnet mismatch**: if you create a Lazor vault on devnet but try to use it on mainnet, the Lazor smart-wallet PDA won't exist on mainnet (programs are deployed per network). re-create the vault for the target network

## library

- `@lazorkit/wallet` for the portal flow
- `@scure/bip39` for `validateWords`, `mnemonicToSeedSync`
- internal `slip10Ed25519DerivePath` + `@solana/web3.js` `Keypair.fromSeed` for fee-payer derivation
- `@noble/hashes/sha3` `keccak_256`
- `@ika.xyz/sdk` `UserShareEncryptionKeys.fromRootSeedKey`
- internal: `makeSeedFromRecoveryWords`, `ikaRootSeedFromRecoveryWords` from `keyring/hd.ts`
