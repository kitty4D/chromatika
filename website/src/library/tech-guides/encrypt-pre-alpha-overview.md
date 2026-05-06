# Encrypt.xyz integration (pre-alpha overview)

chromatika integrates `@encrypt.xyz/pre-alpha-solana-client@0.1.0` to provide encrypted dWallet labels and lab-grade encrypted-input experiments on Solana ika base. **lab-grade pre-alpha**: the Encrypt program disclaimer says ciphertexts can be plaintext on-chain in this phase. **never** store real secrets in encrypted labels.

## what Encrypt is

Encrypt.xyz is a Solana-native FHE (fully homomorphic encryption) executor. clients upload "encrypted inputs" via gRPC `CreateInput`; the network materializes them as on-chain accounts; computations on those ciphertexts can run via Encrypt program instructions; reading a ciphertext requires a signed `ReadCiphertext` request. chromatika uses two tiny corners of this surface:

1. **encrypted dWallet labels**: encode a UTF-8 label as 1-4 EUint128 chunks, write via CreateInput, surface the on-chain status. reveal via signed ReadCiphertext (signature comes from the dWallet's ed25519 path).
2. **encryption lab demos**: bare CreateInput (single + batched up to 16 EUint64s) and ReadCiphertext for SDK exploration.

future surfaces (SPL deposit, PC-Token / PC-Swap phases 3-4) are stubbed (`encrypt-spl-deposit-stub.ts`, `encrypt-pc-phase-stub.ts`) - tRPC returns `not_wired` until program alignment.

## the high-level data flow

```
plaintext value (e.g. label string)
  → mock-encrypt to 17-byte canonical format          (encrypt-lab-service.ts)
  → CreateInput gRPC over gRPC-web fetch              (encrypt-grpc-web-fetch.ts)
  → on-chain ciphertext account materialized          (Solana program)
  → identifier (b32 / b58 / hex) returned to client
  → store identifier in chromatika dwallet meta       (per-vault overlay)

later, on reveal:

stored identifier
  → encodeReadCiphertextMessage (BCS layout)          (encrypt-read-msg.ts)
  → signMessageSol (signs the BCS message via dWallet ed25519 path)
  → ReadCiphertext gRPC over gRPC-web fetch
  → 16-byte plaintext value + fheType + digest returned
  → reassemble multi-chunk labels into UTF-8 string
```

## the Solana ika base requirement

every encrypt procedure asserts Solana ika base via `assertEncryptSolanaIkaBase()`:

- Sui-base vaults throw at the API boundary
- `VITE_SOLANA_IKA_BASE=true` must be set at build time
- session must be unlocked + on a Solana-base vault

`isEncryptAllowedForSession()` is the non-throwing variant for surfaces that just want to hide encrypt UI on Sui-base vaults.

## constants

```js
GRPC_URL = "https://pre-alpha-dev-1.encrypt.ika-network.net:443";
ENCRYPT_SOLANA_PROGRAM_ID = "<base58 program id>"; // see encrypt-constants.ts
LABEL_MAX_UTF8_BYTES = 64; // 4 × 16-byte chunks
FHE_TYPE_EUINT64 = 4;
FHE_TYPE_EUINT128 = 5; // labels use this
```

## the published-SDK-bug situation

`@encrypt.xyz/pre-alpha-solana-client@0.1.0` ships an `encryptValue` helper that produces the **pre-fix 16-byte format** (`[value_le(16)]`) - missing the 1-byte `fhe_type` prefix. this misreads multi-byte scalars (e.g. EUint64 returns `value >> 8`).

the upstream fix landed at commit `303439d` (2026-04-26) but hasn't been republished to npm. so chromatika **hand-rolls** the 17-byte format via `mockEncryptScalarBytes` / `mockEncryptScalarBytesFromBytes` in `encrypt-lab-service.ts`. anything that calls Encrypt's `CreateInput` with `ciphertextBytes` must use these helpers, not the package's `encryptValue`, until upstream republishes.

## what's stored in chromatika

per-curve dWallet meta overlay (`chromatika_dwallet_meta_v2_<vaultId>`) gets an `encryptedLabel` entry:

```jsonc
{
  "encryptedLabel": {
    "ciphertextIdentifierHexes": ["abc...", "def..."], // 1-4 hex identifiers
    "fheType": 5, // EUINT128
    "createdAtMs": 1700000000000,
    "programId": "<base58 program id>",
    "utf8Len": 8, // e.g. for "myLabel\0" trim
  },
}
```

we store the **identifiers** plus the **utf8 length** locally. the actual ciphertext lives on-chain in Solana program accounts. on reveal, we look up by identifier.

## file map

| file                          | purpose                                                                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `encrypt-lab-service.ts`      | core encrypt / reveal / status logic, label chunking, mockEncryptScalarBytes helpers, network key resolution, on-chain status polling       |
| `encrypt-constants.ts`        | `GRPC_URL`, `RPC_URL`, program id, docs URLs                                                                                                |
| `encrypt-read-msg.ts`         | `encodeReadCiphertextMessage` BCS layout                                                                                                    |
| `encrypt-protobuf-wire.ts`    | CreateInput / ReadCiphertext protobuf wire codec (no `.proto` files; hand-rolled with `@bufbuild/protobuf` `BinaryWriter` / `BinaryReader`) |
| `encrypt-grpc-web-fetch.ts`   | gRPC-web unary transport wrapper (fetch + `@protobuf-ts/grpcweb-transport`)                                                                 |
| `encrypt-guard.ts`            | `assertEncryptSolanaIkaBase`, `isEncryptAllowedForSession`                                                                                  |
| `DwalletEncryptedLabel.tsx`   | React component: encrypt / reveal / clear UI, 4s on-chain status polling                                                                    |
| `encrypt.ts` (router)         | tRPC procedures bridging UI to encrypt-lab-service                                                                                          |
| `encrypt-executor-poll.ts`    | generic polling helper (available, not directly used for labels)                                                                            |
| `encrypt-spl-deposit-stub.ts` | future SPL Enc deposit (returns `not_wired`)                                                                                                |
| `encrypt-pc-phase-stub.ts`    | future PC-Token / PC-Swap phases (returns `not_wired`)                                                                                      |

## related deep-dives

- [encrypt-17-byte-canonical-format.md](/library/tech/encrypt-17-byte-canonical-format) - the byte layout
- [encrypt-grpc-web-fetch-transport.md](/library/tech/encrypt-grpc-web-fetch-transport) - HTTP/1.1 gRPC-web wrapping
- [encrypt-protobuf-wire.md](/library/tech/encrypt-protobuf-wire) - hand-rolled protobuf encode / decode
- [encrypt-create-input.md](/library/tech/encrypt-create-input) - the encrypt path
- [encrypt-read-ciphertext-signed.md](/library/tech/encrypt-read-ciphertext-signed) - the reveal path with signed messages
- [encrypt-multi-chunk-labels.md](/library/tech/encrypt-multi-chunk-labels) - 64-byte UTF-8 → 4 × 16-byte chunks
- [encrypt-on-chain-status-polling.md](/library/tech/encrypt-on-chain-status-polling) - the 4s status pill
