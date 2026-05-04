# how to use the encryption lab

a developer / lab surface for creating Encrypt.xyz pre-alpha encrypted inputs and reading ciphertexts. only works on **Solana ika base** (assertions throw on Sui). primarily for SDK exploration; real product flows for dWallet labels live in [encrypted-dwallet-labels.md](/library/user/encrypted-dwallet-labels).

## prerequisites

- a Chromatika vault is unlocked
- the active dWallet Vault is on **Solana base** (the procedures assert this and throw on Sui base)
- the build has the encrypt-pre-alpha client wired

## options at a glance

- **encrypted input creation**: single (`encryptLabCreateInput`) or batched up to 16 (`encryptLabCreateInputBatch`)
- **ciphertext reads**: by ciphertext identifier hex, with optional epoch
- **deposit / phase notes**: stub references for SPL Enc deposit and the PC phases (3 + 4); these are documentation pointers, not wired flows

## how to create an encrypted input

1. submit `encryptLabCreateInput` with `plainU64` (the value to encrypt) and optional `networkEncryptionPublicKeyHex` (override the active network key)
2. background packs the value as `[fhe_type(1) || value_le(16)]` (17 bytes), submits `CreateInput`, returns the ciphertext identifier
3. for several values at once: `encryptLabCreateInputBatch` with `plainU64s` (1-16 values) and the same optional key
4. all encryption uses the canonical 17-byte format via the hand-rolled `mockEncryptScalarBytesFromBytes` (the published client's `encryptValue` is still 16-byte until upstream republishes)

## how to read a ciphertext

1. submit `encryptLabReadCiphertext` with `ciphertextIdentifierHex` and optional `epochDecimal`
2. background runs signed `ReadCiphertext` against the active dWallet, returns the plaintext value
3. used by lab UI / debugging to verify round-trips

## how to view roadmap stub references

- `encryptLabDepositHint` returns SPL Enc deposit implementation notes (read-only; no wired flow today)
- `encryptSplEncDepositPath` returns the same as a separate label
- `encryptPcTokenPhase3` returns Phase 3 (PC-Token) reference
- `encryptPcSwapPhase4` returns Phase 4 (PC-Swap) reference

these are documentation surfaces only - tRPC returns `not_wired` for actual deposit / swap calls until the on-chain programs / SDK alignment lands

## notes

- **lab surface only** - production flows for encrypted dWallet labels are in [encrypted-dwallet-labels.md](/library/user/encrypted-dwallet-labels). don't build product UI on top of these procedures
- 17-byte format fix landed upstream in `encrypt-pre-alpha` `303439d` (2026-04-26). the published `@encrypt.xyz/pre-alpha-solana-client@0.1.0` is still pre-fix; chromatika hand-rolls until republish
- pre-alpha disclaimer applies: ciphertexts may not be encrypted on-chain in this phase. treat all values as exploratory
- the gRPC fee-payer needs SOL for `approve_message` calls during `CreateInput` / `ReadCiphertext` (see [ika-fee-management.md](/library/user/ika-fee-management))
