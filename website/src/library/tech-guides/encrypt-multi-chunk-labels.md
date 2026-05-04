# Encrypt multi-chunk labels (1-64 utf-8 bytes → 1-4 EUint128 chunks)

a dWallet label is up to **64 utf-8 bytes**. since each Encrypt input is one fixed-size scalar (we use EUint128 = 16 bytes), a label larger than 16 bytes must be **sliced into chunks** and stored as a sequence of identifiers. chromatika packs labels into 1-4 chunks of 16 bytes each, encrypts them in a single batched `CreateInput` call, and reassembles on reveal.

## the encoding

```ts
function encodeLabelToChunks(label: string): { chunks: Uint8Array[], utf8Len: number } {
  const trimmed = label.trim();
  const utf8Bytes = new TextEncoder().encode(trimmed);

  if (utf8Bytes.length === 0) throw new Error('label cannot be empty');
  if (utf8Bytes.length > 64) throw new Error('label too long (max 64 utf-8 bytes)');

  const chunkCount = Math.ceil(utf8Bytes.length / 16);
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < chunkCount; i++) {
    const chunk = new Uint8Array(16);                                  // zero-initialized
    chunk.set(utf8Bytes.slice(i * 16, (i + 1) * 16));                 // copy the slice; remaining stays zero
    chunks.push(chunk);
  }

  return { chunks, utf8Len: utf8Bytes.length };
}
```

example for label `"hello world"` (11 utf-8 bytes, 1 chunk needed):
```
chunk_0 = [0x68, 0x65, 0x6C, 0x6C, 0x6F, 0x20, 0x77, 0x6F, 0x72, 0x6C, 0x64, 0x00, 0x00, 0x00, 0x00, 0x00]
              h     e     l     l     o    ' '    w     o     r     l     d    [zero padding]
utf8Len = 11
```

example for label `"my account label here for chromatika!!"` (38 bytes, 3 chunks):
```
chunk_0 = [m, y, ' ', a, c, c, o, u, n, t, ' ', l, a, b, e, l]                                            // 16 bytes, exactly filled
chunk_1 = [' ', h, e, r, e, ' ', f, o, r, ' ', c, h, r, o, m, a]                                          // 16 bytes
chunk_2 = [t, i, k, a, !, !, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]                // 6 bytes, padded
utf8Len = 38
```

## the wrap to 17-byte format

each 16-byte chunk gets wrapped:
```ts
const inputs = chunks.map(chunk => ({
  ciphertextBytes: mockEncryptScalarBytesFromBytes(chunk, FHE_TYPE_EUINT128),
  fheType: FHE_TYPE_EUINT128,
}));
```

`mockEncryptScalarBytesFromBytes` prepends `0x05` (FHE_TYPE_EUINT128 = 5) → 17-byte canonical format. see [encrypt-17-byte-canonical-format.md](/library/tech/encrypt-17-byte-canonical-format).

## the batched CreateInput

all chunks go in **one** gRPC `CreateInput` request:
```ts
const request = {
  chain: 0,
  inputs,                                // 1-4 EncryptedInput
  proof: new Uint8Array(),
  authorized: programId.toBytes(),
  networkEncryptionPublicKey: pubkey,
};
const responseBytes = await encryptGrpcCreateInput(GRPC_URL, encodeCreateInputRequest(request));
const { ciphertextIdentifiers } = decodeCreateInputResponse(responseBytes);

// expect: ciphertextIdentifiers.length === inputs.length
if (ciphertextIdentifiers.length !== inputs.length) {
  throw new Error(`CreateInput returned ${ciphertextIdentifiers.length} identifiers; expected ${inputs.length}`);
}
```

one round-trip for the whole label, regardless of chunk count. each chunk gets its own on-chain account (and identifier).

## persistence

```jsonc
record.dwalletMeta[curveDwalletIdx].encryptedLabel = {
  "ciphertextIdentifierHexes": ["a1b2c3...", "d4e5f6...", "789...", "..."],
  "fheType": 5,
  "createdAtMs": 1700000000000,
  "programId": "...",
  "utf8Len": 38                          // CRITICAL - tells reveal how many bytes to trim to
}
```

`utf8Len` is the original byte length **before chunking**. without it, reveal would have to guess where the trailing zero-padding starts (and a label with intentional trailing zero bytes would be ambiguous). storing the length explicitly avoids this entire class of bug.

## reveal: the 4-roundtrip loop

```ts
const chunkValues: Uint8Array[] = [];

for (const idHex of ciphertextIdentifierHexes) {
  const id = hexToBytes(idHex);
  const msg = encodeReadCiphertextMessage(0, id, new Uint8Array(0), 0n);
  const { signature } = await signMessageSol(msg);
  const sigBytes = signatureHexToEd25519Bytes(signature);
  const respBytes = await encryptGrpcReadCiphertext(GRPC_URL, encodeReadCiphertextRequest({
    message: msg, signature: sigBytes, signer: signerPk
  }));
  const { value } = decodeReadCiphertextResponse(respBytes);
  chunkValues.push(value);   // 16-byte chunk plaintext
}
```

each chunk requires a separate sign + read because:
- `ReadCiphertextRequest` carries one identifier; you can't batch reads in pre-alpha
- the executor can't reveal chunks without authentication, and the signature is tied to the message which contains the identifier - one signature per identifier

for a 4-chunk label, that's:
- 4 ika MPC ED25519 signs (4 presign consumed)
- 4 gRPC round-trips
- typically <1 second total on a fast network

## reassembly

```ts
const concatenated = new Uint8Array(chunkValues.length * 16);
for (let i = 0; i < chunkValues.length; i++) {
  concatenated.set(chunkValues[i], i * 16);
}
const trimmed = concatenated.slice(0, utf8Len);
const labelString = new TextDecoder('utf-8', { fatal: false }).decode(trimmed);
```

`fatal: false` produces `?�?�` replacement chars for invalid UTF-8 rather than throwing. defensive against tampering, devnet weirdness, etc.

## partial failure semantics

if any chunk's read fails:
- the whole reveal throws
- chromatika does **not** show a partial label ("hello?�?�?...")
- user sees a "couldn't read chunk N" error and can retry

retrying re-signs each chunk fresh. presign pool keeps refilling; eventually you get all chunks.

## why 16 bytes not 32

EUint128 is the largest size we use. EUint256 doesn't exist in Encrypt's pre-alpha enum. so the natural chunk size is 16 bytes (128 bits = 16 bytes).

a future surface could extend to EUint256 (or arbitrary-length blobs) when Encrypt's protocol supports it. for now, 1-4 chunks of 16 bytes is the design.

## why 64 bytes not arbitrary

practical reasons:
- 64 utf-8 bytes is enough for a meaningful label (English, with allowance for emoji + non-Latin scripts)
- 4 chunks = 4 reveal round-trips, ~1 second total. more chunks = slower reveal
- protocol cap (CreateInput batch is technically up to 16 inputs in a single call, but reveal becomes O(n) sequential reads)

a label limit of 64 bytes covers virtually every UX use case. longer labels are typically arbitrary content (notes, descriptions) that don't belong in an encrypted on-chain wallet field anyway.

## library

- `TextEncoder` / `TextDecoder` (browser native)
- internal: `encodeLabelToChunks`, `decodeLabelFromChunks` in `encrypt-lab-service.ts`
- internal: `mockEncryptScalarBytesFromBytes` for the 17-byte wrap

## related

- [encrypt-create-input.md](/library/tech/encrypt-create-input) - the write path
- [encrypt-read-ciphertext-signed.md](/library/tech/encrypt-read-ciphertext-signed) - the reveal path (per-chunk sign + read)
- [encrypt-17-byte-canonical-format.md](/library/tech/encrypt-17-byte-canonical-format) - how each chunk wraps
