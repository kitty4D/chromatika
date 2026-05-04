# chromatika

multi-chain browser extension wallet built around **ika dWallet MPC**. one wallet, every chain we support (EVM, Bitcoin, Solana, Sui, Aptos), with no single hot key holding the bag. user-facing chain addresses are derived from a 2PC-MPC dWallet, not a stand-alone HD account, on every chain we ship.

repo home for the actual extension: [`wallet-extension/`](wallet-extension/). install + dev + test commands live in [`wallet-extension/README.md`](wallet-extension/README.md). agent-oriented reference skills live under [`skills/`](skills/) (not shipped in the extension).

---

## disclaimers (read this first)

chromatika is **pre-release**. the project is being built in the open. nothing in this repo has shipped to end users yet, and a bunch of subsystems are dev-mode only. before you load anything real:

- **as is, no warranty.** chromatika is provided as is, without warranty of any kind, express or implied. no warranty of merchantability, fitness for a particular purpose, non-infringement, security, accuracy, or that the wallet will be available, correct, or free of bugs. see [`LICENSE`](LICENSE) sections 5 and 8.

- **no liability.** the licensor and contributors are not liable for any losses, damages, missed transactions, lost or stolen funds, leaked keys, exploited bugs, smart-contract failures, oracle failures, network outages, phishing, or any other consequence of using or being unable to use chromatika. **you assume 100% of the risk.** see [`LICENSE`](LICENSE) section 6.

- **not financial advice.** nothing in this repo, the extension UI, or its docs is investment, legal, tax, accounting, or financial advice. do your own research and your own due diligence.

- **don't use real funds yet.** extension storage and crypto are dev-grade until v1. seed phrase / passkey / hardware-device security is still your job; chromatika cannot recover them for you.

- **solana ika base path is pre-alpha.** when you flip a vault to solana base, signatures are produced by a **single mock signer**, not a distributed MPC network. ika dWallet keys, trust model, and signing protocol are not final on solana, the on-chain program + data will be wiped periodically, and everything will be deleted at the ika alpha 1 transition. **do not submit real-value transactions on this stack.**

- **license summary.** chromatika is licensed under a source-available license modeled on the Business Source License 1.1. read it, learn from it, reuse code (small fragments or whole chunks) in any project that isn't itself an end-user cryptocurrency wallet - custody services, signing services, key-management services, MPC infra, dapps, libraries, agents, dev tools, research code etc. are all fine. the only thing blocked is shipping a wallet built on this codebase. on **2030-05-03** the codebase auto-converts to Apache License 2.0. full text: [`LICENSE`](LICENSE).

---

## vault setup methods (and how dWallet addresses + fee payers + ika info are derived)

chromatika is a **multi-vault** wallet. the encrypted blob (`chromatika_vault_v3`) holds a list of `VaultRecord`s plus an `activeVaultId`. each vault picks an **ika base chain** at creation: `BaseChain = 'sui' | 'solana'`. sui base is the production ika path. solana base is dev-mode mock signing.

shared vocabulary lives in [`wallet-extension/docs/TERMINOLOGY.md`](wallet-extension/docs/TERMINOLOGY.md). target multi-vault UX in [`wallet-extension/docs/DWALLET_VAULT_MODEL.md`](wallet-extension/docs/DWALLET_VAULT_MODEL.md).

for **every** method below we document four things, in the same order:

- **how the vault gets created** (entry point + persisted record fields, by `VaultRecord` variant).
- **the dWallet vault address** (the on-chain address the user sees + signs for).
- **the fee payer** (whether it's the same as the vault address or separate, and why).
- **how ika info gets derived** (`UserShareEncryptionKeys` root seed formula, dWallet DKG, presign pools).

vault records live at [`wallet-extension/src/background/vault-types.ts`](wallet-extension/src/background/vault-types.ts). seed derivation functions live at [`wallet-extension/src/background/keyring/hd.ts`](wallet-extension/src/background/keyring/hd.ts). vault lifecycle (create / import / add / switch / remove) lives at [`wallet-extension/src/background/wallet-service.ts`](wallet-extension/src/background/wallet-service.ts). ika base chain dispatch (sui vs solana) lives at [`wallet-extension/src/background/ika/ika-adapter.ts`](wallet-extension/src/background/ika/ika-adapter.ts).

### a. HD mnemonic - create (sui base)

- **how it's created.** `wallet-service.ts` `createVault({ password, network })` generates a fresh BIP39 phrase via `newMnemonic()` (in the background service worker, never in React), persists an `HdVaultRecord { mnemonic, accountIndex: 0, baseChain: 'sui', network }`, and runs DKG so `ikaShareKeysB64` (SECP256K1 + ED25519) and `dwalletMeta` get populated.
- **dWallet vault address.** post-DKG, the canonical sui address comes from the active dWallet keypair (driven by ika MPC). pre-DKG, the address shown is the sui Ed25519 keypair derived from the mnemonic at `m/44'/784'/0'/0'/{accountIndex}'` via `Ed25519Keypair.deriveKeypair` (slush / sui wallet compatible). once DKG completes, every chain's user-facing address comes from the dWallet, including sui itself.
- **fee payer.** same sui Ed25519 keypair as above. it pays gas for ika protocol calls (DKG, presign, sign, re-encrypt) and signs PTBs. internal-only; users see the dWallet address.
- **ika info.** `UserShareEncryptionKeys` root seed = `keccak256(sui_keypair.to_bytes() || index_le)`, matching ika CLI's `resolve_seed`. function: `ikaRootSeedFromFeeKeypair(feeKeypair, encryptionKeyIndex)`. running `ika dwallet register-encryption-key` from the same mnemonic + active address derives the identical encryption key, so cli + extension stay in sync. presign pool storage key is per-vault: `chromatika_presign_pools_v3_<vaultId>` with three pools (`SECP256K1_ECDSA`, `SECP256K1_TAPROOT`, `ED25519_EDDSA`), refilled every 5 min by a `chrome.alarms` job.

### b. HD mnemonic - create (solana base, pre-alpha)

- **how it's created.** same as (a) but with `baseChain: 'solana'`. derives a solana keypair at `m/44'/501'/{accountIndex}'/0'` via SLIP10 (Phantom / Solflare compatible).
- **dWallet vault address.** post-DKG, the dWallet's solana base58 pubkey. pre-DKG, the derived solana keypair's pubkey.
- **fee payer.** the derived solana keypair itself. it pays the ika `approve_message` gRPC fee on devnet. fund it with ~0.1 devnet SOL after vault creation.
- **ika info.** root seed = `keccak256(solana_keypair.secretKey || index_le)` over the canonical 64-byte `Keypair.secretKey` shape. function: `ikaRootSeedFromSolanaKeypair(solanaKeypair, encryptionKeyIndex)`. ED25519 sign on solana base never pools (RFC 8032 deterministic + pre-alpha gRPC restriction), so a fresh `Presign` runs per Sign call. SECP256K1 still pools.

### c. HD mnemonic - import

- **how it's created.** `importVault({ password, mnemonic, network, baseChain })` from the import-step UI. derivation is identical to create (a / b), so the same words on a different machine recover the same vault and the same dWallet (ika seed is deterministic from the mnemonic path).
- **dWallet vault address / fee payer / ika info.** identical to (a / b) depending on `baseChain`.

### d. imported private key

- **how it's created.** `ImportedKeyVaultRecord` with either `suiPrivateKeyBech32` (sui base, Mysten `suiprivkey...` Bech32) **or** `solanaSecretKeyB64` (solana base, base64 of the canonical 64-byte secret key). entry point: import-key step.
- **dWallet vault address.** post-DKG dWallet address; pre-DKG the imported keypair's chain address.
- **fee payer.** the imported keypair. for solana base, fund it with ~0.1 devnet SOL same as (b).
- **ika info.** identical formulas to (a / b), just sourced from the imported keypair instead of an HD-derived one. `ikaRootSeedFromFeeKeypair` for sui-bech32 imports, `ikaRootSeedFromSolanaKeypair` for solana-b64 imports.

### e. passkey (sui base)

- **how it's created.** `createPasskeyVault({ password, network })` registers a WebAuthn credential with `extensions: { prf: { eval: { first: chromatikaPrfSalt } } }`, persists `PasskeyVaultRecord { passkeyCredentialId, passkeyPublicKeyB64 (33-byte compressed secp256r1), passkeyRpId, passkeyPrfSaltB64 (chromatika constant), passkeyEncryptionIndex, seedSource: 'passkey-prf' | 'recovery-words' }`. `recoveryWordsEncryptedB64` is opt-in. baseChain forced to `'sui'`.
- **dWallet vault address.** the sui passkey-scheme address: `blake2b_256(0x06 || pk_compressed)` -> 32-byte sui address (function `suiAddressFromPasskeyPublicKey`). it survives reinstall + platform passkey sync because the credential lives on the authenticator. cross-chain (EVM / BTC / solana / aptos) addresses come from the ika dWallet after DKG.
- **fee payer.** the passkey itself signs PTBs via WebAuthn user-verification. no separate hot keypair stored, no key material in extension storage.
- **ika info.** `UserShareEncryptionKeys` root seed = `keccak256(prfOutput || index_le)`, where `prfOutput` is the 32-byte WebAuthn PRF hmac-secret output fetched fresh on every unlock (not persisted). chromatika's PRF salt is a constant (`keccak256("chromatika.passkey.prf-salt.v1")`) so the same passkey on a synced device or a reinstalled extension re-derives the identical seed and the same dWallet caps get auto-discovered. function: `ikaRootSeedFromPasskeyPRF(prfOutput, encryptionKeyIndex)`. opt-in 24-word fallback uses `ikaRootSeedFromRecoveryWords`.

### f. WaaP (sui base, embedded social login)

- **how it's created.** `createWaapVault` opens the `@human.tech/waap-sdk` modal, the user authenticates via email / phone / social (google / discord / twitter / github / bluesky), and WaaP returns a sui Ed25519 public key + address. record: `WaapVaultRecord { waapSuiAddress, waapSuiPublicKeyB64, waapAuthMethod, ikaEncryptionIndex, seedSource: 'waap-signature' | 'recovery-words', waapPairingSignatureB64? (encrypted), recoveryWordsEncryptedB64? (encrypted) }`. baseChain forced to `'sui'`.
- **dWallet vault address.** `waapSuiAddress` (the sui address WaaP owns the keypair for). cross-chain addresses come from the ika dWallet.
- **fee payer.** the WaaP-managed sui keypair (off-device, signed via WaaP's API on every PTB). no hot key in extension storage.
- **ika info.** if WaaP signatures over `IKA_USK_DERIVATION_MESSAGE` are deterministic (verified at pairing), seed = `keccak256(waap_signature || index_le)` and `waapPairingSignatureB64` is persisted (encrypted under the vault key) so subsequent unlocks can re-derive without re-prompting WaaP. otherwise `seedSource` falls back to `'recovery-words'` and the user writes down a 24-word phrase.

### g. Lazor (solana base, smart-wallet passkey portal)

- **how it's created.** `createLazorVault` opens Lazor's hosted portal at `portal.lazor.sh`, the user authenticates with a passkey bound to lazor.sh's rpId, and Lazor's anchor program returns a smart-wallet PDA. record: `LazorVaultRecord { lazorSmartWalletPubkeyB58, lazorCredentialIdB64, lazorPasskeyPubkeyB64, lazorWalletDevicePubkeyB58, lazorPortalUrl, lazorProgramId, lazorNetwork, ikaEncryptionIndex, seedSource: 'lazor-signature' | 'recovery-words', lazorPairingSignatureB64? (encrypted), recoveryWordsEncryptedB64? (encrypted), lazorIkaFeePayerSolSecretKeyB64 (encrypted, REQUIRED) }`. baseChain forced to `'solana'`.
- **dWallet vault address.** `lazorSmartWalletPubkeyB58` (the user-facing solana smart-wallet PDA, resolved at pairing via `LazorkitClient.getSmartWalletByCredentialHash().smartWallet.toBase58()`). this is where the user's SOL / SPL live; signing happens on lazor.sh via passkey. cross-chain addresses come from the ika dWallet.
- **fee payer.** a **separate** solana keypair (`lazorIkaFeePayerSolSecretKeyB64`), derived from the recovery phrase via SLIP10 at `m/44'/501'/0'/0'`. why separate: lazor's smart-wallet PDA cannot itself sign arbitrary transfers (passkey-gated, portal-mediated), but the ika `approve_message` gRPC fee path needs a regular ed25519 keypair we can sign with locally. fund this fee-payer address with ~0.01 devnet SOL after vault creation.
- **ika info.** `'lazor-signature'` (preferred): seed = `keccak256(lazor_passkey_signature || index_le)`. RFC 6979 deterministic ECDSA via Lazor portal on supported authenticators (apple platform, most hardware tokens), so the same passkey on a different device re-derives the same seed via "log into existing" at portal.lazor.sh. `'recovery-words'` (universal fallback): seed = `keccak256(bip39Seed || index_le)` and the same phrase regenerates the fee payer, so a chromatika reinstall + same phrase reuses the funded fee account.

### h. hardware - Ledger (sui base today, solana planned)

- **how it's created.** `onAddLedgerHardwareVault` runs the Ledger sui app account-discovery flow over WebHID (popup / side panel only, never the SW: WebHID needs a user gesture). record: `HardwareVaultRecord { hardwareAccountId (Ledger sui address), ikaEncryptionIndex, ledgerFeePayerEd25519PublicKeyB64? (pubkey only, no secret), suiPrivateKeyBech32? (legacy fallback - tech debt) }`. **both ika curves' `ikaShareKeysB64` must be pre-populated at vault creation** because Ledger has no on-device path to derive ika user-share encryption keys; the extension can't generate them after the fact. bootstrap mode disables Ledger as the first vault: add an HD vault first, then add Ledger from settings.
- **dWallet vault address.** the Ledger-derived sui address (pinned via `hardwareAccountId`). signing flows through `enqueueHardwareSign` -> `index.html?hwsign=ID` popup; WebHID transport opens inside the popup's user-gesture context. dWallet cross-chain addresses come from ika after DKG.
- **fee payer.** the Ledger sui app, signing PTBs on-device. pubkey-only on chain; no hot key in extension storage. legacy `suiPrivateKeyBech32` fallback exists for old dev installs and is documented technical debt - the goal is Ledger-only signing with no extension-resident hardware-associated secret.
- **ika info.** no fresh derivation. both curves' share keys are populated at vault creation (`buildIkaShareKeys(null, stored)`). presign pools work the same way as HD vaults once the ika share keys are in place.

### i. hardware - Trezor (solana base only)

- **how it's created.** `pairTrezorSolanaForHardwareVault` runs Trezor connect's solana account discovery + tx signing flow. record: same `HardwareVaultRecord` shape, Trezor flavor. Trezor connect has no sui app, so Trezor is solana-base only on chromatika. shipped chains the device can sign for: solana, EVM, BTC PSBT (BIP84 P2WPKH; PSBT decomposed by `btc-trezor-decompose.ts`).
- **dWallet vault address.** the Trezor-derived solana address (`hardwareAccountId`). cross-chain addresses come from the ika dWallet.
- **fee payer.** the Trezor-managed solana keypair (signs on device). no hot key in extension storage.
- **ika info.** if Trezor's solana sign-message endpoint is asked to sign `IKA_USK_DERIVATION_MESSAGE`, seed = `keccak256(signature || index_le)` via `ikaRootSeedFromMwaSignature` (same wallet-signature derivation as MWA / Seeker, since they all rely on RFC 8032 deterministic Ed25519).

### j. mobile wallet adapter - local (Android Chromium)

- **how it's created.** the user is on an Android phone with chromatika loaded in Chromium / Kiwi browser **and** an MWA-compliant wallet app (Phantom Android, Solflare Android, Jupiter, Seeker bundled, etc.). at pair time, `transact()` fires an Android intent (`solana-wallet://`) to the wallet app on the same device. record: `HardwareVaultRecord { mwaTransport: 'local', hardwareAccountId, ikaGrpcFeePayerSolSecretKeyB64 (encrypted) }`. UA gating: only shown on Android.
- **dWallet vault address.** the phone wallet's authorized solana address. cross-chain via ika dWallet.
- **fee payer.** a deterministic in-extension keypair derived from the wallet's signature over `IKA_USK_DERIVATION_MESSAGE` at index 1, via `solanaFeeKeypairFromWalletSignature(signature, IKA_FEE_PAYER_DERIVATION_INDEX = 1)`. **never index 0** (that's the ika seed slot; reusing it would key-collide). same Seeker / same Android wallet on any device produces the same fee-payer address, so SOL persists across reinstalls. fund with ~0.1 devnet SOL after pairing.
- **ika info.** seed = `keccak256(wallet_signature_over_IKA_USK_DERIVATION_MESSAGE || index_le)`, deterministic per RFC 8032. function: `ikaRootSeedFromMwaSignature(signature, encryptionKeyIndex)`. recovery is "same phone wallet on any device" - no HD seed phrase needed.

### k. mobile wallet adapter - remote (desktop ↔ Seeker / phone, QR pair)

- **how it's created.** desktop chromatika opens `wss://${mwaReflectorHost}/reflect` from the side panel / popup (not the SW: the lib uses `window.btoa`/`atob`), renders the association URL as a QR via `SeekerConnect.tsx`, and the user scans + approves on a Solana Seeker / Solana Mobile phone. record: `HardwareVaultRecord { mwaTransport: 'remote', hardwareAccountId, mwaAuthToken, mwaReflectorHost, mwaPairedAtEpochMs, ikaGrpcFeePayerSolSecretKeyB64 (encrypted) }`. UA gating: only shown on non-Android. **disabled by default in production builds** (the public reflector demo at `development.reflector.solanamobile.com` is currently unreliable; flip `VITE_ENABLE_MWA_REMOTE=true` to surface this option). a self-hosted Cloudflare Workers reflector lives in [`reflector/`](reflector/) as a fallback; runbook in [`wallet-extension/docs/SEEKER_REMOTE_PAIRING.md`](wallet-extension/docs/SEEKER_REMOTE_PAIRING.md).
- **dWallet vault address.** the phone wallet's authorized solana address (same as case j).
- **fee payer.** identical to case j: deterministic in-ext keypair via `solanaFeeKeypairFromWalletSignature(signature, 1)`. same Seeker on any device produces the same fee-payer address. fund with ~0.1 devnet SOL after pairing.
- **ika info.** identical to case j (`ikaRootSeedFromMwaSignature`). because Ed25519 is RFC 8032 deterministic, restoring on a new desktop = sign the same message = same seed = same dWallet. no HD seed phrase needed. `mwaAuthToken` skips QR rescan on subsequent signs.

### l. WalletConnect (solana base, relay session) - canonical desktop hardware path

WalletConnect is now the **canonical solana hardware path on desktop** in chromatika, since Solana Mobile's MWA reflector is currently unreliable. requires `VITE_WC_PROJECT_ID` set at build time (register a project at `cloud.reown.com`); without it, the WC button is disabled with a hint.

- **how it's created.** the side-panel hardware step calls `signClient.connect()` over the WC v2 relay, the user pairs Phantom / Solflare / Backpack / Jupiter on their phone (any wallet that ships WC), and the session is persisted. record: `HardwareVaultRecord { walletconnect: { sessionTopic, accountAddress, chainId, pairedAtEpochMs }, hardwareAccountId, ikaGrpcFeePayerSolSecretKeyB64 (encrypted) }`. mutually exclusive with the `mwa*` fields on a given record.
- **dWallet vault address.** the WC-authorized solana address.
- **fee payer.** when the wallet supports `solana_signMessage` over `IKA_USK_DERIVATION_MESSAGE`, same deterministic fee-payer keypair as the MWA cases (`solanaFeeKeypairFromWalletSignature` at index 1). otherwise falls back to the recovery-words flow. fund with ~0.1 devnet SOL.
- **ika info.** seed = `keccak256(wallet_signature || index_le)` via `ikaRootSeedFromMwaSignature` when the wallet supports message signing; else recovery words.

### cross-reference table

| method | base chain | dWallet vault address | fee payer = vault address? | ika seed source | recovery |
|---|---|---|---|---|---|
| HD create / import | sui or solana | post-DKG dWallet address (else mnemonic-derived chain key) | yes (mnemonic-derived keypair) | `ikaRootSeedFromFeeKeypair` (sui) / `ikaRootSeedFromSolanaKeypair` (solana) | mnemonic |
| imported privkey | sui or solana | post-DKG dWallet address | yes (the imported keypair) | same as HD | re-import the key |
| passkey | sui | sui passkey-scheme address | n/a (passkey signs) | `ikaRootSeedFromPasskeyPRF` (WebAuthn PRF) | passkey sync + opt-in 24 words |
| WaaP | sui | `waapSuiAddress` | yes (WaaP-managed) | `ikaRootSeedFromMwaSignature` (WaaP signature) or recovery words | WaaP login + opt-in 24 words |
| Lazor | solana | `lazorSmartWalletPubkeyB58` (PDA) | **no** (separate ika fee keypair) | lazor passkey signature or recovery words | passkey portal + 24 words (required if `seedSource = 'recovery-words'`) |
| Ledger | sui (solana planned) | Ledger sui address | yes (device signs) | pre-stored at create (no fresh derivation) | device + recovery seed |
| Trezor | solana | Trezor solana address | yes (device signs) | `ikaRootSeedFromMwaSignature` (Trezor sign-message) | device + recovery seed |
| MWA local (Android) | solana | phone-wallet authorized address | **no** (deterministic in-ext fee keypair) | `ikaRootSeedFromMwaSignature` | same Seeker / phone wallet rebuild |
| MWA remote (Seeker, QR) | solana | phone-wallet authorized address | **no** (deterministic in-ext fee keypair) | `ikaRootSeedFromMwaSignature` | same Seeker rebuild |
| WalletConnect | solana | WC-authorized address | **no** (deterministic in-ext fee keypair when `signMessage` works) | `ikaRootSeedFromMwaSignature` or recovery words | re-pair + opt-in 24 words |

---

## features

### multi-vault + multi-dWallet
- one encrypted vault blob holds many `VaultRecord`s + an `activeVaultId`; switch vaults without re-prompting password (the in-session non-extractable `vaultKey` `CryptoKey` covers re-encrypt paths).
- per-vault presign pool storage: `chromatika_presign_pools_v3_<vaultId>`. switching vaults switches pools.
- `dwalletMeta` overlay: per-vault `chromatika_dwallet_meta_v2_<vaultId>` in `chrome.storage.local` for fresher state than the blob alone.

### multi-chain support per dWallet
- one dWallet drives EVM (ethers v6), Bitcoin (bitcoinjs-lib, segwit + taproot), Solana (`@solana/web3.js`), Sui (`@mysten/sui` 2.16.x, GraphQL only), and Aptos (`@aptos-labs/ts-sdk`).
- SECP256K1 dWallet handles EVM + Bitcoin. ED25519 dWallet handles Solana + Sui + Aptos. addresses on every chain are derived from the active dWallet's curve material; no parallel "main HD account" lurks underneath.

### ika dWallet MPC (the core)
- 2PC-MPC via `@ika.xyz/sdk` 0.4.x on sui (production), `@ika.xyz/pre-alpha-solana-client` 0.1.x on solana (dev-mode mock signing).
- DKG, three presign pools (`SECP256K1_ECDSA`, `SECP256K1_TAPROOT`, `ED25519_EDDSA`), 5-min auto-refill via `chrome.alarms`.
- dynamic on-chain pricing via `getRequiredCoinAmounts` (queries `coordinatorInner.pricing_and_fee_manager.current.pricing_map`). never hardcoded.
- `getIkaAdapter(session, baseChain)` dispatches sui-adapter (PTB + GraphQL) vs solana-adapter (gRPC + on-chain anchor program). signing code never calls `session.ikaClient.*` directly.

### dapp connectivity
- EIP-1193 + EIP-6963 + EIP-3085 + EIP-3326 for EVM (window.ethereum + multi-wallet announce + chain management).
- `window.bitcoin`, `window.aptos`, Wallet Standard for sui ("Chromatika Sui") and solana ("Chromatika Solana").
- per-origin permissions store (`chromatika_dapp_permissions_v1`), strict-consent gating per sign method.
- EVM read-only RPCs (`eth_getBalance`, `eth_call`, `eth_estimateGas`, etc.) pass through to the active provider.
- known compat note: `sui_signPersonalMessage` uses the ika SHA512 path, not Mysten's native BLAKE2b intent. some sui dapps may reject until they accept this scheme. see [`wallet-extension/docs/WALLET_SECURITY.md`](wallet-extension/docs/WALLET_SECURITY.md).

### send / receive
- per-chain send pages with decoded EVM tx warnings (36-entry 4-byte selector map in `tx-decode.ts`).
- two distinct EVM send flows: dapp `eth_sendTransaction` opens an approval popup; wallet-ui `sendEvmTx` runs without re-prompt (the user is already inside the wallet UI making an intentional action).
- address book + name-resolution for SuiNS, etc.
- explorer-aware copy-to-clipboard rows on every user-visible chain id, dWallet id, or tx digest (`ExplorerValueRow`).

### NFT gallery + sui kiosk
- EVM via Alchemy (Moralis fallback; `VITE_ALCHEMY_KEY`).
- solana via Helius DAS (`VITE_HELIUS_KEY`).
- sui via on-chain Display + `@mysten/kiosk` SDK (owned + managed kiosks, listings, transfer policies, royalties).
- bitcoin via Hiro Ordinals.
- aptos via the official indexer.

### MediaSafetyMode
- three-mode image policy: `all` / `ipfs-arweave` (default; hijack-safer) / `none` (no remote images).
- respected by NFT renderer + kiosk views.

### hardware wallets
- **Ledger** via WebHID (popup / side panel only, never the SW). EVM (`personal_sign`, txs, EIP-712), sui PTB, solana tx + off-chain sign, bitcoin PSBT.
- **Trezor** via `@trezor/connect-web`. account discovery, EVM message + typed-data, solana tx, bitcoin PSBT (BIP84 P2WPKH; full PSBT decomposition into `TxInputType` / `TxOutputType` with Esplora `refTx` fetches in `btc-trezor-decompose.ts`, 21 unit tests).

### mobile + WalletConnect (solana base)
- **MWA local (Android Chromium):** Android intent (`solana-wallet://`) to the same phone's wallet app.
- **MWA remote (Seeker / phone, QR pair):** wss reflector + association URL QR. **off by default** in prod (`VITE_ENABLE_MWA_REMOTE=false`). public reflector at `development.reflector.solanamobile.com`; self-hosted fallback in [`reflector/`](reflector/).
- **WalletConnect v2:** canonical desktop solana hardware path now. requires `VITE_WC_PROJECT_ID`. supports Phantom / Solflare / Backpack / Jupiter / any WC-shipping wallet.

### swap (sui base)
- Phase B sui -> IKA via Aftermath router (REST API: `/router/trade/route` + `/router/trade/transaction`). zero new npm deps; uses native `fetch()` and `Transaction.from()` to deserialize the router's bytes.
- defaults on; toggle with `VITE_PHASE_B_SUI_SWAP=false`.
- gracefully degrades to "manual funding" copy if Aftermath is down or testnet IKA pool has no liquidity.

### x402 payments
- HTTP 402 + `Payment-Required` interception in the dapp-interface (`x402-fetch-wrapper.ts`); wraps `window.fetch` for every page.
- USDC `exact` scheme (per the x402 spec) signed via ika MPC on the active dWallet (or via WalletConnect / Seeker if those are wired).
- daily caps: per-counterparty + global, USD-bucketed by local timezone (`chromatika_x402_caps_v1`).
- receipts log capped at 200 most recent (`chromatika_x402_receipts_v1`); thumbs-up / thumbs-down quality flag per receipt.

### policy vault (on-chain spend caps)
- sui Move package at [`wallet-extension/move/chromatika-policy/`](wallet-extension/move/chromatika-policy/) (`sign_gate`): per-dWallet caps, cool-down windows, panic state, rescue address, actuator slots.
- solana anchor scaffold at [`wallet-extension/solana/chromatika-policy/`](wallet-extension/solana/chromatika-policy/) (pre-alpha; mirrors sui field-for-field). `do_approve_message_cpi` is a stub until ika alpha 1 ships a CPI target.
- deploy runbook: [`wallet-extension/docs/POLICY_DEPLOY_QUICKSTART.md`](wallet-extension/docs/POLICY_DEPLOY_QUICKSTART.md).

### MCP agent surface
- chrome native messaging host (`wallet-extension/native-host/chromatika-mcp-host.mjs`) exposes chromatika's MCP surface.
- HTTP transport on `127.0.0.1:<port>` (random by default; user-pinnable via settings -> agents). also a `--stdio-bridge` mode for clients that only speak stdio MCP (Claude Desktop).
- per-install bearer token (`chromatika_mcp_v1.tokenHex`) gates every request.
- **read tier (no popup):** `listVaults`, `getActiveVault`, `getActiveNetworks`, `getLockState`.
- **approve tier (popup-gated):** `signMessage` (EVM + solana), `sendEvmTx`, `signTransaction` (EVM only, no broadcast). uses chromatika's existing approval popups.
- enable + token rotation in settings -> agents. setup script: `pnpm setup:native-host --extension-id=<id>` per OS.

### price waterfall
- user-ordered waterfall under settings -> USD price sources: CoinGecko, DefiLlama, CoinMarketCap (optional via `VITE_CMC_API_KEY`), Pyth, Chainlink (subset of symbols), GeckoTerminal DEX TWAP (for IKA).
- 60s cache, session-scoped.
- BTC fiat is off-chain only.

### phishing protection
- declarativeNetRequest dynamic rules from MetaMask `eth-phishing-detect`. capped at 4900 rules under chrome's 5000 dynamic-rule limit.
- daily refetch of upstream `config.json` via `chrome.alarms`.
- redirects blocked navigations to `phishing-warning.html?blocked=DOMAIN` with go-back / ignore buttons.

### safety alerts
- broadcast publisher with signed alerts; wallet UI surfaces a banner when an alert is live.
- publisher key + verification in `alerts/alerts-verify.ts`.

### IKA staking
- in-app staking screen on sui base. uses the fee payer as the coin owner + signer (per IKA staking PTB shape).

### vault crypto
- **Argon2id** RFC 9106 (t=3, m=64 MiB, p=4) + AES-GCM 256.
- one app password derives a non-extractable `CryptoKey`; the bytes are never written to `chrome.storage.local`.
- session-scoped unlock cache in `chrome.storage.session` only (`chromatika_unlock_cache_v1`); cleared on lock / unlock / write.
- legacy v2 (PBKDF2) blobs are rejected on parse; pre-release policy is "clear extension storage and re-onboard".

### auto-lock
- `chrome.idle` + alarms wiring. OS screen-lock triggers extension lock. configurable timeout in settings.

### operation-progress banner
- single-slot status record in `chrome.storage.session` (`chromatika_op_progress_v1`).
- all UI surfaces (popup, side panel, extension page) subscribe via `chrome.storage.onChanged` (a real cross-context push).
- recovery-action buttons attach to specific failure modes (e.g. devnet-wipe -> "recreate ED25519 dWallet" jumps the user to the dWallet management screen).
- auto-clears 2.5s after success / 6s after failure; banners with an action don't auto-clear so the user can read the recovery prompt.

---

## install + run

install + dev / build / test commands all live in [`wallet-extension/README.md`](wallet-extension/README.md). tl;dr:

```
cd wallet-extension
pnpm install
pnpm run build
```

then load `wallet-extension/dist/` unpacked at `chrome://extensions` (developer mode on, "load unpacked"). for daily dev, `pnpm run dev` (vite watch) + click "reload" on the chromatika card after each rebuild. the MV3 service worker always needs that reload to pick up code changes.

---

## architecture

side panel = primary UI; popup = quick actions. tRPC over `chrome.runtime.connect` (port) with `sendMessage` fallback. background service worker holds the vault, keyring (BIP39/44 + ika DKG), presign pool, hardware bridge, and per-chain clients (EVM, BTC, solana, sui, aptos). content script + injected dapp-interface implements EIP-1193/6963/3085/3326 + Wallet Standard sui + solana + window.bitcoin + window.aptos. SharedWorker syncs state between popup + side panel. SuiGraphQLClient is the only sui transport (no JSON-RPC); ika's `IkaClient` uses the same client.

visual source of truth: [`wallet-extension/docs/architecture-final.html`](wallet-extension/docs/architecture-final.html). prose detail in [`wallet-extension/README.md`](wallet-extension/README.md).

---

## repo layout

| path | purpose |
|---|---|
| [`wallet-extension/`](wallet-extension/) | the actual MV3 extension (react + vite + trpc + ika sdk). install + dev: `wallet-extension/README.md`. |
| [`wallet-extension/docs/`](wallet-extension/docs/) | `STATUS.md` (shipped/gated/stubbed/future index), `TERMINOLOGY.md`, `DWALLET_VAULT_MODEL.md`, `WALLET_SECURITY.md`, `SEEKER_REMOTE_PAIRING.md`, `POLICY_DEPLOY_QUICKSTART.md`, etc. |
| [`wallet-extension/docs/architecture-final.html`](wallet-extension/docs/architecture-final.html) | locked visual diagram (open in browser). |
| [`wallet-extension/docs/future/`](wallet-extension/docs/future/) | roadmap + research (archived zkLogin notes, funding strategy, ika explorer brief). |
| [`wallet-extension/move/`](wallet-extension/move/) | sui Move policy package (`chromatika-policy`). |
| [`wallet-extension/solana/`](wallet-extension/solana/) | solana anchor policy program (pre-alpha). |
| [`wallet-extension/native-host/`](wallet-extension/native-host/) | chrome native messaging MCP host (HTTP + stdio modes). |
| [`reflector/`](reflector/) | self-hosted Cloudflare Workers MWA reflector fallback. |
| [`skills/`](skills/) | agent reference skills (web3-wallet-dev, ika-sdk, sui-dev-skills, etc.). not shipped in the extension. |

---

## status + further reading

- shipped vs gated vs stubbed vs future: [`wallet-extension/docs/STATUS.md`](wallet-extension/docs/STATUS.md).
- canonical product terms (dWallet vault, dWallet, chromatika vault, ika base chain): [`wallet-extension/docs/TERMINOLOGY.md`](wallet-extension/docs/TERMINOLOGY.md).
- multi-vault target model + phased epic: [`wallet-extension/docs/DWALLET_VAULT_MODEL.md`](wallet-extension/docs/DWALLET_VAULT_MODEL.md).
- security disclosures + third-party API privacy notes: [`wallet-extension/docs/WALLET_SECURITY.md`](wallet-extension/docs/WALLET_SECURITY.md).
- Seeker remote pairing runbook: [`wallet-extension/docs/SEEKER_REMOTE_PAIRING.md`](wallet-extension/docs/SEEKER_REMOTE_PAIRING.md).
- policy contract deploy runbook: [`wallet-extension/docs/POLICY_DEPLOY_QUICKSTART.md`](wallet-extension/docs/POLICY_DEPLOY_QUICKSTART.md).

---

## license

chromatika is licensed under a source-available license modeled on the Business Source License 1.1 (BUSL 1.1). full text: [`LICENSE`](LICENSE).

tl;dr: read it, learn from it, reuse the code in anything that isn't itself an end-user cryptocurrency wallet. custody services, signing services, key-management services, MPC infra, dapps, libraries, agents, dev tools, research code, etc. are all fine - take whatever helps. the **only** thing the license blocks is forking this repo to ship a competing wallet. on **2030-05-03** the codebase auto-converts to Apache License 2.0 (no restrictions at all). as is, no warranties, no liability. see disclaimers above and the LICENSE file for the binding text.
