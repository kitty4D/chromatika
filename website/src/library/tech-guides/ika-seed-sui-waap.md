# ika seed: Sui base + WAAP

vault `seedSource: 'waap-signature'` (deterministic path) or `seedSource: 'recovery-words'` (non-deterministic fallback). base chain `'sui'`. WAAP (`@human.tech/waap-sdk`) handles email / phone / social login and returns a Sui address + public key plus a wallet-standard `signPersonalMessage` capability. chromatika probes for determinism at pairing and dispatches accordingly.

today this is a **Sui-only** path.

## the determinism probe

WAAP wallets may or may not produce deterministic ed25519 signatures. chromatika probes at pairing time:

```
1. wallet.signPersonalMessage(IKA_USK_DERIVATION_MESSAGE)   // first sign
   → signature_1 (64 bytes)
2. wallet.signPersonalMessage(IKA_USK_DERIVATION_MESSAGE)   // second sign
   → signature_2

3. if signature_1 === signature_2:
     deterministic = true
     seedSource = 'waap-signature'
   else:
     deterministic = false
     seedSource = 'recovery-words'   // fallback; require user to provide BIP39 phrase
```

deterministic WAAP wallets that follow RFC 8032 ed25519 (which is most modern implementations) pass the probe. WAAP wallets that introduce randomness during signing (some legacy or experimental implementations) fail and fall back.

## deterministic path: `seedSource: 'waap-signature'`

```
1. signature = wallet.signPersonalMessage(IKA_USK_DERIVATION_MESSAGE)   // 64 bytes
2. (the wallet-standard signPersonalMessage may apply Mysten's BLAKE2b PersonalMessage intent
    to the message before ed25519-signing it. that's fine - the signature bytes are still
    deterministic given the same inputs, which is what we need)

3. assemble keccak preimage
   indexLe = u32_le(0)
   preimage = signature || indexLe   // 68 bytes

4. hash
   seed_32 = keccak256(preimage)

5. derive both curves
   uskSecp = UserShareEncryptionKeys.fromRootSeedKey(seed_32, Curve.SECP256K1)
   uskEd25519 = UserShareEncryptionKeys.fromRootSeedKey(seed_32, Curve.ED25519)

6. zero seed_32
```

## what gets stored (deterministic path)

- `record.waapSuiAddress`: the user-facing Sui address WAAP returns (not the dWallet's address - the WAAP-anchored address)
- `record.waapSuiPublicKeyB64`: the secp256k1 or ed25519 compressed pubkey from the WAAP wallet-standard account
- `record.waapAuthMethod`: `'email' | 'phone' | 'social'`
- `record.waapSocialProvider`: optional, e.g. `'google'`
- `record.waapPairingSignatureB64`: the **encrypted** signature bytes (encrypted in the wallet-signature envelope, NOT plaintext)
- `record.ikaShareKeysB64`: USK bytes for both curves
- multi-envelope:
  - `WalletSignatureEnvelope` for the WAAP signature (unlock branch)
  - optional `RecoveryWordsEnvelope` if user provided a backup BIP39 phrase

## non-deterministic fallback path: `seedSource: 'recovery-words'`

if the determinism probe fails:

```
1. require user to provide a 12 / 24 BIP39 phrase
2. validateWords(words)
3. bip39_seed = mnemonicToSeedSync(words, "")   // 64 bytes
4. preimage = bip39_seed || u32_le(0)   // 68 bytes
5. seed_32 = keccak256(preimage)
6. derive both curves, zero seed_32
```

the WAAP signature is **not** used for ika seed in this path - it's still used for unlock (via `WalletSignatureEnvelope`) but the ika identity is rooted in the BIP39 phrase. losing the WAAP login means losing one unlock path; losing the BIP39 phrase means losing the identity.

## what gets stored (recovery-words path)

- WAAP fields same as above
- additionally `record.recoveryWordsEncryptedB64`: the BIP39 phrase **plaintext inside the encrypted vault payload** (chromatika rebuilds the seed on every unlock from this)
- `record.ikaShareKeysB64`: USK bytes for both curves
- multi-envelope: `RecoveryWordsEnvelope` (primary), `WalletSignatureEnvelope` (secondary)
- `seedSource: 'recovery-words'`

## the WAAP login flow at pairing

```
1. user picks auth method (email / phone / google / discord / twitter / github / bluesky)
2. WAAP SDK opens its login UI in a popup or new tab
3. on success, WAAP returns:
   - sui_address (string)
   - sui_public_key (b64)
   - auth_method (string)
   - wallet-standard account object that exposes signPersonalMessage
4. chromatika captures address + pubkey, runs the determinism probe
5. branches into one of the two paths above
```

## restore on a new device

### deterministic path
```
1. log into the same WAAP account on a new chromatika install
2. WAAP returns the same sui_address + pubkey + signing capability
3. wallet.signPersonalMessage(IKA_USK_DERIVATION_MESSAGE) → same 64-byte signature (RFC 8032 + same key)
4. ika seed = keccak256(signature || index) - identical
5. discoverDWallets reattaches existing dWallets
```

### recovery-words path
```
1. user types BIP39 phrase on new install
2. WAAP login is also re-paired to register the WalletSignatureEnvelope (secondary)
3. ika seed = keccak256(bip39_seed || index) - identical to before
4. discoverDWallets reattaches
```

## what doesn't work

- **changing WAAP auth method**: switching from email-WAAP to google-WAAP gives you a **different** WAAP-anchored account → different signature → different ika seed → different dWallet. chromatika cannot migrate identities across WAAP auth methods. it can store multiple WAAP envelopes on the same vault for unlock-only purposes, but the ika identity is tied to whichever WAAP signature was the seed source at vault creation
- **lazor confusion**: WAAP and Lazor are unrelated. WAAP is Sui (and uses signature-based seed derivation when deterministic); Lazor is Solana (and always uses recovery-words for the seed). don't conflate

## library

- `@human.tech/waap-sdk` for the auth flow + wallet-standard account
- internal: `makeSeedFromMwaSignature` (same factory as Seeker / WC, since the formula is the same), `ikaRootSeedFromMwaSignature` from `keyring/hd.ts`
- internal: `waapSeedFactoryFromInput` dispatcher routes between the two paths based on `seedSource`
- `@noble/hashes/sha3` `keccak_256`
- `@ika.xyz/sdk` `UserShareEncryptionKeys.fromRootSeedKey`
