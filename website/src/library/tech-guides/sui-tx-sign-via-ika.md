# Sui transaction signing via ika MPC

Sui transactions are signed in chromatika via two paths: **HD fee-payer signing** (`sendSuiNative`, ika PTB ops where the fee payer is the local ed25519 keypair) and **dWallet signing** (when a Sui-base dWallet is the canonical signer for the user identity). this doc covers the dWallet path - using ika MPC ED25519 EDDSA to sign Sui PTBs.

## the call shape

```ts
async function signSuiTransaction({ transaction, dwalletId? }) {
  // transaction is a built @mysten/sui Transaction object
  // returns: { signature, transactionBytes }
}
```

usually called from inside `IkaTransaction.sign()` flows or dapp `sui_signTransactionBlock` handler.

## step-by-step

```ts
async function signSuiTxViaIka(tx: Transaction) {
  // 1. build to BCS-serialized bytes
  const txBytes = await tx.build({ client: suiGraphQLClient });
  // txBytes is the serialized TransactionData (BCS layout)

  // 2. wrap with Mysten intent prefix per Sui's signing scheme
  const intent = new Uint8Array([0x00, 0x00, 0x00]);   // [TransactionData, V0, Sui]
  const intentMessage = new Uint8Array(intent.length + txBytes.length);
  intentMessage.set(intent, 0);
  intentMessage.set(txBytes, intent.length);

  // 3. compute the BLAKE2b-256 digest (Sui native verification expects this)
  const digest = blake2b256(intentMessage);   // 32 bytes

  // 4. take a presign from ED25519_EDDSA pool
  const presignId = takePresign('ED25519_EDDSA');

  // 5. sign via ika - PASS THE DIGEST (32 bytes)
  // critical: Sui's intent path produces a digest before signing
  // ika ED25519 EdDSA signs RAW BYTES (per RFC 8032 sha-512s internally)
  // so we hand ika the digest as the "message" - ika will sha-512 it again
  // verifiers compute blake2b(intent || tx) digest, then verify
  // ed25519_verify(digest, signature, pubkey) - which sha-512s the digest
  // this matches what ika produced
  const sigBytes = await ikaSign({
    dwalletId: activeEd25519DwalletId,
    curve: Curve.ED25519,
    algorithm: SignatureAlgorithm.EdDSA,
    message: digest,                                  // 32-byte BLAKE2b digest
    presignId,
  });

  // 6. parse - 64-byte ed25519 sig
  const { R, S } = parseSignatureFromSignOutput(sigBytes, Curve.ED25519, SignatureAlgorithm.EdDSA);
  const sig64 = new Uint8Array([...R, ...S]);

  // 7. assemble Sui signature format: [scheme_flag(1) || sig(64) || pubkey(32)]
  // scheme_flag = 0x00 for ed25519
  const dwalletPubkey = await getDwalletEd25519PublicKey();
  const suiSig = new Uint8Array(1 + 64 + 32);
  suiSig[0] = 0x00;
  suiSig.set(sig64, 1);
  suiSig.set(dwalletPubkey, 65);

  return {
    signature: toBase64(suiSig),
    transactionBytes: toBase64(txBytes),
  };
}
```

## the Sui intent prefix

Sui signs over an **intent message**: a 3-byte prefix + the BCS-encoded TransactionData. the prefix domain-separates transaction-data signing from PersonalMessage signing from other Sui signature contexts.

```
intent = [scope, version, app]
       = [0x00 (TransactionData), 0x00 (V0), 0x00 (Sui)]
```

the full intent message is `intent || bcs(tx_data)` = 3 bytes + N bytes. then `blake2b_256(intent_message)` is the digest, then `ed25519_sign(digest, key)` is the signature.

## the BLAKE2b vs SHA-512 question

Sui's native verifier:
```
1. recompute digest = blake2b_256(intent || bcs(tx))
2. verify ed25519_signature(digest, sig, pubkey)
   - this internally sha-512s the digest per RFC 8032
```

if chromatika hands ika the **digest** (the 32-byte BLAKE2b output), ika treats those 32 bytes as the message and sha-512s them, signing `sha512(digest)`. verifiers then compute `blake2b(intent || tx)` and call ed25519_verify, which also sha-512s the digest. **same input to sha-512** → **same signature**.

so for **Sui transaction signing** (where verifiers expect the BLAKE2b-of-intent digest as the implicit "message"), this works correctly.

contrast with **Sui personal-message** (`signPersonalMessage`) where chromatika passes the raw user message bytes to ika, ika sha-512s them, but Mysten's verifier expects `blake2b(intent || PersonalMessage(raw))` - **different digest**. that divergence is documented in [sui-personal-message-divergence.md](/library/tech/sui-personal-message-divergence).

## the assembled Sui signature format

Sui signatures aren't just 64 bytes - they're `[scheme_flag(1) || raw_sig(64) || pubkey(32)]` = 97 bytes for ed25519, base64-encoded. the format is per Sui's spec:
- byte 0: scheme flag (0x00 for ed25519, 0x01 for secp256k1, 0x02 for secp256r1, 0x06 for passkey/SIP-9)
- bytes 1-64: raw signature (64 bytes for ed25519 or secp256k1, 65 bytes for secp256r1 with recovery)
- bytes 65-96: public key (32 bytes for ed25519)

verifiers parse this layout to know "ed25519 sig from this pubkey".

## the HD fee-payer alternative path

`sendSuiNative` (and several internal ika PTB ops) sign with the **local HD ed25519 keypair**, not via ika MPC:

```ts
async function signSuiTxWithHdKeypair(tx: Transaction) {
  const txBytes = await tx.build({ client: suiGraphQLClient });
  const intentMessage = wrapWithIntent([0x00, 0x00, 0x00], txBytes);
  const digest = blake2b256(intentMessage);

  const hdKeypair = sessionState.feeMaterial.suiKeypair;   // Mysten Ed25519Keypair
  const sigBytes = await hdKeypair.sign(digest);   // 64 bytes

  const dwalletPubkey = hdKeypair.getPublicKey().toRawBytes();
  return assembleSuiSignature(0x00, sigBytes, dwalletPubkey);
}
```

faster than the MPC path (no presign consumption, no ika round-trip) but trades off the security property of "key never assembled" for "key sits in extension memory while unlocked".

chromatika uses HD fee-payer signing for:
- `sendSuiNative` (HD fee-payer is the canonical sender, not a dWallet)
- ika DKG / presign / sign PTBs (the fee-payer pays gas; the dWallet identity isn't involved at this layer)
- any Sui PTB where the wallet is just paying gas and not asserting user identity

dapp `sui_signTransactionBlock` and dWallet-anchored sends use the ika MPC path so the **user identity** signs.

## simulation

Sui PTBs don't have an `eth_call`-style simulator with the same finality semantics, but `tx.devInspect(...)` runs a dry-run on a Sui node. chromatika uses this for fee estimation and "would this tx succeed" checks before submission.

## library

- `@mysten/sui` `Transaction`, `Ed25519Keypair`, `SuiGraphQLClient`, `toBase64`
- `@noble/hashes/blake2b` `blake2b256`
- internal: `wallet-extension/src/background/chains/signing/sui.ts`
- internal: `wallet-extension/src/background/ika/signing.ts`

## related

- [sui-personal-message-divergence.md](/library/tech/sui-personal-message-divergence) - the BLAKE2b vs SHA-512 gap for personal messages
- [ed25519-eddsa.md](/library/tech/ed25519-eddsa) - the underlying signature algorithm
- [signature-normalization.md](/library/tech/signature-normalization) - parseSignatureFromSignOutput details
