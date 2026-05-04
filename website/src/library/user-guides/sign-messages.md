# how to sign messages across chains

per-chain message signing - covers EVM `personal_sign` + `eth_signTypedData_v4`, Sui personal-message, Solana arbitrary-message, Aptos message, and Bitcoin message signing. these are user- or dapp-initiated message signs that don't broadcast a transaction.

## prerequisites

- a Chromatika vault is unlocked
- the active dWallet has the right curve for the chain you're signing on:
  - EVM, BTC → SECP256K1
  - Sui, Solana, Aptos → ED25519
- the dapp / caller has an existing connection if originating from a dapp

## options at a glance

- **EVM**: `personal_sign` (EIP-191 prefixed) and `eth_signTypedData_v4` (EIP-712)
- **Sui**: `signPersonalMessage` (ika SHA512 path; see notes for Mysten BLAKE2b parity gap)
- **Solana**: arbitrary-message ed25519 sign
- **Aptos**: arbitrary-message ed25519 sign
- **Bitcoin**: hex message sign with the active BTC dWallet

## how to sign an EVM message (`personal_sign`)

1. submit `signEvm` with `message` (the plain string the user wants signed) and `chainId`
2. background hex-encodes per EIP-191 (`\x19Ethereum Signed Message:\n` prefix), runs ika MPC ECDSA against the SECP256K1 dWallet
3. returned signature is 65 bytes (r||s||v) with v picked via `recoverAddress`

## how to sign typed data (`eth_signTypedData_v4`)

1. submit the typed-data structure through the EVM bridge / signing surface
2. **important**: chromatika passes ika the EIP-712 **preimage** via `TypedDataEncoder.encode()`, not the hashed digest. ika hashes once with KECCAK256 internally - if you double-hash, the recovered signer address is wrong
3. signature normalizes through `parseSignatureFromSignOutput` (`Curve.SECP256K1`, `SignatureAlgorithm.ECDSASecp256k1`) and `v` is selected by trying 27 vs 28 against `recoverAddress(keccak256(encodedPreimage), ...)`

## how to sign a Sui personal message

1. submit `sui_signPersonalMessage` (or `signPersonalMessage` via the dapp bridge, depending on entry)
2. background runs the **ika SHA512 path** - signs raw message bytes via ika ED25519 + SHA512, **not** the Mysten BLAKE2b PersonalMessage intent
3. **caveat**: some dapps verify only via Mysten's BLAKE2b intent and may reject the chromatika sig until Mysten-intent BLAKE2b parity ships. tracked as future hardening; documented in [WALLET_SECURITY.md](/library/user/wallet_security)

## how to sign a Solana message

1. submit `signSol` with `messageB64` (base64 of the message bytes)
2. background runs ika MPC ED25519 EdDSA against the active Solana dWallet
3. for dapp-initiated solana sign-message via the bridge, the same path runs after origin consent

## how to sign an Aptos message

1. submit `signAptos` with `messageB64`
2. ika MPC ED25519 path identical to Solana

## how to sign a Bitcoin message

1. submit `signBtc` with `messageHex`
2. signs against the active SECP256K1 dWallet for the configured BTC address (P2WPKH or P2TR depending on selected address kind)

## notes

- the **preimage passthrough** rule applies anywhere ika signs over hashed data: hand ika the preimage bytes, never the hash. this includes both `personal_sign` (EIP-191 wrapped bytes) and typed-data (EIP-712 encoded preimage). double-hashing breaks signer recovery
- on Solana base (pre-alpha), all signatures come from a single mock signer - **do not** use Solana-base for messages dapps will verify against real on-chain identities
- Bitcoin message signing on Solana base is gated by `assertNotSolanaBaseForSecpSigning`
- a Solana sendTx MCP tool (sibling of `sendEvmTx`) is tracked as future; today MCP exposes only `signMessage` (evm + solana), `sendEvmTx`, and `signTransaction` for EVM
