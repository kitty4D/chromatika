# all encrypt + ika features (and adjacent tech) in chromatika

a cross-cutting map of which chromatika features touch the **encrypt.xyz** pre-alpha integration, the **ika** 2PC-MPC threshold wallet protocol, both, or neither - plus the supporting "other tech" (MCP agent surface, x402 HTTP payments, dapp bridge, hardware wallets, etc.) that compose with each.

terms used in this doc:
- **encrypt** = `@encrypt.xyz/pre-alpha-solana-client` integration. on-chain FHE primitives via gRPC `CreateInput` (write) + signed `ReadCiphertext` (read). Solana ika base only. lab-grade pre-alpha; ciphertexts may be plaintext on-chain in this phase
- **ika** = the 2PC threshold MPC wallet protocol. user holds one share, ika network holds the other. neither alone can produce a signature. underlies all dapp / signing / sending operations
- **other tech** = anything else: MCP, x402, dapp bridge (EIP-1193 / Wallet Standard), hardware wallets (Ledger / MWA / WalletConnect), safety alerts, AES-GCM web crypto, persistence layers (tx-record, signed-tx records), per-chain libraries (ethers / bitcoinjs / @solana/web3.js / @mysten/sui / @aptos-labs/ts-sdk), etc.

---

## section 1 - features using both encrypt + ika (detailed, biggest first)

### 1. encrypted activity notes

newest of the encrypt+ika features and the most fully-realized "user attaches private data to wallet operations" surface in chromatika. per-tx encrypted user notes attached to entries in the activity feed.

- **plaintext cap**: 2048 utf-8 bytes per note
- **scoping**: per-vault (encrypted to the active vault's dWallet ed25519 pubkey; switching vaults = `wrong-vault` decrypt error). per-tx-hash (one note per tx hash per vault; re-saving replaces)
- **only on Solana ika base** (the encrypt.xyz integration asserts Solana base; throws on Sui)

**encrypt role**:
- generate fresh 32-byte AES-256 key K + 12-byte AES-GCM IV per encrypt
- AES-GCM encrypt the plaintext under K
- split K into two 16-byte halves
- wrap each half via encrypt.xyz `CreateInput` as `EUint128` (one batched gRPC round-trip; FHE_TYPE_EUINT128 = 5; 17-byte canonical format `[fhe_type(1) || value_le(16)]`)
- persist the resulting `EncryptedRef` (two ciphertext-identifier hexes + body ciphertext + IV + recipient pubkey) on the local `SignedTxRecord`

**ika role**:
- on **decrypt**, ika MPC ED25519 signs each `ReadCiphertext` request (×2 - one per K half)
- the signed reads consume two ED25519_EDDSA presigns
- 1-3s decrypt latency dominated by these two MPC signs

**tRPC procedures**: `encryptActivityNote`, `decryptActivityNote`, `removeActivityNote`, `getActivityNoteStatus`

**deep-dive docs**:
- [activity-notes.md](../wallet-userguides/activity-notes.md) (user-guide)
- [activity-notes-encrypt-decrypt.md](../wallet-techguides/activity-notes-encrypt-decrypt.md)
- [encryption-backend-abstraction.md](../wallet-techguides/encryption-backend-abstraction.md)
- [signed-tx-record.md](../wallet-techguides/signed-tx-record.md)

### 2. encrypted dWallet labels

per-dWallet on-chain encrypted label (1-64 utf-8 bytes). visible on every dWallet card when the active vault is on Solana ika base. older than activity notes but more visually prominent (every dWallet in the list shows the label state).

- **plaintext cap**: 64 utf-8 bytes (4 × EUint128 chunks of 16 bytes each)
- **scoping**: per-dWallet, per-curve (separate labels for SECP256K1 and ED25519 on the same vault)
- **on-chain status pill**: 4-second polling via Solana RPC. states: `verified` ✓ / `encrypting` / `missing` (devnet wipe)
- **only on Solana ika base** (procedures throw on Sui-base via `assertEncryptSolanaIkaBase`)

**encrypt role**:
- encode label utf-8 bytes into 1-4 chunks of 16 bytes (zero-padded)
- wrap each chunk via `mockEncryptScalarBytesFromBytes(chunk, FHE_TYPE_EUINT128)` (the hand-rolled 17-byte format - the published `@encrypt.xyz/pre-alpha-solana-client@0.1.0` `encryptValue` ships pre-fix 16-byte; chromatika fixes locally per upstream commit `303439d`)
- batched `CreateInput` gRPC call (1-4 inputs in one round-trip)
- persist the chunk identifiers + utf8Len on the per-vault `dwalletMeta` overlay

**ika role**:
- on **reveal**, ika MPC ED25519 signs each `ReadCiphertext` request (1-4 signs depending on chunk count)
- each signed read consumes one ED25519_EDDSA presign
- reassemble chunk plaintexts, trim to utf8Len, UTF-8 decode

**tRPC procedures**: `encryptDwalletLabel`, `revealDwalletLabel`, `clearDwalletLabel`, `getDwalletLabelStatus`, `getDwalletLabelOnChainStatus`

**deep-dive docs**:
- [encrypted-dwallet-labels.md](../wallet-userguides/encrypted-dwallet-labels.md) (user-guide)
- [encrypt-multi-chunk-labels.md](../wallet-techguides/encrypt-multi-chunk-labels.md)
- [encrypt-create-input.md](../wallet-techguides/encrypt-create-input.md)
- [encrypt-read-ciphertext-signed.md](../wallet-techguides/encrypt-read-ciphertext-signed.md)
- [encrypt-on-chain-status-polling.md](../wallet-techguides/encrypt-on-chain-status-polling.md)

### 3. encryption lab signed reads

dev / lab surface (`encryptLabReadCiphertext`) for SDK exploration. read a stored ciphertext by identifier, with optional epoch. uses ika MPC for the signed-message envelope.

- **scope**: lab-grade dev demo. exposed via tRPC for hackathon / SDK exploration
- **only on Solana ika base** (asserts the same way as labels + notes)

**encrypt role**:
- encode `ReadCiphertextMessage` BCS-style (chain=0, ciphertext id, empty rekey, epoch=0n)
- send `ReadCiphertext` gRPC request with the signed message
- decode response: 16-byte plaintext value + fheType + opaque digest

**ika role**:
- ika MPC ED25519 signs the BCS message via `signMessageSol` before the gRPC request
- the signed read consumes one ED25519_EDDSA presign

**tRPC procedure**: `encryptLabReadCiphertext`

**deep-dive docs**:
- [encryption-lab.md](../wallet-userguides/encryption-lab.md) (user-guide)
- [encrypt-read-ciphertext-signed.md](../wallet-techguides/encrypt-read-ciphertext-signed.md)
- [encrypt-protobuf-wire.md](../wallet-techguides/encrypt-protobuf-wire.md)

---

## section 2 - other tech + encrypt (bullets)

features where the encrypt integration composes with at least one piece of "other tech" beyond ika. ika+other-tech variants listed first; pure encrypt+other-tech (no ika) below.

**with ika + other tech:**
- **encrypted activity notes ↔ tx-record service** - the `chromatika_signed_txs_v1` per-vault FIFO 500 store. encrypted notes attach to a `SignedTxRecord` keyed by tx hash. activity feed merge joins explorer rows with these records to render the lock badge + origin
- **encrypted activity notes ↔ EncryptionBackend abstraction** - the multi-backend interface in `src/background/encryption/`. encrypt.xyz is today's only wired backend; `direct-ed25519` (X25519 ECDH for cross-recipient) and `seal` (Sui Move policy) are stubs that throw `not-implemented`. an `EncryptedRef` carries a backend tag so decrypt routes correctly across mixed stores
- **encrypted activity notes ↔ AES-GCM (Web Crypto)** - the per-note body cipher uses `crypto.subtle` AES-GCM 256 with a fresh K + 12-byte IV. the K is what gets wrapped via encrypt.xyz; the body never touches encrypt.xyz directly
- **encrypted dWallet labels ↔ Solana RPC + 4s on-chain status polling** - reads each chunk's on-chain account state byte (offset 99 = status, offset 98 = fheType echo). aggregates per-chunk states into `verified` / `encrypting` / `missing`
- **all encrypt + ika features ↔ gRPC-web fetch transport + protobuf wire codec** - `@protobuf-ts/grpcweb-transport` + hand-rolled `@bufbuild/protobuf` `BinaryWriter` / `BinaryReader` (no `.proto` files, no codegen step)
- **all encrypt + ika features ↔ in-extension Solana fee-payer keypair** - signs encrypt.xyz `approve_message` for `CreateInput` writes. same keypair shared with ika gRPC `approve_message` fees on Solana base

**encrypt + other tech, no ika:**
- *(none today)*. every encrypt operation that **reads** ciphertexts requires ika MPC ED25519 sign for `ReadCiphertext`. the only encrypt operations that don't touch ika are pure write paths (see section 3) and unwired stubs

---

## section 3 - encrypt-only features (detailed)

operations that touch encrypt.xyz but do not use ika MPC at all. all are dev surfaces or stubs today.

### encryption lab `CreateInput` write path

dev-only `encryptLabCreateInput` and `encryptLabCreateInputBatch` tRPC procedures. write a single u64 (or up to 16 batched) to encrypt.xyz as `EUint64` ciphertext.

- **encrypt role**:
  - `mockEncryptScalarBytes(value, FHE_TYPE_EUINT64)` packs the value into the 17-byte canonical format
  - batched `CreateInput` gRPC call (1-16 inputs)
  - returns ciphertext-identifier hexes
- **why no ika here**: `CreateInput` doesn't require ika MPC - the executor authorizes via the `approve_message` field signed by the **in-extension Solana fee-payer keypair** (a regular ed25519 sign with a locally-held key, not distributed MPC). reads are different - those require ika MPC sign of the BCS message
- **tRPC procedures**: `encryptLabCreateInput`, `encryptLabCreateInputBatch`

related: [encrypt-create-input.md](../wallet-techguides/encrypt-create-input.md), [encrypt-17-byte-canonical-format.md](../wallet-techguides/encrypt-17-byte-canonical-format.md)

### encrypt.xyz roadmap stubs (`not_wired`)

scaffolded tRPC surfaces for future encrypt.xyz product phases. all return `{ status: 'not_wired' }` today; no actual on-chain action.

- **`encryptSplEncDepositPath`** (`encrypt-spl-deposit-stub.ts`) - SPL token deposits into encrypt.xyz vaults. blocker: program ids + builders
- **`encryptPcTokenPhase3`** (`encrypt-pc-phase-stub.ts`) - PC-Token (private compute token) phase 3 reference. blocker: program alignment with encrypt.xyz team
- **`encryptPcSwapPhase4`** (`encrypt-pc-phase-stub.ts`) - PC-Swap phase 4 reference. blocker: same as above
- **`encryptLabDepositHint`** - read-only doc surface returning SPL Enc deposit implementation notes

these are pointers / placeholders, not features. mentioned for completeness.

---

## section 4 - other tech + ika (bullets)

features where ika composes with at least one piece of "other tech" beyond encrypt. these are where ika reaches outside the wallet's internal protocol layer to integrate with external surfaces.

- **MCP `signMessage`** - ika MPC ED25519 (Solana) or SECP256K1 (EVM) sign + MCP native messaging frame protocol + `chrome.runtime.connectNative` + bearer-token-auth HTTP MCP transport (`POST /mcp` on `127.0.0.1:<port>`). user approval popup gated; 5-minute timeout
- **MCP `sendEvmTx`** - ika MPC SECP256K1 sign + EIP-191 / EIP-1559 tx + active EVM provider broadcast + MCP. exists in both ika MPC path and (future tracked) abstract-wallet relayer path
- **MCP `signTransaction`** - ika MPC SECP256K1 sign + sign-only (no broadcast) for relayer / bundler / abstract-wallet flows. nonce reserved at sign time
- **x402 ika MPC payment path** - ika MPC ED25519 sign of a Solana versioned tx + USDC SPL transfer + Memo v2 nonce + x402 v2 spec (`exact` SVM scheme) + page-side fetch interception + per-counterparty / global daily USD caps + receipt log
- **dapp `eth_sendTransaction` approval** - ika MPC SECP256K1 sign + EIP-1191 / EIP-1559 tx build via ethers v6 + simulation via eth_call + gas presets (slow / normal / fast / custom) + EVM provider broadcast + dapp bridge `chrome.runtime.sendMessage` round-trip
- **dapp `personal_sign` / `eth_signTypedData_v4`** - ika MPC SECP256K1 sign + EIP-191 wrapping or `TypedDataEncoder.encode()` preimage + v-recovery (27 vs 28) + dapp bridge
- **dapp Sui `signTransaction` / `signAndExecuteTransaction`** - ika MPC ED25519 sign of `[0x00, 0x00, 0x00] || bcs(txData)` BLAKE2b-256 digest + Wallet Standard `@mysten/wallet-standard` features + Sui RPC broadcast
- **dapp Sui `signPersonalMessage`** - ika MPC ED25519 sign of raw message bytes via SHA-512 path (note: diverges from Mysten's BLAKE2b PersonalMessage intent; some dapps don't verify until parity ships)
- **dapp Solana `signTransaction` / `signAndSendTransaction` / `signMessage`** - ika MPC ED25519 sign + Wallet Standard `@solana/wallet-standard-features` + Solana RPC broadcast
- **dapp Aptos `signMessage` / sign tx** - ika MPC ED25519 sign + Aptos Wallet Standard + Aptos signing-message tag (`sha3_256("APTOS::RawTransaction")`)
- **dapp Bitcoin sign** - ika MPC SECP256K1 sign + bitcoinjs-lib BIP143 / BIP341 sighash + `window.bitcoin` provider + Esplora broadcast
- **dapp connect** (`eth_requestAccounts` / Wallet Standard `connect`) - ika dWallet selection (per-curve choice: secp256k1 + ed25519) + EIP-1193 / EIP-6963 / Wallet Standard discovery + phishing check (`eth-phishing-detect`) + safety alerts (potential `listActiveAlerts` consultation by AI agents before recommending)
- **hardware wallet pairing → ika seed** - Seeker (MWA local + remote) / WalletConnect signs `IKA_USK_DERIVATION_MESSAGE` ('ika.chromatika.user-share-encryption-key.v1') as a deterministic ed25519 sig. `keccak256(signature || u32_le(0))` becomes the 32-byte seed for `UserShareEncryptionKeys`. RFC 8032 determinism = same wallet on a new device produces the same seed = same dWallet
- **activity feed dWallet-ownership flag** - explorer rows (Sui GraphQL / Blockscout / Solana RPC / Esplora / Aptos indexer) merged with the local `chromatika_signed_txs_v1` store. `digest === txHash` join sets `signedByThisWallet: true` for txs the local ika dWallet signed. enables encrypted notes attachment + dapp origin display

---

## section 5 - ika-only features (detailed)

features whose dominant story is the ika protocol itself - distributed key generation, threshold signing, presign material, share lifecycle. some involve per-chain plumbing but the core is ika.

### dWallet DKG + accept-share zero-trust

distributed key generation per curve (`SECP256K1` for EVM/BTC, `ED25519` for Sui/Solana/Aptos). neither chromatika nor the ika network alone holds the full secret.

- `requestDWalletDKG` PTB (Sui base) or gRPC (Solana base, pre-alpha)
- output lands in `awaiting_key_holder_signature` state
- `completeDWalletZeroTrust` decrypts the encrypted user share locally, validates against the published public key (zero-trust check - reject if network gave us a bad share), then runs `acceptEncryptedUserShare` to claim ownership
- dWallet flips to `Active`

deep-dives: [create-dwallet.md](../wallet-userguides/create-dwallet.md), [ika-dkg-flow.md](../wallet-techguides/ika-dkg-flow.md), [ika-accept-share-zerotrust.md](../wallet-techguides/ika-accept-share-zerotrust.md)

### dWallet transfer + re-encryption

re-encrypting the user share to a new owner's encryption key. dWallet stays at the same address; "who can sign with it" changes. neither party ever sees the plaintext share.

- sender: `requestReEncryptUserShareFor` PTB
- recipient: `parseTransferTxDigest` (Sui-only today) → `acceptTransferredDWallet` → decrypt + validate + on-chain claim

uses ika's own re-encryption protocol (NOT encrypt.xyz). different cryptographic stack.

deep-dive: [transfer-dwallet.md](../wallet-userguides/transfer-dwallet.md), [ika-re-encrypt-transfer.md](../wallet-techguides/ika-re-encrypt-transfer.md)

### dWallet discovery

scan the active base chain for dWallets owned by the user's derived addresses. attaches existing dWallets after restoring on a new install.

- `discoverDWallets({ curve })` walks Sui via GraphQL `client.core.*` or Solana via pre-alpha gRPC
- some dWallets may return in `awaiting_key_holder_signature` - run `completeDWalletZeroTrust` for those

deep-dive: [manage-dwallets.md](../wallet-userguides/manage-dwallets.md)

### presign pool management

three pools per active dWallet Vault: `SECP256K1_ECDSA`, `SECP256K1_TAPROOT`, `ED25519_EDDSA`. presigns are precomputed signature material so on-line signing is fast.

- 5-minute auto-refill alarm (`chromatika-presign-refill`); low-water = 2, refill count = 3, skipped if locked
- per-vault scoped: `chromatika_presign_pools_v3_<vaultId>` in `chrome.storage.local`
- manual refill via `replenishPresign` (1-20 entries per call)
- each sign consumes one entry; reusing a presign reveals the secret key (security property)

deep-dive: [presign-pool.md](../wallet-userguides/presign-pool.md), [ika-presign-pool-impl.md](../wallet-techguides/ika-presign-pool-impl.md)

### ika seed derivation (per credential)

every dWallet's `UserShareEncryptionKeys` (USK) derives from a 32-byte root seed. the seed source differs per credential type:

- mnemonic (Sui): `keccak256([scheme_flag(1) || secret(32)] || u32_le(index))` over the SLIP10-derived `m/44'/784'/0'/0'/0'` ed25519 keypair
- mnemonic (Solana): `keccak256(secretKey64 || u32_le(index))` over the SLIP10-derived `m/44'/501'/0'/0'` solana keypair (canonical 64-byte secretKey)
- private-key import: same as mnemonic for the imported keypair (Sui bech32 or Solana 64-byte b64)
- passkey (Sui-only): `keccak256(prfSecret32 || u32_le(index))` over the WebAuthn PRF / hmac-secret output
- WAAP (Sui, deterministic path): `keccak256(signature64 || u32_le(index))` over the WAAP-signed `IKA_USK_DERIVATION_MESSAGE`
- WAAP (Sui, non-deterministic fallback) / Lazor: `keccak256(bip39_seed64 || u32_le(index))` from a recovery-words BIP39 phrase
- MWA / WalletConnect (Solana hardware): `keccak256(walletSig64 || u32_le(0))` from Seeker / WC signing the derivation message; fee-payer keypair derived at index 1 to avoid collision

11 documented paths total. all converge to the same `UserShareEncryptionKeys.fromRootSeedKey(seed_32, curve)` call that produces the per-curve USK material.

deep-dives: [ika-seed-derivation-overview.md](../wallet-techguides/ika-seed-derivation-overview.md) + 10 per-credential techguides

### ika base mode

global wallet preference: `chromatika_ika_base_mode_v1` = `'sui' | 'solana'`. drives which base chain new dWallets anchor to. `setIkaBaseMode` toggles; `getIkaBaseMode` reads. Solana base requires `VITE_SOLANA_IKA_BASE=true` build flag (pre-alpha).

vault-tier vs dWallet-tier active networks (Sui + Solana have both tiers): vault tier = HD fee-payer's chain environment; dWallet tier = the dWallet's operating network. usually the same; they can diverge briefly during testing.

### ika fee management (Solana base)

in-extension Solana fee-payer keypair pays ika gRPC `approve_message` fees (since Seed Vault hardware never reveals secret bytes). per-vault fee mode:
- `in_extension` (default): fee-payer keypair signs `approve_message` directly. fast, one signature per ika op
- `seeker_direct`: every gRPC call routes through the phone wallet for signing. slower but no in-extension keypair to manage

operations: `getIkaFeeSettings`, `setIkaFeeSettings`, `topUpIkaFeePayer` (Seeker hardware sign), `drainIkaFeePayerToSeeker`, `drainAbandonedFeePayer`, `activeIkaFeePayerBalance`.

note: this uses a **regular Solana ed25519 sign** with a locally-held key, not ika MPC. it's "ika-adjacent fee plumbing" rather than ika protocol itself.

deep-dive: [ika-fee-management.md](../wallet-userguides/ika-fee-management.md)

### ika staking

stake IKA tokens with an Ika network validator on Sui. validators on-chain via `coordinatorInner.validators`. user stake is held in `StakedIka` objects.

- `ikaStakingValidators` - list active validators
- `ikaStakingPositions` - list user's staked positions
- `ikaStake({ validatorId, amountBaseUnits })` - stake via PTB; requires SECP256K1 dWallet sign
- `ikaWithdrawStake({ stakedIkaObjectId })` - unstake + claim; requires sign

Sui base only. hardware vaults can't stake from the wallet UI today (dWallet-only flow).

deep-dive: [ika-staking.md](../wallet-userguides/ika-staking.md)

### per-chain sends

native sends via the active dWallet's per-chain address. each calls ika MPC for the actual signature; the rest is per-chain tx building.

- **EVM**: `sendEvmTx` (wallet-UI direct, no popup). builds tx via ethers v6, signs via ika SECP256K1 ECDSA, broadcasts on the active EVM provider. records to `chromatika_signed_txs_v1` on success
- **Sui**: `sendSuiNative` (HD fee-payer keypair, NOT ika MPC). this is the exception - Sui sends use the local fee-payer rather than the dWallet
- **Solana**: `sendSolanaNative` (ika MPC ED25519 of the v0 message)
- **Bitcoin**: `sendBtcNative` (P2WPKH via ika SECP256K1_ECDSA presign + bitcoinjs-lib BIP143 sighash)
- **Aptos**: `sendAptosNative` (ika MPC ED25519 + Aptos signing-message tag)

today only EVM sends record to the local tx-record store (enables encrypted-note attachment). Sui / Solana / BTC / Aptos send paths still need that hook (tracked future).

deep-dives: [send-evm.md](../wallet-userguides/send-evm.md), [send-sui.md](../wallet-userguides/send-sui.md), [send-solana.md](../wallet-userguides/send-solana.md), [send-bitcoin.md](../wallet-userguides/send-bitcoin.md), [evm-send-flow.md](../wallet-techguides/evm-send-flow.md), [solana-tx-sign.md](../wallet-techguides/solana-tx-sign.md), [btc-tx-sign-segwit-taproot.md](../wallet-techguides/btc-tx-sign-segwit-taproot.md), [aptos-sign.md](../wallet-techguides/aptos-sign.md)

### per-chain message signing (wallet UI direct)

`signEvm`, `signSui` (personal-message - ika SHA-512 path with the BLAKE2b parity gap), `signSol`, `signAptos`, `signBtc`. each wraps the message per the chain's convention (EIP-191, Sui intent, raw bytes, etc.) and hands the **preimage** to ika - never pre-hashed, since ika hashes once internally.

deep-dive: [sign-messages.md](../wallet-userguides/sign-messages.md), [evm-personal-sign-and-typeddata.md](../wallet-techguides/evm-personal-sign-and-typeddata.md), [sui-personal-message-divergence.md](../wallet-techguides/sui-personal-message-divergence.md)

---

## quick reference table

| feature | encrypt | ika | other tech |
|---------|:-------:|:---:|------------|
| encrypted activity notes | ✓ | ✓ | tx-record, EncryptionBackend, AES-GCM, activity feed |
| encrypted dWallet labels | ✓ | ✓ | Solana RPC status polling |
| encryption lab signed reads | ✓ | ✓ | gRPC-web, protobuf wire |
| encryption lab CreateInput writes | ✓ | | gRPC-web, in-ext fee-payer |
| encrypt.xyz roadmap stubs | (planned) | | (none, returns not_wired) |
| MCP `signMessage` | | ✓ | MCP, native messaging |
| MCP `sendEvmTx` | | ✓ | MCP, EVM broadcast |
| MCP `signTransaction` | | ✓ | MCP, sign-only |
| x402 ika MPC payment path | | ✓ | x402, USDC SPL, fetch interception |
| x402 WalletConnect path | | | x402, WalletConnect |
| dapp `eth_sendTransaction` | | ✓ | EIP-1193, gas presets, simulation |
| dapp message signing (any chain) | | ✓ | EIP-191/712, Wallet Standard |
| dapp connect | | ✓ | dapp bridge, phishing, alerts |
| hardware → ika seed | | ✓ | Seeker / WC / passkey / WAAP |
| activity feed (ownership flag) | | ✓ | tx-record, explorer APIs |
| dWallet DKG + accept-share | | ✓ | Sui PTB / Solana gRPC |
| dWallet transfer + re-encrypt | | ✓ | (ika's own re-encryption, NOT encrypt.xyz) |
| presign pool | | ✓ | per-vault storage |
| ika seed derivation | | ✓ | (depends on credential) |
| ika base mode | | ✓ | flag-gated (Solana) |
| ika fee management | | (adjacent) | in-ext fee-payer keypair |
| ika staking | | ✓ | Sui PTB |
| per-chain sends | | ✓ | per-chain libraries |
| per-chain message signing | | ✓ | per-chain libraries |
| MCP `listActiveAlerts` | | | MCP, alerts subsystem |
| MCP `listVaults` / `getActiveVault` | | | MCP, vault state |
| safety alerts | | | ed25519 verify, dNR, alarms |
| Sui-IKA swap (Phase B) | | | Aftermath REST, HD fee-payer |
| networks / NFTs / kiosks | | | per-chain SDKs |
| vault encryption (any unlock) | | | argon2id, AES-GCM, multi-envelope |

(adjacent = uses related plumbing but not ika MPC distributed signing)
