# Encrypt ReadCiphertext (signed) flow

reading a stored ciphertext requires a signed message. chromatika builds a BCS-encoded request (chain + identifier + epoch), signs it with the dWallet's ed25519 key (via `signMessageSol` - the same ika MPC path used elsewhere), wraps it in a protobuf `ReadCiphertextRequest`, and sends over gRPC-web. the executor returns the 16-byte plaintext value plus an opaque digest.

## the BCS-encoded message

per `encrypt-read-msg.ts`, the message layout is:

```
[chain (1 byte)]
[ctIdLen (1 byte)] [ciphertextIdentifier (N bytes)]
[rekeyLen (1 byte)] [reencryptionKey (M bytes)]
[epoch (8 bytes, u64 LE)]
```

BCS (Binary Canonical Serialization) is the encoding Sui / Move use; chromatika reuses the layout here for cross-protocol consistency.

```ts
function encodeReadCiphertextMessage(
  chain: number,                  // 0 = Solana
  ciphertextIdentifier: Uint8Array,
  reencryptionKey: Uint8Array,    // empty for label reveal
  epoch: bigint,                  // 0n typically
): Uint8Array {
  const buf: number[] = [];
  buf.push(chain & 0xFF);
  buf.push(ciphertextIdentifier.length & 0xFF);
  for (const b of ciphertextIdentifier) buf.push(b);
  buf.push(reencryptionKey.length & 0xFF);
  for (const b of reencryptionKey) buf.push(b);
  // u64 LE
  let e = epoch;
  for (let i = 0; i < 8; i++) {
    buf.push(Number(e & 0xFFn));
    e >>= 8n;
  }
  return new Uint8Array(buf);
}
```

for label reveal, we always pass `chain=0` (Solana), the chunk identifier, empty `reencryptionKey`, and `epoch=0n`. so the encoded message is:
```
[0x00] [<idLen>] [<id bytes>] [0x00] [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
```

## signing

```ts
const signerPk = await getDwalletEd25519PublicKey();   // 32-byte pubkey of active ED25519 dWallet
const msg = encodeReadCiphertextMessage(0, identifierBytes, new Uint8Array(0), 0n);
const { signature } = await signMessageSol(msg);
const sigBytes = signatureHexToEd25519Bytes(signature);   // 64 bytes
```

`signMessageSol` is the chromatika helper that runs the ika MPC ED25519 signing flow with the message bytes (raw, not pre-hashed - ika SHA-512s internally per RFC 8032). returns a hex-encoded 64-byte ed25519 signature.

`signatureHexToEd25519Bytes` decodes hex to 64 bytes; trivial conversion.

## the protobuf request

```ts
const request = {
  message: msg,            // BCS-encoded bytes
  signature: sigBytes,     // 64-byte ed25519 sig
  signer: signerPk,        // 32-byte ed25519 pubkey
};
const encoded = encodeReadCiphertextRequest(request);
const responseBytes = await encryptGrpcReadCiphertext(GRPC_URL, encoded);
const { value, fheType, digest } = decodeReadCiphertextResponse(responseBytes);
```

protobuf wire shape (3 fields, see [encrypt-protobuf-wire.md](/library/tech/encrypt-protobuf-wire)):
| field | content |
|-------|---------|
| 1: message | BCS-encoded ReadCiphertextMessage |
| 2: signature | 64-byte ed25519 sig over message |
| 3: signer | 32-byte ed25519 public key |

server verifies the signature against the signer pubkey + message bytes. mismatch → gRPC error (`grpc-status` != 0).

## response decoding

`ReadCiphertextResponse`:
| field | content |
|-------|---------|
| 1: value | 16-byte plaintext (for EUint128) or 8-byte (for EUint64) |
| 2: fheType | int32 (5 = EUINT128 for labels, 4 = EUINT64 for lab demos) |
| 3: digest | opaque executor-local proof bytes |

`value` is the **raw plaintext bytes** that were stored. for labels, that's a 16-byte UTF-8 chunk (left-justified, zero-padded). for lab demos, it's the LE bytes of the original u64.

## why ed25519 sign here

the executor needs to authenticate the reader. authorization model: "you can read your own ciphertext if you can prove you control the dWallet." the dWallet's ed25519 key is the canonical "who you are" credential on Solana ika base. signing the read request with that key proves authorization.

note: this signs over the BCS message bytes, **not** a pre-hashed digest. ika's ED25519 EdDSA path SHA-512s the bytes internally per RFC 8032. **double-hashing breaks the signature** - same rule as everywhere else (see [ecdsa-secp256k1.md](/library/tech/ecdsa-secp256k1), [ed25519-eddsa.md](/library/tech/ed25519-eddsa)).

## the multi-chunk reveal loop

for a label spanning 4 chunks:

```ts
const chunkValues: Uint8Array[] = [];
const digestHexes: string[] = [];

for (const idHex of ciphertextIdentifierHexes) {
  const id = hexToBytes(idHex);
  const msg = encodeReadCiphertextMessage(0, id, new Uint8Array(0), 0n);
  const { signature } = await signMessageSol(msg);
  const sigBytes = signatureHexToEd25519Bytes(signature);
  const encoded = encodeReadCiphertextRequest({ message: msg, signature: sigBytes, signer: signerPk });
  const respBytes = await encryptGrpcReadCiphertext(GRPC_URL, encoded);
  const { value, digest } = decodeReadCiphertextResponse(respBytes);

  chunkValues.push(value);              // 16 bytes
  digestHexes.push(bytesToHex(digest));
}

// reassemble
const labelString = decodeLabelFromChunks(chunkValues, utf8Len);
```

each chunk requires a separate sign + read round-trip. for a 4-chunk label, that's 4 ika MPC signing operations (each consuming a presign from the ED25519_EDDSA pool) and 4 gRPC calls. not super fast, but fine for a "click reveal" UX.

partial failure: if any chunk's read fails (network error, executor error), the whole reveal fails - we don't show partial labels. simpler and avoids a "what does half a UTF-8 string look like" question.

## decoding chunks back to a string

```ts
function decodeLabelFromChunks(chunkValues: Uint8Array[], utf8Len: number): string {
  const concatenated = new Uint8Array(chunkValues.length * 16);
  for (let i = 0; i < chunkValues.length; i++) {
    concatenated.set(chunkValues[i], i * 16);
  }
  const trimmed = concatenated.slice(0, utf8Len);
  return new TextDecoder('utf-8', { fatal: false }).decode(trimmed);
}
```

`utf8Len` is the **stored** byte length from when the label was encrypted. trimming to that length strips the zero-padding within the last chunk. `fatal: false` lets the decoder produce replacement chars on bad UTF-8 rather than throwing - defensive against accidentally tampered chunks (which shouldn't happen on a healthy executor, but we'd rather see "?�?�" than crash).

## error handling

- session not on Solana ika base: throws via guard before any signing
- ed25519 dWallet not active: signing helper throws ("no active ed25519 dWallet")
- presign pool empty + no funds to refill: signing fails with pool-empty error
- gRPC error from executor (signature invalid, account missing): wrapped, surfaced verbatim
- chunk count mismatch (`encryptedLabel.ciphertextIdentifierHexes.length === 0`): "label not found" - probably devnet wipe

## what the digest is for

the executor returns an opaque `digest` per read. it's a proof that the read happened (timestamp, nonce, executor-local state). chromatika stores `digestHexes[]` in the reveal-result for diagnostics - if a label suddenly returns garbage, comparing digests across reads can show whether the underlying ciphertext changed.

production Encrypt may use the digest for ZK verification ("you read this exact ciphertext at this exact epoch"); pre-alpha treats it as opaque.

## library

- internal: `encrypt-lab-service.ts` `revealDwalletLabelCiphertext`, `encryptLabReadCiphertextDemo`
- internal: `encrypt-read-msg.ts` `encodeReadCiphertextMessage`
- internal: `encrypt-protobuf-wire.ts` `encodeReadCiphertextRequest`, `decodeReadCiphertextResponse`
- internal: `encrypt-grpc-web-fetch.ts` `encryptGrpcReadCiphertext`
- internal: `signMessageSol` from the dWallet signing helpers (same path EVM / Solana sign-message uses)

## related

- [encrypt-create-input.md](/library/tech/encrypt-create-input) - the write side
- [encrypt-multi-chunk-labels.md](/library/tech/encrypt-multi-chunk-labels) - the chunking strategy
- [encrypt-on-chain-status-polling.md](/library/tech/encrypt-on-chain-status-polling) - the 4s status pill
- [ed25519-eddsa.md](/library/tech/ed25519-eddsa) - the signing primitive
