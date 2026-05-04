# `parseSignatureFromSignOutput` and signature normalization

ika returns signature bytes in protocol-specific formats. `parseSignatureFromSignOutput(bytes, curve, algorithm)` from `@ika.xyz/sdk` is the canonical helper that asserts the right length + decodes into typed `(r, s)` or `(R, S)` components. chromatika uses it on every signing path.

## the signatures we deal with

| curve | algorithm | output bytes | components |
|-------|-----------|--------------|------------|
| SECP256K1 | ECDSASecp256k1 | 64 bytes | `r` (32 bytes) + `s` (32 bytes), compact |
| SECP256K1 | Taproot (BIP340 Schnorr) | 64 bytes | `R` (32 bytes x-only) + `s` (32 bytes) |
| SECP256K1 | ECDSASecp256r1 | 64 bytes | `r` (32 bytes) + `s` (32 bytes), compact - **secp256r1 not used by chromatika today** |
| ED25519 | EdDSA | 64 bytes | `R` (32 bytes) + `S` (32 bytes) |
| RISTRETTO | SchnorrkelSubstrate | 64 bytes | not used by chromatika today |

every chromatika signature is 64 bytes from ika. the ECDSA outputs **don't** include `v` - chromatika recovers `v` separately for EVM (see [ecdsa-secp256k1.md](/library/tech/ecdsa-secp256k1)).

## the call

```ts
import { parseSignatureFromSignOutput, Curve, SignatureAlgorithm } from '@ika.xyz/sdk';

const { r, s } = parseSignatureFromSignOutput(
  sigBytes,                              // Uint8Array from ika
  Curve.SECP256K1,                       // 0
  SignatureAlgorithm.ECDSASecp256k1,     // 0
);
// r, s are each Uint8Array(32)
```

for ed25519 / Schnorr the components are named `R` and `S` (or in some helper signatures, `R` and `s`); the function returns the right shape per algorithm.

## what it asserts

- input length matches the expected signature size for the curve+algorithm
- internal byte ordering / encoding matches the protocol (e.g. ECDSA's `(r, s)` are big-endian scalars; Schnorr's `R` is x-only and big-endian; ed25519's `R, S` are little-endian per RFC 8032)
- canonical form (e.g. ECDSA `s` is in the lower-half of the curve order to prevent malleability - `s ≤ n/2`)

if anything's off, `parseSignatureFromSignOutput` throws. callers should not catch generically; a parse failure means ika produced something unexpected, which is a bug to surface.

## the ika constants (recap)

```js
Curve.SECP256K1 = 0
Curve.SECP256R1 = 1
Curve.ED25519 = 2
Curve.RISTRETTO = 3

SignatureAlgorithm.ECDSASecp256k1 = 0
SignatureAlgorithm.Taproot = 1
SignatureAlgorithm.ECDSASecp256r1 = 2
SignatureAlgorithm.EdDSA = 3
SignatureAlgorithm.SchnorrkelSubstrate = 4
```

per CLAUDE.md, `fromCurveToNumber` is **not** exported from `@ika.xyz/sdk` main entry - it's internal. hardcode the constants above; don't try to import the helper.

## EVM v-recovery (separate step)

ECDSA-secp256k1 doesn't include `v` in the standard signature - it's an EVM convention. chromatika picks `v` after parsing:

```ts
const { r, s } = parseSignatureFromSignOutput(sigBytes, Curve.SECP256K1, SignatureAlgorithm.ECDSASecp256k1);
const digest = ethers.keccak256(preimage);
const knownAddress = await getEvmAddress();

let v: 27 | 28;
const candidate27 = ethers.recoverAddress(digest, { r, s, v: 27 }).toLowerCase();
const candidate28 = ethers.recoverAddress(digest, { r, s, v: 28 }).toLowerCase();

if (candidate27 === knownAddress.toLowerCase()) {
  v = 27;
} else if (candidate28 === knownAddress.toLowerCase()) {
  v = 28;
} else {
  throw new Error('signature does not recover to expected address');
}
```

if neither candidate matches, the signature is for a different key OR the preimage was double-hashed somewhere. either way, abort.

## DER encoding (Bitcoin ECDSA)

bitcoin signatures use DER encoding instead of compact `r||s`. format:

```
0x30 || total_length ||
0x02 || r_length || r_bytes ||
0x02 || s_length || s_bytes
```

DER has variable-length encoding because both `r` and `s` may have different effective lengths (leading zeros stripped, and a leading 0x00 padding added if the high bit is set to indicate positive). bitcoinjs-lib has DER encode / decode helpers.

chromatika converts ika's compact `(r, s)` to DER for Bitcoin signing:
```ts
const derSig = bitcoin.script.signature.encode(
  Buffer.concat([r, s]),    // 64-byte compact
  hashType,                  // 0x01 for SIGHASH_ALL
);
// derSig is the DER-encoded sig + 1-byte hash type
```

## Schnorr is BIP340-encoded

Bitcoin Schnorr signatures (taproot) are 64 bytes (`R || s`) for SIGHASH_DEFAULT, or 65 bytes (`R || s || hashType`) for any other sighash. chromatika produces 64-byte SIGHASH_DEFAULT signatures by default.

`R` is the **x-only** representation (32 bytes, just the x-coordinate; y is implicitly even per BIP340). this differs from full `R = (x, y)` encoding ed25519 uses internally.

## ed25519 is RFC 8032

ed25519 signatures are 64 bytes per RFC 8032: `R || S` where both are little-endian. ika's output is already in this canonical form; just split the 64 bytes in half.

## the chromatika rule

across all paths:
1. call `parseSignatureFromSignOutput(sigBytes, curve, algorithm)` with the right enums
2. trust the returned `(r, s)` / `(R, S)` to be canonical
3. for EVM, recover `v` separately
4. for Bitcoin ECDSA, DER-encode + add hashType byte
5. for Bitcoin Schnorr, just `R || s` (or with hashType byte for non-default sighash)
6. for ed25519, `R || S` directly

never hand-write byte parsing of ika's output. the SDK helper is the canonical interpretation.

## library

- `@ika.xyz/sdk` `parseSignatureFromSignOutput`, `Curve`, `SignatureAlgorithm`
- `ethers` v6 `recoverAddress` for EVM v-recovery
- `bitcoinjs-lib` DER encode for Bitcoin ECDSA
- internal: chromatika never re-implements these conversions; always uses the SDK / library helpers

## related

- [ecdsa-secp256k1.md](/library/tech/ecdsa-secp256k1) - the ECDSA path + v-recovery details
- [ed25519-eddsa.md](/library/tech/ed25519-eddsa) - the ed25519 path
- [taproot-schnorr.md](/library/tech/taproot-schnorr) - the Schnorr / BIP340 path
- [evm-send-flow.md](/library/tech/evm-send-flow), [evm-personal-sign-and-typeddata.md](/library/tech/evm-personal-sign-and-typeddata), [solana-tx-sign.md](/library/tech/solana-tx-sign), [btc-tx-sign-segwit-taproot.md](/library/tech/btc-tx-sign-segwit-taproot), [aptos-sign.md](/library/tech/aptos-sign), [sui-tx-sign-via-ika.md](/library/tech/sui-tx-sign-via-ika) - the per-chain signing flows that all call this helper
