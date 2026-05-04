# WAAP determinism probe

`@human.tech/waap-sdk` (Web3 Auth as a Platform) provides email / phone / social login that resolves to a Sui address + public key + wallet-standard signing capability. some WAAP wallet implementations are **deterministic** (RFC 8032 ed25519 - same key + same message = same signature) and some are **non-deterministic** (introduce randomness during signing). chromatika **probes** at pairing time to dispatch the right ika seed source.

## why determinism matters

chromatika's ika seed for WAAP-Sui vaults uses `ikaRootSeedFromMwaSignature` = `keccak256(signature_over_IKA_USK_DERIVATION_MESSAGE || index_le)`. for restore-on-new-device to work:
- WAAP login on the new device must produce the **same Sui keypair** (the user has the same email / phone)
- the wallet must produce the **same signature** for the same message (RFC 8032 deterministic ed25519)
- `keccak256(signature || index)` must produce the same 32-byte seed

if the WAAP wallet is non-deterministic, two signs of the same message produce different signatures, and `keccak256` produces different seeds → different ika identities. the user's dWallet on a new device wouldn't match what they had before.

so: **determinism is mandatory for the WAAP-signature ika seed path**. non-deterministic wallets fall back to a recovery-words branch.

## the probe

at pairing time, immediately after WAAP login returns:

```ts
async function probeWaapDeterminism(wallet, message) {
  const sig1 = await wallet.signPersonalMessage(message);
  // first sign
  const sig2 = await wallet.signPersonalMessage(message);
  // second sign

  const sig1Bytes = decodeWalletStandardSignature(sig1);
  const sig2Bytes = decodeWalletStandardSignature(sig2);

  return arrayEquals(sig1Bytes, sig2Bytes);
  // deterministic if the bytes match
}

const message = new TextEncoder().encode(IKA_USK_DERIVATION_MESSAGE);
// IKA_USK_DERIVATION_MESSAGE = "ika.chromatika.user-share-encryption-key.v1"
const isDeterministic = await probeWaapDeterminism(waapWallet, message);
```

two assertions of the same `IKA_USK_DERIVATION_MESSAGE`. compare the resulting signature bytes.

## the dispatch

```ts
if (isDeterministic) {
  seedSource = 'waap-signature';
  // capture the signature (one of the two probe sigs - they're identical)
  pairingSignatureB64 = base64Encode(sig1Bytes);
  // ika seed = keccak256(signature || u32_le(0))
  // unlock envelope wraps masterKey under a key derived from same signature
} else {
  seedSource = 'recovery-words';
  // require user to provide BIP39 phrase
  // ika seed = keccak256(bip39_seed || u32_le(0))
  // unlock envelope wraps masterKey under recovery-words-derived key
}
```

chromatika persists `seedSource` on the vault record so subsequent operations know which path the vault uses.

## what makes a WAAP wallet non-deterministic

ed25519 RFC 8032 specifies deterministic signing - same key + same message = same signature, every time. a conforming implementation can't be non-deterministic. but some implementations:
- introduce randomness during the nonce derivation (deviation from RFC 8032)
- use a TEE / HSM that injects per-session entropy
- proxy through a cloud signer that adds metadata (e.g. timestamp) to the signed payload before producing a sig

chromatika treats any of these as non-deterministic. the probe catches all such cases.

## the determinism property is per (wallet implementation, key)

different WAAP wallets behave differently. chromatika probes per-pairing rather than per-WAAP-provider, since:
- WAAP itself doesn't standardize how its sub-wallets sign
- a single user might have multiple WAAP wallets across providers
- a wallet provider could change behavior over a version update; we don't want to hardcode "vendor X is deterministic"

probing at pairing time is robust against implementation changes.

## the persisted state

```jsonc
record.waapSuiAddress = '0x...';
record.waapSuiPublicKeyB64 = '<b64>';
record.waapAuthMethod = 'email' | 'phone' | 'social';
record.waapSocialProvider = 'google' | 'discord' | ... | null;
record.seedSource = 'waap-signature' | 'recovery-words';

// only present if seedSource === 'waap-signature':
record.waapPairingSignatureB64 = '<encrypted in WalletSignatureEnvelope>';

// only present if seedSource === 'recovery-words':
record.recoveryWordsEncryptedB64 = '<the 24 BIP39 words, plaintext inside the AES-GCM vault payload>';
```

## the unlock signature vs the seed signature

note: the **unlock signature** and the **ika seed signature** can be the same in the WAAP-signature path. both come from signing `IKA_USK_DERIVATION_MESSAGE`. chromatika persists the signature once (in the wallet-signature envelope) and reuses for both purposes.

if WAAP login produces a stable Sui keypair AND the signing is deterministic, the user can:
- log in via WAAP on a new device
- chromatika asks WAAP to sign the derivation message
- gets the same 64-byte signature (RFC 8032 + same key)
- ika seed = keccak256 of the signature → same dWallet
- unlock envelope unwraps with the same signature-derived key
- session unlocks; dWallets reattach via discovery

deterministic WAAP = full restore without seed phrase.

non-deterministic WAAP = seed phrase required at create time + at restore.

## the recovery-words fallback

if the probe says non-deterministic, chromatika requires the user to provide 24 BIP39 words at create time. those words:
- back the `RecoveryWordsEnvelope` for unlock
- back the `ikaRootSeedFromRecoveryWords` for ika seed derivation
- get **stored encrypted inside the vault payload** so chromatika can re-derive the seed on every unlock without re-prompting

WAAP login still happens (to get the user's identifying address + an additional unlock branch via `WalletSignatureEnvelope`), but the **canonical seed source** is the BIP39 phrase, not the WAAP signature.

## the probe failure mode

if the WAAP wallet errors during the probe (network blip, user cancels mid-sign), chromatika:
1. surfaces the error
2. does not create a vault
3. lets the user retry

never proceeds with an inconclusive determinism state - that would risk creating a vault we can't unlock.

## library

- `@human.tech/waap-sdk` for the WAAP login + Sui-address resolution
- internal: `wallet-extension/src/background/waap/probe.ts` for the determinism probe
- internal: `wallet-extension/src/background/keyring/hd.ts` for the seed factories
- internal: `waapSeedFactoryFromInput` dispatcher in keyring/hd.ts (per agent exploration)

## related

- [ika-seed-sui-waap.md](/library/tech/ika-seed-sui-waap) - the ika seed derivation paths
- [wallet-signature-envelope.md](/library/tech/wallet-signature-envelope) - the unlock envelope
- [recovery-words-envelope.md](/library/tech/recovery-words-envelope) - the recovery branch
- [multi-envelope-design.md](/library/tech/multi-envelope-design) - the overall envelope model
