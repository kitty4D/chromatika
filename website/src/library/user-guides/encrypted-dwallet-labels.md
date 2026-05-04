# how to use encrypted dWallet labels

on Solana ika base, you can attach an **encrypted on-chain label** to a dWallet using the Encrypt.xyz pre-alpha primitive. the label ciphertext lives on Solana; reveal goes through a signed `ReadCiphertext` call. this is a **lab-grade pre-alpha** feature - the Encrypt program disclaimer says ciphertexts can be plaintext on-chain in pre-alpha; treat it as exploratory.

## prerequisites

- a Chromatika vault is unlocked
- the active dWallet Vault is on **Solana base** (the procedures assert this and throw on Sui base)
- the build has the encrypt-pre-alpha client wired
- the active dWallet has the curve you want to label (SECP256K1 or ED25519)
- session is enabled for label work (see `getDwalletLabelStatus`)

## options at a glance

- **label**: 1 to 64 utf-8 bytes (4 × EUint128 chunks of 16 bytes each)
- **per curve**: SECP256K1 dWallet labels and ED25519 dWallet labels are independent
- **on-chain status**: polled every 4 seconds; values include `verified` (✓ ciphertext present), `encrypting` (in flight), `missing` (devnet wipe or never written)

## how to check label session status

1. call `getDwalletLabelStatus` with `curve`
2. response includes `enabledForSession` flag - tells you whether the wallet has the encryption material loaded for this session
3. solana-base only; throws on Sui

## how to query the on-chain label status for a dWallet

1. call `getDwalletLabelOnChainStatus` with `curve`
2. response is the status byte from the on-chain account: verified / encrypting / missing
3. drives the surface pill state. `missing` after a devnet wipe means the on-chain ciphertext is gone (rebuild needed)

## how to encrypt a label

1. submit `encryptDwalletLabel` with: `curve`, `label` (1-64 chars), optional `networkEncryptionPublicKeyHex` (override; defaults to current network key)
2. background packs the label into 4 × EUint128 chunks (16 bytes each), runs `mockEncryptScalarBytesFromBytes` to produce the **canonical 17-byte format** `[fhe_type(1) || value_le(16)]`, batches them in one `CreateInput` round-trip, writes the ciphertext on-chain
3. on-chain status flips to `encrypting` then `verified` once the program confirms

## how to reveal a stored label

1. submit `revealDwalletLabel` with `curve`
2. background loops over the chunk identifiers, runs signed `ReadCiphertext` for each (signed via the dWallet's ed25519 path - same as `signMessageSol`), concatenates the plaintext, returns the label

## how to clear a label

1. submit `clearDwalletLabel` with `curve`
2. on-chain ciphertext is cleared; status returns to `missing`

## notes

- **17-byte canonical format**: `EncryptedInput.ciphertext_bytes` MUST be `[fhe_type(1) || value_le(16)]`. the published `@encrypt.xyz/pre-alpha-solana-client@0.1.0` `encryptValue` is still the pre-fix 16-byte form (known to misread multi-byte scalars - e.g. EUint64 returns `value >> 8`). chromatika hand-rolls via `mockEncryptScalarBytes` / `mockEncryptScalarBytesFromBytes` until upstream republishes
- pre-alpha disclaimer: ciphertexts may be plaintext on-chain in this phase. don't put anything secret in a label
- devnet wipe: solana ika devnet gets wiped periodically; on next reveal you'll see `missing` and need to clear + re-encrypt manually. automated rebuild on first reveal failure is tracked future
- this is a **dWallet** label, not a vault label - distinct from the vault label set via `renameVault`
