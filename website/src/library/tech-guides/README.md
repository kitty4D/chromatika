# chromatika tech guides (deep dive)

deep-tech reference for **how** chromatika does what it does. each doc focuses on one technical element / action - exact bytes, exact functions, exact data flows. complement to the [user guides](/library/user/readme) (which describes **what** users can do).

these pages are published on the chromatika site alongside the extension. audience: testers, devs, AI agents driving the wallet via MCP, security reviewers.

chromatika is **pre-release**. Solana ika base is **pre-alpha** (single mock signer; never trust for real value). disclaimers in each doc reflect status.

## crypto primitives

- [argon2id KDF](/library/tech/argon2id-kdf) - the password → AES-key derivation (RFC 9106 §4 second profile)
- [AES-256-GCM vault encryption](/library/tech/aes-gcm-vault) - the vault blob encryption + auth
- [keccak256 uses](/library/tech/keccak256-uses) - ika seed derivation, EVM digest, address derivation
- [SHA-512 + BLAKE2b](/library/tech/sha512-and-blake2b) - the Sui personal-message divergence root cause
- [BIP39 mnemonics](/library/tech/bip39-mnemonic) - 12/24-word phrase generation + validation
- [BIP44 + SLIP10 derivation](/library/tech/bip44-slip10-derivation) - HD paths per chain (EVM / BTC / Sui / Solana / Aptos)
- [secp256k1 ECDSA](/library/tech/ecdsa-secp256k1) - EVM + BTC signing curve
- [ed25519 EdDSA](/library/tech/ed25519-eddsa) - Sui / Solana / Aptos signing curve + RFC 8032 determinism
- [taproot Schnorr (BIP340)](/library/tech/taproot-schnorr) - BTC P2TR signing

## vault encryption + envelopes

- [vault blob v3 format](/library/tech/vault-blob-v3-format) - `chromatika_vault_v3` outer + inner shape
- [multi-envelope design](/library/tech/multi-envelope-design) - one masterKey, many credentials (V4)
- [password envelope](/library/tech/password-envelope) - argon2id → envKey → unwrap masterKey
- [passkey PRF envelope](/library/tech/passkey-prf-envelope) - WebAuthn PRF / hmac-secret based
- [wallet-signature envelope](/library/tech/wallet-signature-envelope) - WAAP / Seeker / WC signature based
- [recovery-words envelope](/library/tech/recovery-words-envelope) - BIP39 phrase based
- [cold-SW unlock cache](/library/tech/cold-sw-unlock-cache) - `chromatika_unlock_cache_v1` in `chrome.storage.session`

## ika `UserShareEncryptionKeys` seed derivation

- [overview](/library/tech/ika-seed-derivation-overview) - the four formula variants, per-credential dispatch
- [Sui base + mnemonic](/library/tech/ika-seed-sui-mnemonic)
- [Sui base + private key](/library/tech/ika-seed-sui-private-key)
- [Sui base + passkey (WebAuthn PRF)](/library/tech/ika-seed-sui-passkey)
- [Sui base + WAAP](/library/tech/ika-seed-sui-waap)
- [Sui base + Ledger (key-copy)](/library/tech/ika-seed-sui-ledger-keycopy)
- [Solana base + mnemonic](/library/tech/ika-seed-solana-mnemonic)
- [Solana base + private key](/library/tech/ika-seed-solana-private-key)
- [Solana base + MWA / WalletConnect (signature-derived)](/library/tech/ika-seed-solana-mwa-walletconnect)
- [Solana base + Ledger (key-copy)](/library/tech/ika-seed-solana-ledger-keycopy)
- [Solana base + Lazor](/library/tech/ika-seed-solana-lazor)

## ika MPC operations

- [2PC-MPC overview](/library/tech/2pc-mpc-overview) - the threshold signing model, Sui vs Solana base
- [DKG flow](/library/tech/ika-dkg-flow) - distributed key generation per curve
- [accept-share zero-trust](/library/tech/ika-accept-share-zerotrust) - decrypt + verify before claiming dWallet
- [presign pool implementation](/library/tech/ika-presign-pool-impl) - 3 pools, 5-min refill, per-vault scoping
- [sign flow](/library/tech/ika-sign-flow) - presign + message → 2PC-MPC signature
- [re-encrypt + transfer](/library/tech/ika-re-encrypt-transfer) - move dWallets between users

## chain signing flows

- [EVM transaction send](/library/tech/evm-send-flow) - sendEvmTx + approveTxRequest converge at signAndBroadcastEvm
- [EVM personal_sign + signTypedData_v4](/library/tech/evm-personal-sign-and-typeddata) - the preimage passthrough rule
- [Sui transaction signing via ika](/library/tech/sui-tx-sign-via-ika) - intent + BLAKE2b + ika ED25519
- [Sui personal-message SHA-512 vs BLAKE2b divergence](/library/tech/sui-personal-message-divergence) - the dapp-verify gap
- [Solana transaction signing](/library/tech/solana-tx-sign) - versioned tx + ika ED25519
- [Bitcoin segwit + taproot signing](/library/tech/btc-tx-sign-segwit-taproot) - SECP256K1_ECDSA + SECP256K1_TAPROOT pools
- [Aptos signing](/library/tech/aptos-sign) - ed25519 + signing-message tag
- [signature normalization](/library/tech/signature-normalization) - parseSignatureFromSignOutput + v-recovery

## dapp bridge

- [EIP-1193 + EIP-6963](/library/tech/eip-1193-and-6963) - EVM provider + multi-discovery
- [EIP-3085 + EIP-3326](/library/tech/eip-3085-3326) - chain add / switch
- [Wallet Standard (Sui + Solana)](/library/tech/wallet-standard-sui-and-solana) - non-EVM dapp discovery
- [bridge message validation](/library/tech/dapp-bridge-message-validation) - origin + event.source checks across the page / content-script / SW boundary

## networks + external services

- [price waterfall + sources](/library/tech/price-waterfall-and-sources) - CoinGecko / DefiLlama / CMC / Pyth / Chainlink / GeckoTerminal
- [NFT API providers](/library/tech/nft-api-providers) - Alchemy / Helius / Hiro / Mysten Display / Aptos indexer
- [Aftermath router (Sui swap)](/library/tech/aftermath-router) - REST `/router/trade/route` + `/router/trade/transaction`
- [SuiGraphQLClient](/library/tech/sui-graphql-client) - the Mysten GraphQL transport + the chunking patch
- [`@mysten/kiosk` `KioskClient`](/library/tech/mysten-kiosk-client) - kiosk reads
- [`eth-phishing-detect`](/library/tech/eth-phishing-detect) - the MetaMask phishing list integration
- [Chainlist search](/library/tech/chainlist-search) - import EVM chains from chainid.network/chains.json

## browser primitives

- [`chrome.runtime.connect` (tRPC port)](/library/tech/chrome-runtime-connect-trpc-port) - UI ↔ background bridge
- [`chrome.runtime.connectNative` (MCP)](/library/tech/chrome-runtime-connectnative) - extension ↔ native host
- [`chrome.storage` local + session](/library/tech/chrome-storage-local-and-session) - persistence model
- [`chrome.alarms` + `chrome.idle`](/library/tech/chrome-alarms-and-idle) - timers + screen-lock detection
- [`chrome.declarativeNetRequest`](/library/tech/chrome-declarativenetrequest) - phishing rules
- [WebHID (popup context)](/library/tech/webhid-popup-context) - Ledger transport constraints

## hardware wallets + MWA

- [MWA 2.0 spec + reflector protocol](/library/tech/mwa-2-spec-and-reflector) - the underlying spec
- [MWA local (Android intent)](/library/tech/mwa-local-android-intent) - same-device transport
- [MWA remote (QR pairing)](/library/tech/mwa-remote-qr-pairing) - desktop ↔ phone transport via reflector
- [Ledger hw-app libraries](/library/tech/ledger-hw-app-libs) - per-chain Ledger drivers
- [Trezor Connect iframe](/library/tech/trezor-connect-iframe) - hosted iframe at connect.trezor.io
- [WalletConnect v2](/library/tech/walletconnect-v2) - relay-based phone pairing (mostly for x402)

## x402 HTTP payments

- [x402 v2 SVM `exact` scheme](/library/tech/x402-spec-svm-exact) - the wire spec
- [fetch interception](/library/tech/x402-fetch-interception) - the page-side `window.fetch` wrapper
- [Solana tx build](/library/tech/x402-solana-tx-build) - versioned tx + ATA + Memo v2
- [caps + receipts](/library/tech/x402-caps-receipts) - daily USD caps + 200-receipt log

## MCP (Model Context Protocol)

- [MCP protocol overview](/library/tech/mcp-protocol-overview) - chromatika hand-rolls the spec, no `@modelcontextprotocol/sdk`
- [chrome native messaging frame](/library/tech/mcp-native-messaging-frame) - 4-byte LE length + UTF-8 JSON
- [HTTP MCP transport](/library/tech/mcp-http-transport) - `POST /mcp` on `127.0.0.1:<port>`
- [stdio bridge mode](/library/tech/mcp-stdio-bridge) - `--stdio-bridge` for Claude Desktop
- [tool routing + correlation](/library/tech/mcp-tool-routing) - 5-min timeout, tool-call ↔ tool-result envelopes
- [bearer token auth](/library/tech/mcp-bearer-token-auth) - per-install token + rotation
- [reconfigure-port live rebind](/library/tech/mcp-reconfigure-port) - stable Claude Desktop config across chrome restarts
- [host spawn + per-OS setup](/library/tech/mcp-host-spawn-and-setup) - `pnpm setup:native-host`
- [`listActiveAlerts` read-tier tool](/library/tech/mcp-list-active-alerts-tool) - exposes safety alerts to AI agents

## safety alerts subsystem

- [overview](/library/tech/alerts-overview) - signed feed + ed25519 verify + 3 surfaces (banner / notification / dNR)
- [signed-feed format + verify pipeline](/library/tech/alerts-signed-feed-format) - `SignedAlertV1` + canonical JSON + ed25519 verify
- [`publish-alert.mjs` CLI](/library/tech/alerts-publish-cli) - keygen, sign, build feed, sample
- [poller + actions](/library/tech/alerts-poller-and-actions) - 5-min alarm + chrome notifications + dNR rule lifecycle
- [publisher allowlist](/library/tech/alerts-publisher-allowlist) - bundled `BUNDLED_PUBLISHERS` + revision bumps

## encrypted activity notes + tx-record + encryption module

- [signed-tx record + activity feed merge](/library/tech/signed-tx-record) - `chromatika_signed_txs_v1` per-vault FIFO 500
- [`EncryptionBackend` abstraction](/library/tech/encryption-backend-abstraction) - multi-backend interface (encrypt-xyz / direct-ed25519 stub / seal stub)
- [activity-notes encrypt + decrypt flows](/library/tech/activity-notes-encrypt-decrypt) - K-wrap via 2× EUint128 + AES-GCM body, 4 tRPC procedures

## Encrypt.xyz integration

- [pre-alpha overview](/library/tech/encrypt-pre-alpha-overview) - what we use, the disclaimer
- [17-byte canonical format](/library/tech/encrypt-17-byte-canonical-format) - `[fhe_type(1) || value_le(16)]` (the published-SDK-bug workaround)
- [gRPC-web fetch transport](/library/tech/encrypt-grpc-web-fetch-transport) - HTTP/1.1 wrapping of gRPC
- [protobuf wire codec](/library/tech/encrypt-protobuf-wire) - hand-rolled with `@bufbuild/protobuf` BinaryWriter
- [CreateInput flow](/library/tech/encrypt-create-input) - the encrypt path
- [ReadCiphertext (signed)](/library/tech/encrypt-read-ciphertext-signed) - the reveal path with ed25519 sig
- [multi-chunk labels](/library/tech/encrypt-multi-chunk-labels) - 1-64 utf-8 → 1-4 EUint128 chunks
- [on-chain status polling](/library/tech/encrypt-on-chain-status-polling) - the 4s `verified` / `encrypting` / `missing` pill

## activity scan service

- [scan service architecture](/library/tech/scan-service-architecture) - module layout, candidate generation, per-chain probes, dwallet cap matching
- [SS58 + cosmos bech32 address derivation](/library/tech/ss58-cosmos-bech32-address-derivation) - polkadot / cosmos / DeSo address shapes for scan probes

## on-chain policy

- [policy vault (Sui Move + Solana Anchor)](/library/tech/policy-vault) - on-chain spend caps, panic, rescue, multi-actuator design

## test infrastructure

- [e2e test patterns](/library/tech/e2e-test-patterns) - SW fetch mock, Lazor mock harness, synthetic dwallet inventory, dev harness flags

## other tech + internals

- [buffer polyfill](/library/tech/buffer-polyfill) - Node Buffer shim for browser
- [bitcoinjs-lib usage](/library/tech/bitcoinjs-lib-usage) - tx building + sighash + addresses
- [`@noble/*` + `@scure/*` crypto libs](/library/tech/noble-and-scure-crypto-libs) - the audit-grade primitive set
- [WebAuthn PRF / hmac-secret](/library/tech/webauthn-prf-hmac-secret) - the deterministic 32-byte secret extension
- [WAAP determinism probe](/library/tech/waap-determinism-probe) - sign-twice-and-compare at pairing
- [session state + multi-vault](/library/tech/session-state-multi-vault) - what's unlocked + how switchVault works
