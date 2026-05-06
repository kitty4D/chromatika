# Bitcoin tx signing - segwit (P2WPKH) + taproot (P2TR)

Bitcoin transactions in chromatika are signed via two ika MPC paths: **SECP256K1_ECDSA** for P2WPKH segwit (BIP143 sighash) and **SECP256K1_TAPROOT** for P2TR taproot (BIP341 sighash + BIP340 Schnorr). presign material lives in two separate pools.

## the address layouts chromatika supports

| address kind                     | derivation path   | signing curve | sig algorithm    |
| -------------------------------- | ----------------- | ------------- | ---------------- |
| P2WPKH (segwit bech32 `bc1q...`) | `m/84'/0'/0'/0/0` | secp256k1     | ECDSA (BIP143)   |
| P2TR (taproot bech32m `bc1p...`) | `m/86'/0'/0'/0/0` | secp256k1     | Schnorr (BIP340) |

both addresses derive from the **same dWallet** (SECP256K1 curve). different address types from the same key - the dWallet's secp256k1 pubkey, encoded differently per address kind.

## P2WPKH signing flow

```ts
async function signBtcP2wpkhTx(tx: bitcoinjs.Psbt, inputIndex: number) {
  // 1. compute BIP143 sighash
  // bitcoinjs-lib does this internally via finalizeAllInputs after signing
  // or expose via getInputHash:
  const sighash = tx.data.inputs[inputIndex].witnessUtxo
    ? tx.__tx.hashForWitnessV0(
        inputIndex,
        sighashScript,
        amountSats,
        bitcoinjs.Transaction.SIGHASH_ALL,   // 0x01
      )
    : throw 'P2WPKH input requires witnessUtxo';
  // sighash is 32 bytes - the BIP143 digest, double-SHA-256'd

  // 2. take a presign from SECP256K1_ECDSA pool
  const presignId = takePresign('SECP256K1_ECDSA');

  // 3. sign via ika
  // sighash is already a digest. ika hashes once with KECCAK256 internally
  // for SECP256K1_ECDSA, but bitcoin verifies with the SHA-256 sighash
  // there's a wrapper helper that handles the digest correctly - check
  // wallet-extension/src/background/chains/signing/btc.ts for the canonical
  // implementation
  const sigBytes = await ikaSign({
    dwalletId: activeSecpDwalletId,
    curve: Curve.SECP256K1,
    algorithm: SignatureAlgorithm.ECDSASecp256k1,
    message: sighash,                       // already-hashed BIP143 digest
    presignId,
  });

  // 4. parse - 64-byte compact r||s
  const { r, s } = parseSignatureFromSignOutput(sigBytes, Curve.SECP256K1, SignatureAlgorithm.ECDSASecp256k1);

  // 5. assemble bitcoinjs-style DER signature + sighash byte
  // bitcoin uses DER encoding for ECDSA sigs, with a trailing sighash byte (0x01 for SIGHASH_ALL)
  const derSig = encodeDerSignature(r, s);
  const sigWithType = Buffer.concat([derSig, Buffer.from([0x01])]);

  // 6. write into the PSBT input's partialSig
  const dwalletPubkey = getCompressedSecpPubkey();
  tx.data.inputs[inputIndex].partialSig = [{
    pubkey: dwalletPubkey,
    signature: sigWithType,
  }];

  // 7. finalize the input (bitcoinjs converts partialSig + script to witness)
  tx.finalizeInput(inputIndex);
}
```

key bitcoinjs-lib bits:

- `tx.__tx.hashForWitnessV0(...)` computes the BIP143 sighash for a segwit input
- DER encoding is the canonical secp256k1 ECDSA signature serialization on Bitcoin (NOT compact r||s like EVM)
- `partialSig` is the PSBT field that carries one signer's sig
- `finalizeInput` converts the signed PSBT input into the final witness stack

## P2TR signing flow

```ts
async function signBtcP2trTx(tx: bitcoinjs.Psbt, inputIndex: number) {
  // 1. compute BIP341 sighash (taproot key-path-only)
  const sighash = tx.__tx.hashForWitnessV1(
    inputIndex,
    prevoutScripts, // all input scripts
    prevoutAmounts, // all input amounts
    bitcoinjs.Transaction.SIGHASH_DEFAULT // 0x00 (default for taproot, omitted from sig)
  );
  // sighash is 32 bytes - tagged_hash("TapSighash", 0x00 || sighash_data)

  // 2. take a presign from SECP256K1_TAPROOT pool (different from ECDSA!)
  const presignId = takePresign("SECP256K1_TAPROOT");

  // 3. sign via ika
  const sigBytes = await ikaSign({
    dwalletId: activeSecpDwalletId,
    curve: Curve.SECP256K1,
    algorithm: SignatureAlgorithm.Taproot, // BIP340 Schnorr
    message: sighash,
    presignId,
  });

  // 4. parse - 64-byte BIP340 Schnorr (R || s)
  const { R, S } = parseSignatureFromSignOutput(
    sigBytes,
    Curve.SECP256K1,
    SignatureAlgorithm.Taproot
  );
  const sig64 = Buffer.concat([R, S]);

  // 5. for SIGHASH_DEFAULT (0x00), no trailing sighash byte needed
  // for any other sighash type, append it: sig64 || sighash_byte (65 bytes total)

  // 6. write into PSBT input's tapKeySig
  tx.data.inputs[inputIndex].tapKeySig = sig64;

  // 7. finalize
  tx.finalizeInput(inputIndex);
}
```

P2TR key-path spending: the witness is `[signature]` only, no script. simpler than script-path.

## the BIP143 sighash digest

P2WPKH segwit signs over the BIP143-defined preimage:

```
preimage = nVersion ||
           hashPrevouts ||
           hashSequence ||
           outpoint ||
           scriptCode ||
           amount ||
           nSequence ||
           hashOutputs ||
           nLocktime ||
           sighash_type
sighash = SHA-256(SHA-256(preimage))   // double-SHA-256
```

bitcoinjs-lib encapsulates this. you compute the sighash once per input, hand to the signer, get back a sig.

## the BIP341 sighash digest

P2TR taproot signs over the BIP341-defined preimage with a tagged hash:

```
sighash_data = SIGHASH_DEFAULT ||
               nVersion ||
               nLockTime ||
               sha256(amounts) ||
               sha256(scriptPubKeys) ||
               sha256(sequences) ||
               sha256(outputs) ||
               spend_type ||
               input_index ||
               ...
sighash = tagged_hash("TapSighash", 0x00 || sighash_data)
        = SHA-256(SHA-256("TapSighash") || SHA-256("TapSighash") || 0x00 || sighash_data)
```

different from BIP143 in both contents (taproot adds amounts + scriptPubKeys) and hash function (tagged hash with the `"TapSighash"` tag).

## the v=0/1 vs taproot

ECDSA on Bitcoin uses DER encoding which already carries enough info to verify - no separate `v` byte. unlike EVM where we recover `v` to map to address, Bitcoin verifiers compute the digest and check `(r, s)` against the candidate pubkey directly.

Schnorr on Bitcoin (BIP340) doesn't need recovery either - the signature uses an x-only `R` form, but verification doesn't require recovery. just `e = tagged_hash("BIP0340/challenge", R || P || m)` then check `s*G == R + e*P`.

so neither Bitcoin path has the EVM-style v-recovery dance.

## the "do we use Solana-base BTC signing?"

`assertNotSolanaBaseForSecpSigning` gates BTC signing to Sui-base today. BTC sends require Sui-base vault. when Solana-base SECP signing parity ships, this guard relaxes.

## library

- `bitcoinjs-lib` for tx building, PSBT, BIP143 / BIP341 sighash computation, witness assembly
- `@noble/hashes/sha256` for SHA-256 (used internally by bitcoinjs)
- `@noble/secp256k1` for curve math (used internally; chromatika doesn't call it directly)
- internal: `wallet-extension/src/background/chains/signing/btc.ts`

## related

- [ecdsa-secp256k1.md](/library/tech/ecdsa-secp256k1) - the ECDSA path
- [taproot-schnorr.md](/library/tech/taproot-schnorr) - the Schnorr path
- [signature-normalization.md](/library/tech/signature-normalization) - parseSignatureFromSignOutput details
- [ika-presign-pool-impl.md](/library/tech/ika-presign-pool-impl) - the two BTC pools (SECP256K1_ECDSA + SECP256K1_TAPROOT)
