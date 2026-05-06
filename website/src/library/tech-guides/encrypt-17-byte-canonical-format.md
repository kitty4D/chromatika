# Encrypt 17-byte canonical input format

every encrypted input chromatika sends to the Encrypt executor uses this exact 17-byte byte layout:

```
[fhe_type(1 byte) || value_le(16 bytes)]
```

without the leading `fhe_type` byte, the executor falls into a fallback path that misreads multi-byte scalars (e.g. `EUint64` returns `value >> 8`). the format fix landed upstream at `encrypt-pre-alpha` `303439d` (2026-04-26); the published `@encrypt.xyz/pre-alpha-solana-client@0.1.0`'s `encryptValue` is still pre-fix, so chromatika **hand-rolls** this format via two helpers.

## the bytes

| offset | length | what                                                            |
| ------ | ------ | --------------------------------------------------------------- |
| 0      | 1      | `fhe_type` enum value                                           |
| 1-16   | 16     | `value_le` little-endian bytes (zero-padded for values < 2^128) |

total: 17 bytes per encrypted input.

## fhe_type values

```js
FHE_TYPE_EUINT64 = 4;
FHE_TYPE_EUINT128 = 5;
```

other values exist in Encrypt's protocol (EUint8, EUint16, EUint32, etc.) but chromatika only writes EUint64 (lab demos) and EUint128 (labels). reads return whatever fheType the on-chain ciphertext was created with.

## the two helpers

```ts
// 1. take a number / bigint, encode LE across 16 bytes, prepend fheType
function mockEncryptScalarBytes(value: number | bigint, fheType: number): Uint8Array {
  const buf = new Uint8Array(17);
  buf[0] = fheType;
  let v = BigInt(value);
  for (let i = 0; i < 16; i++) {
    buf[1 + i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return buf;
}

// 2. take pre-formatted 16-byte value (left-justified, zero-padded UTF-8 chunk),
//    prepend fheType. used by label encoder to avoid bigint round-trip
function mockEncryptScalarBytesFromBytes(valueLe16: Uint8Array, fheType: number): Uint8Array {
  if (valueLe16.length !== 16) throw new Error("expected 16-byte value");
  const buf = new Uint8Array(17);
  buf[0] = fheType;
  buf.set(valueLe16, 1);
  return buf;
}
```

both live in `wallet-extension/src/background/encrypt/encrypt-lab-service.ts`.

## why "mock"

these helpers don't actually encrypt anything - they format raw plaintext bytes into the shape Encrypt's gRPC `CreateInput` expects. the **executor** does the encryption (or in pre-alpha, may store ciphertexts as plaintext per the disclaimer). naming them `mockEncrypt*` reflects that they don't perform crypto themselves; they're just packaging.

a future hardening step is to do client-side encryption to the network's encryption public key before submission, so the executor never sees plaintext. that's tracked but not implemented today.

## little-endian rationale

Encrypt's executor reads scalars in little-endian. a 16-byte LE encoding of `value` puts the least-significant byte first:

```
value = 1
bytes = [0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]

value = 256
bytes = [0x00, 0x01, 0x00, 0x00, ...]

value = 0xFFFFFFFFFFFFFFFFFFFF (10 bytes of 0xFF)
bytes = [0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
```

for label chunks (UTF-8 bytes packed into 16-byte chunks), the chunk bytes are placed at offsets 1-16 directly with zero-padding at the high end. so a 5-byte label chunk like `"hello"` becomes:

```
chunk_utf8 = [0x68, 0x65, 0x6C, 0x6C, 0x6F, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
buf = [0x05, 0x68, 0x65, 0x6C, 0x6C, 0x6F, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        ^fhe_type=5      ^chunk bytes (LE) zero-padded
```

note: although we call it "value_le", for label chunks the bytes are placed in their natural order (leftmost UTF-8 byte at offset 1) - that's still "LE" in the sense that lower-significance bits come first if you treat the chunk as a 128-bit integer. EUint128 is just a 128-bit unsigned int from the executor's perspective; we use it as a fixed-size byte container.

## what gets sent to CreateInput

`CreateInputRequest.inputs[]` is a list of `EncryptedInput`s. each `EncryptedInput` has:

```jsonc
{
  "ciphertextBytes": "<17-byte buffer>",
  "fheType": 5,
}
```

note `fheType` is also redundantly included as a separate field. the executor uses both; mismatch is undefined behavior. we always set them consistently.

## reads return 16 bytes plus fheType

`ReadCiphertextResponse` returns:

```jsonc
{
  "value": "<16-byte plaintext value, no leading type byte>",
  "fheType": 5,
  "digest": "<opaque executor-local proof state>",
}
```

read response **strips** the type byte - the response carries `fheType` as a separate field. so if you write `[5, 0x68, 0x65, 0x6C, 0x6C, 0x6F, ...]` (17 bytes), you read back `value = [0x68, 0x65, 0x6C, 0x6C, 0x6F, ...]` (16 bytes) plus `fheType = 5`.

decoders need to know `fheType` to interpret the 16 bytes correctly:

- EUint64 → take low 8 bytes, interpret as u64 LE
- EUint128 → take all 16 bytes, interpret as u128 LE
- (when used for labels) ignore the int interpretation, use the bytes directly as UTF-8 chunk

## why not just use a real FHE client-side encrypt

production Encrypt **will** do client-side encryption to the network's encryption public key, producing actual ciphertexts that the executor can compute on without seeing plaintext. pre-alpha skips this for development speed. when the real client encrypt ships, chromatika swaps `mockEncryptScalarBytesFromBytes` for the real `encrypt(networkPubKey, plaintext)` and the executor receives cipher bytes instead of plaintext.

## library

- internal: `mockEncryptScalarBytes`, `mockEncryptScalarBytesFromBytes` in `encrypt-lab-service.ts`
- internal: `encrypt-protobuf-wire.ts` for serializing `EncryptedInput` to protobuf
