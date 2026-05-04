# Encrypt CreateInput flow

chromatika's path for writing a value (or batch of values) to the Encrypt executor as on-chain ciphertext. labels and lab demos both go through this. produces a list of **ciphertext identifiers** that act as on-chain handles for later reveal / compute.

## the call signature

```ts
async function createDwalletLabelCiphertext({
  curve,
  label,                              // string, 1-64 utf-8 bytes
  networkEncryptionPublicKeyHex?,     // optional override
}): Promise<{
  ciphertextIdentifierHexes: string[],
  fheType: 5,
  utf8Len: number,
  programId: string,
}> { ... }
```

similar API for the lab demos:
```ts
async function encryptLabCreateInputDemo({ plainU64, networkEncryptionPublicKeyHex? })
async function encryptLabCreateInputDemoBatch({ plainU64s, networkEncryptionPublicKeyHex? })   // up to 16
```

## step-by-step (label flow)

```
1. validate input
   trimmed = label.trim()
   utf8Bytes = UTF8Encoder.encode(trimmed)
   if utf8Bytes.length > 64: throw 'label too long'
   if utf8Bytes.length === 0: throw 'label empty'

2. resolve network encryption public key
   pubkey = await resolveNetworkEncryptionPublicKey(connection, programId, overrideHex)
   // tries override hex if provided, else queries on-chain PDA via:
   //   ['network_encryption_key', 'network-encryption-key', 'NetworkEncryptionKey']
   // reads bytes at offset 8 (40-byte account) or 0 (32-byte account)

3. slice into chunks of 16 bytes (left-justified, zero-padded)
   chunks = []
   for i in 0..ceil(utf8Bytes.length / 16):
     chunk = new Uint8Array(16)
     chunk.set(utf8Bytes.slice(i * 16, (i + 1) * 16))   // copies + auto-pads with zeros
     chunks.push(chunk)
   // 1-4 chunks for a 1-64 byte label

4. wrap each chunk in 17-byte canonical format
   inputs = chunks.map(chunk => ({
     ciphertextBytes: mockEncryptScalarBytesFromBytes(chunk, FHE_TYPE_EUINT128),  // 17 bytes
     fheType: FHE_TYPE_EUINT128,
   }))

5. encode protobuf request
   request = {
     chain: 0,                                        // Solana
     inputs,                                          // 1-4 EncryptedInput
     proof: new Uint8Array(),                         // empty in pre-alpha
     authorized: programId.toBytes(),                 // 32-byte program id
     networkEncryptionPublicKey: pubkey,              // 32 bytes
   }
   encoded = encodeCreateInputRequest(request)

6. send via gRPC-web
   responseBytes = await encryptGrpcCreateInput(GRPC_URL, encoded)

7. decode response
   { ciphertextIdentifiers } = decodeCreateInputResponse(responseBytes)
   // expect ciphertextIdentifiers.length === inputs.length
   if length mismatch: throw 'CreateInput returned N identifiers; expected M'

8. persist locally in dWallet meta
   record.dwalletMeta[curve_dwallet_idx].encryptedLabel = {
     ciphertextIdentifierHexes: ciphertextIdentifiers.map(toHex),
     fheType: 5,
     createdAtMs: Date.now(),
     programId: programId.toBase58(),
     utf8Len: utf8Bytes.length,
   }
   await saveDwalletMeta(vaultId, record.dwalletMeta)

9. return identifiers + metadata to the caller
```

## the network encryption public key lookup

```ts
async function resolveNetworkEncryptionPublicKey(
  connection: Connection,
  programId: PublicKey,
  overrideHex?: string,
): Promise<Uint8Array> {
  // 1. user-supplied override
  if (overrideHex && /^[0-9a-fA-F]{64}$/.test(overrideHex)) {
    return hexToBytes(overrideHex);
  }

  // 2. try seeds in order
  const seeds = ['network_encryption_key', 'network-encryption-key', 'NetworkEncryptionKey'];
  for (const seed of seeds) {
    const [pda] = PublicKey.findProgramAddressSync([Buffer.from(seed)], programId);
    const account = await connection.getAccountInfo(pda);
    if (!account) continue;
    if (account.data.length === 40) return account.data.slice(8, 40);   // 8-byte discriminator + 32 bytes
    if (account.data.length === 32) return account.data.slice(0, 32);
  }

  // 3. all seeds failed
  throw new Error(
    `network encryption key PDA not found at any tried seed for program ${programId}; ` +
    `paste 32-byte hex via networkEncryptionPublicKeyHex or confirm RPC + program id match Encrypt pre-alpha`
  );
}
```

three seed candidates because the on-chain layout has shifted between pre-alpha versions; we try each before bailing. providing a hex override skips the lookup entirely.

## what the response identifiers are

`ciphertextIdentifierHexes` are **executor-local handles**, not opaque secrets. each one corresponds to an on-chain account at a deterministic PDA derived from the executor's storage layout. the identifiers can be written to chain-public storage without leaking the underlying ciphertext (since the ciphertext itself is what protects the value, not the identifier).

chromatika persists identifiers in dWallet meta (see [vault-blob-v3-format.md](/library/tech/vault-blob-v3-format) for the overlay structure). on reveal, the identifiers are fed back into `ReadCiphertext` requests.

## error handling

- network failure (gRPC unreachable): wrapped, surfaced as "encrypt service unavailable"
- network encryption key not found: throws with actionable message (paste hex or confirm RPC / program id)
- length mismatch (server returned fewer identifiers than inputs sent): throws as protocol violation
- session not on Solana ika base: throws via `assertEncryptSolanaIkaBase()` before any network call
- rate limit (HTTP 429 from server): bubbled up; user retries

## the lab demos use the same machinery

```ts
async function encryptLabCreateInputDemo({ plainU64, ... }) {
  const inputs = [{
    ciphertextBytes: mockEncryptScalarBytes(plainU64, FHE_TYPE_EUINT64),   // 17 bytes
    fheType: FHE_TYPE_EUINT64,
  }];
  // same encoding, same gRPC call, same decoding
  // returns single ciphertextIdentifierHex
}

async function encryptLabCreateInputDemoBatch({ plainU64s, ... }) {
  if (plainU64s.length > 16) throw 'batch capped at 16';
  const inputs = plainU64s.map(v => ({
    ciphertextBytes: mockEncryptScalarBytes(v, FHE_TYPE_EUINT64),
    fheType: FHE_TYPE_EUINT64,
  }));
  // same path; returns ciphertextIdentifierHexes (one per value, in order)
}
```

label flow uses EUint128 chunks; lab demos use EUint64 scalars. the 17-byte format is the same shape.

## library

- internal: `wallet-extension/src/background/encrypt/encrypt-lab-service.ts` `createDwalletLabelCiphertext`, `encryptLabCreateInputDemo`, `encryptLabCreateInputDemoBatch`, `resolveNetworkEncryptionPublicKey`
- internal: `encrypt-protobuf-wire.ts` `encodeCreateInputRequest`, `decodeCreateInputResponse`
- internal: `encrypt-grpc-web-fetch.ts` `encryptGrpcCreateInput`
- internal: `encrypt-lab-service.ts` `mockEncryptScalarBytesFromBytes`, `mockEncryptScalarBytes`
- `@solana/web3.js` `Connection`, `PublicKey.findProgramAddressSync`

## related

- [encrypt-17-byte-canonical-format.md](/library/tech/encrypt-17-byte-canonical-format) - the byte layout we mock-encrypt to
- [encrypt-protobuf-wire.md](/library/tech/encrypt-protobuf-wire) - the request encoding
- [encrypt-grpc-web-fetch-transport.md](/library/tech/encrypt-grpc-web-fetch-transport) - the network transport
- [encrypt-multi-chunk-labels.md](/library/tech/encrypt-multi-chunk-labels) - the chunking strategy for >16-byte labels
- [encrypt-on-chain-status-polling.md](/library/tech/encrypt-on-chain-status-polling) - what happens after persistence (the 4s poll)
