# Encrypt protobuf wire codec (hand-rolled)

chromatika encodes / decodes Encrypt's `CreateInput` and `ReadCiphertext` protobuf messages **by hand** using `@bufbuild/protobuf`'s low-level `BinaryWriter` / `BinaryReader`. no `.proto` files, no codegen step. the message shapes are small enough that a focused hand-rolled codec is simpler than wiring up the full `protoc-gen-*` pipeline.

## why hand-rolled

the alternatives:
1. **bufbuild/protobuf-es codegen**: requires `.proto` files and a build step (`buf generate` or similar). overkill for two messages
2. **runtime reflection**: requires loading `.proto` files at runtime, parsing, registering. heavier than the schema warrants
3. **manual `BinaryWriter` / `BinaryReader`**: tiny, explicit, easy to audit

we picked manual. the pattern:
- field N with tag `T` and wire type `W`: `writer.tag(N, W).type(value)`
- on decode: `while (reader.pos < reader.len) { switch (reader.tag()) { case N: ... } }`

## protobuf wire types we use

| wire type | what | tag byte form |
|-----------|------|---------------|
| 0 (VARINT) | int32, int64, uint32, uint64, bool, enum | `(field_number << 3) \| 0` |
| 2 (LEN) | string, bytes, embedded message, repeated of any | `(field_number << 3) \| 2` |

field numbers and wire types combine into the **tag**: the first byte (or varint) of each field. for example, field 1, wire type 2 (LEN, e.g. bytes) → tag `0x0A` (`(1 << 3) | 2 = 10`). field 2, wire type 2 → tag `0x12` (`(2 << 3) | 2 = 18`). etc.

## CreateInputRequest encoding

```js
function encodeCreateInputRequest(message: CreateInputRequestWire): Uint8Array {
  const writer = new BinaryWriter();

  // field 1: chain (int32) - tag 0x08
  if (message.chain !== 0) {
    writer.tag(1, WireType.Varint).int32(message.chain);
  }

  // field 2: inputs (repeated EncryptedInput) - tag 0x12
  for (const input of message.inputs) {
    const inputWriter = new BinaryWriter();
    // EncryptedInput field 1: ciphertextBytes (bytes) - tag 0x0A
    inputWriter.tag(1, WireType.LengthDelimited).bytes(input.ciphertextBytes);
    // EncryptedInput field 2: fheType (int32) - tag 0x10
    inputWriter.tag(2, WireType.Varint).int32(input.fheType);
    const inputBytes = inputWriter.finish();

    writer.tag(2, WireType.LengthDelimited).bytes(inputBytes);
  }

  // field 3: proof (bytes) - tag 0x1A
  writer.tag(3, WireType.LengthDelimited).bytes(message.proof);

  // field 4: authorized (bytes, 32-byte program id) - tag 0x22
  writer.tag(4, WireType.LengthDelimited).bytes(message.authorized);

  // field 5: networkEncryptionPublicKey (bytes, 32 bytes) - tag 0x2A
  writer.tag(5, WireType.LengthDelimited).bytes(message.networkEncryptionPublicKey);

  return writer.finish();
}
```

field-by-field:
| field | wire type | tag byte | content |
|-------|-----------|----------|---------|
| 1: chain | varint | 0x08 | int32 (0 = Solana) |
| 2: inputs[] | LEN | 0x12 | repeated EncryptedInput (each is its own embedded message) |
| 3: proof | LEN | 0x1A | bytes (empty in pre-alpha) |
| 4: authorized | LEN | 0x22 | bytes (32-byte program id) |
| 5: networkEncryptionPublicKey | LEN | 0x2A | bytes (32-byte network pubkey) |

## CreateInputResponse decoding

```js
function decodeCreateInputResponse(data: Uint8Array): CreateInputResponseWire {
  const reader = new BinaryReader(data);
  const ciphertextIdentifiers: Uint8Array[] = [];

  while (reader.pos < reader.len) {
    const [fieldNo, wireType] = reader.tag();
    if (fieldNo === 1 && wireType === WireType.LengthDelimited) {
      ciphertextIdentifiers.push(reader.bytes());
    } else {
      reader.skip(wireType);
    }
  }

  return { ciphertextIdentifiers };
}
```

the response has just one repeated bytes field (field 1) - one identifier per input chunk. the server returns them in order.

## ReadCiphertextRequest encoding

```js
function encodeReadCiphertextRequest(message: ReadCiphertextRequestWire): Uint8Array {
  const writer = new BinaryWriter();
  writer.tag(1, WireType.LengthDelimited).bytes(message.message);     // BCS-encoded message
  writer.tag(2, WireType.LengthDelimited).bytes(message.signature);   // 64-byte ed25519 sig
  writer.tag(3, WireType.LengthDelimited).bytes(message.signer);      // 32-byte ed25519 pubkey
  return writer.finish();
}
```

| field | wire type | tag byte | content |
|-------|-----------|----------|---------|
| 1: message | LEN | 0x0A | BCS-encoded message bytes (see [encrypt-read-ciphertext-signed.md](/library/tech/encrypt-read-ciphertext-signed)) |
| 2: signature | LEN | 0x12 | 64-byte ed25519 signature over `message` |
| 3: signer | LEN | 0x1A | 32-byte ed25519 public key |

## ReadCiphertextResponse decoding

```js
function decodeReadCiphertextResponse(data: Uint8Array): ReadCiphertextResponseWire {
  const reader = new BinaryReader(data);
  let value = new Uint8Array();
  let fheType = 0;
  let digest = new Uint8Array();

  while (reader.pos < reader.len) {
    const [fieldNo, wireType] = reader.tag();
    if (fieldNo === 1 && wireType === WireType.LengthDelimited) {
      value = reader.bytes();
    } else if (fieldNo === 2 && wireType === WireType.Varint) {
      fheType = reader.int32();
    } else if (fieldNo === 3 && wireType === WireType.LengthDelimited) {
      digest = reader.bytes();
    } else {
      reader.skip(wireType);
    }
  }

  return { value, fheType, digest };
}
```

response shape:
| field | wire type | content |
|-------|-----------|---------|
| 1: value | LEN | 16-byte plaintext (for EUint128) or 8-byte (for EUint64) |
| 2: fheType | varint | int32 (4 = EUint64, 5 = EUint128) |
| 3: digest | LEN | opaque executor-local proof bytes |

## the `reader.skip(wireType)` defensive case

if the server adds new fields in a future protobuf version, our decoder shouldn't crash - it should skip unknown fields. `BinaryReader.skip(wireType)` advances the cursor past the unknown field's bytes (varint reads + ignores; LEN reads length prefix + skips body).

protobuf's compatibility model is that unknown fields are silently ignored on decode and not re-emitted on encode. our codec follows this pattern.

## why no proof construction

`CreateInputRequest.proof` is empty in pre-alpha. when production Encrypt ships, the proof field will carry zero-knowledge proofs that the input was correctly encrypted. chromatika will then need to construct those proofs client-side (or use the network's encryption public key with a real client encrypt that produces them). today: empty bytes.

## library

- `@bufbuild/protobuf` `BinaryWriter`, `BinaryReader`, `WireType` enum
- internal: `wallet-extension/src/background/encrypt/encrypt-protobuf-wire.ts`

## related

- [encrypt-grpc-web-fetch-transport.md](/library/tech/encrypt-grpc-web-fetch-transport) - how the encoded bytes get to the network
- [encrypt-17-byte-canonical-format.md](/library/tech/encrypt-17-byte-canonical-format) - what's inside `EncryptedInput.ciphertextBytes`
- [encrypt-create-input.md](/library/tech/encrypt-create-input) - the full encrypt flow that calls this codec
- [encrypt-read-ciphertext-signed.md](/library/tech/encrypt-read-ciphertext-signed) - the reveal flow
