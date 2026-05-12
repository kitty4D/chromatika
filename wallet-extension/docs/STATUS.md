# Chromatika status

Single index of what's shipped, gated, stubbed, and planned. Updated when the code reality changes. Other docs (architecture-final.html, WALLET_SECURITY.md, DWALLET_VAULT_MODEL.md) point here instead of duplicating status.

For dated changelog entries (what shipped when, with file paths and test counts), see [CHANGELOG.md](CHANGELOG.md).

Pre-release: chromatika has not shipped to end users. Storage/crypto are dev-only; schema breaks allowed without migrations.

---

## Shipped surfaces

Stable feature inventory. Each row describes the current capability; the changelog has the dated history.

### Core
- **Vault** - Argon2id (RFC 9106 §4 second option: t=3, m=64 MiB, p=4) + AES-256-GCM, multi-record `chromatika_vault_v3` with per-vault `dwalletMeta` overlay (`chromatika_dwallet_meta_v2_<vaultId>`). Session holds non-extractable AES `CryptoKey` (no password string in RAM). Unlock cache holds derived key bytes (b64) + KDF meta in `chrome.storage.session` only - never the plaintext password.
- **Keyring** - BIP39/44, SLIP10 ed25519, dWallet ed25519 public-key derivation.
- **Auto-lock** - `chrome.idle` + `chrome.alarms`; OS screen-lock triggers wallet lock.
- **Phishing** - dNR dynamic rules (<5000 cap), bundled list + daily refetch of MetaMask `eth-phishing-detect`.

### Ika (Sui base)
- dWallet DKG / presign pool / sign / re-encrypt, three presign pools (`SECP256K1_ECDSA`, `SECP256K1_TAPROOT`, `ED25519_EDDSA`), per-vault presign store, 5-min refill alarm.
- `IkaClient` runs on the vault `SuiGraphQLClient` (`client.core.*`), never JSON-RPC for supported paths.
- Dynamic pricing via `getRequiredCoinAmounts`.
- **Ika staking** - on-chain validator list (name, commission, ~APY, total stake, status pill) parsed from the `Validator` object JSON via `SuiGraphQLClient`; epoch + per-epoch subsidy + active-set size pulled via `ikaClient.ensureInitialized().systemInner`. Epoch countdown + "updated Ns ago" freshness pill, in-memory search + sort, drill-in stake subview with max button and annual reward estimate. Stake / withdraw routed through the operation-progress banner. **No manual validator address entry** anywhere in the UI - row click is the only path. See [`src/background/ika/ika-staking.ts`](../src/background/ika/ika-staking.ts) + [`src/ui/pages/IkaStakingPage.tsx`](../src/ui/pages/IkaStakingPage.tsx).
- Sui testnet + Ika testnet usability audit (faucets, hardcoded-mainnet edge cases, pre-flight checklist): [`IKA_SUI_TESTNET_AUDIT.md`](IKA_SUI_TESTNET_AUDIT.md).

### Chain clients
- **EVM** - ethers v6; `eth_sendTransaction` dapp flow (approval popup) + wallet-UI `sendEvmTx` (no popup). Keccak preimage passthrough for `personal_sign` and `eth_signTypedData_v4`.
- **Bitcoin** - bitcoinjs-lib, segwit + taproot sends.
- **Solana** - `@solana/web3.js`, send + off-chain message signing.
- **Sui** - `@mysten/sui` 2.16.0 (pinned via `pnpm.overrides`), GraphQL only (no JSON-RPC), `IkaTransaction` flows.
- **Aptos** - `@aptos-labs/ts-sdk`.
- **DeSo** - `chains/deso/`, identity from existing SECP dWallet, native send + post + derived-key delegation. See [`DESO.md`](DESO.md).

### UI surfaces (`src/ui/pages/`)
- Assets, Activity, Send, Portfolio, DWalletPortfolio, NFTs, DApps, IkaStaking, NetworkSelector, Settings, Vault/DWallet management, ChromaLab (dev), Wallet, Payments (x402), Agents (MCP). Kiosk management lives as a panel inside NftsPage.

### Dapp bridge
- EIP-1193 / EIP-6963 (including 3085/3326), `window.bitcoin`, `window.aptos`, Wallet Standard for Sui + Solana.
- Sui transactions sign via Mysten intent + BLAKE2b (`signBuiltSuiTransactionBytes`).
- `sui_signPersonalMessage` produces Mysten-standard signatures: BCS-encodes the message as `vector<u8>`, prepends the PersonalMessage intent (`[3,0,0]`), BLAKE2b-256 hashes, then signs the digest via the ika ed25519 MPC path. Verified byte-for-byte compatible with `@mysten/sui` `Ed25519Keypair.signPersonalMessage` + `verifyPersonalMessageSignature` (see `chains/sui-personal-message.test.ts`).
- **x402 fetch interception** - `dapp-interface/x402-fetch-wrapper.ts` wraps `window.fetch` so any page response with `HTTP 402 + PAYMENT-REQUIRED` is automatically routed through the wallet's approval popup, signed, and retried with `PAYMENT-SIGNATURE`. See "x402" below.
- New dapp-bridge methods on the existing port: `chromatika_x402_handle_402` and `chromatika_x402_record_settlement` route 402s through the wallet without any new transport.

### Data services
- **Price waterfall** - CoinGecko → DefiLlama → CoinMarketCap (requires `VITE_CMC_API_KEY`) → Pyth → Chainlink (EVM proxy feeds) → GeckoTerminal DEX TWAP (IKA). ~60s cache.
- **NFT services** - Sui (on-chain + Display), Bitcoin (Hiro Ordinals), EVM (Alchemy, needs `VITE_ALCHEMY_KEY` or returns empty), Solana (Helius DAS, needs `VITE_HELIUS_KEY` or returns empty), Aptos (Token v2 indexer).
- **Kiosk** - `@mysten/kiosk` `KioskClient` (owned/managed, listings, transfer policies, royalties).
- **MediaSafetyMode** - `all` / `ipfs-arweave` (default) / `none`. URL filtering runs UI-side via `filterImageUrl()` before any cache call.
- **Offscreen media cache** - `chrome.offscreen` doc with IndexedDB-backed `chromatika_media_cache_v1`, 100 MB / 7-day TTL, `credentials: 'omit'` + `referrerPolicy: 'no-referrer'`. UI surfaces via `<NftImage>`. See [`OFFSCREEN_MEDIA_CACHE.md`](OFFSCREEN_MEDIA_CACHE.md).

### Hardware
- **Ledger** - WebHID in popup/side-panel context, never in the SW. EVM (`personal_sign`, tx, EIP-712), Sui (`suiTx`), Solana (tx, off-chain), Bitcoin (PSBT via `hw-app-btc@10.x` `signPsbtBuffer`, bech32 + legacy paths). Sui app/firmware floors in `LEDGER_SUI_LIMITS.md`.
- **Trezor** - account discovery + EVM message/typedData + Solana tx signing + Bitcoin (BIP84 P2WPKH) via `TrezorConnect.signTransaction` + PSBT decomposition through `btc-trezor-decompose.ts`. Live device round-trip is a manual smoke (no hardware in CI); parser is unit-tested. CSP adds `frame-src https://connect.trezor.io`. Sui not supported by Trezor Connect.
- **Solana Mobile Wallet Adapter (MWA)** - **two transports** for Solana hardware-wallet onboarding, dispatched on `mwaTransport` carried through `HardwareVaultRecord` → `SessionState.solanaMwaAccount` → `PendingHardwareSign`:
  - **Local (Android Chrome)** - `@solana-mobile/mobile-wallet-adapter-protocol-web3js` `transact()` launches the mobile wallet via Android intent on the same device; `vendor:'mwa', mwaTransport:'local'`. Shown only when UA is Android.
  - **Remote (desktop ↔ Seeker / phone, QR pair)** - `startRemoteScenario()` opens `wss://reflect.solanamobile.com` from the side panel / popup; user scans QR with the Seeker camera and approves in Seed Vault. Persisted `auth_token` + `reflectorHost` let every subsequent sign reauthorize without rescanning the QR. `vendor:'mwa', mwaTransport:'remote'`. Shown only when UA is **not** Android. Solana-only.
  - Because Seed Vault never exposes secret bytes, MWA + Solana base vaults derive an in-extension Solana fee-payer keypair deterministically from the wallet's signature over `IKA_USK_DERIVATION_MESSAGE` at index 1; ika `UserShareEncryptionKeys` seed comes from the same wallet signature at index 0. Same Seeker / same phone wallet on any device produces the same fee-payer address, so SOL persists across reinstalls. **MWA-remote is `false` by default in prod builds (`VITE_ENABLE_MWA_REMOTE=false`)** because Solana Mobile's reflector demo is currently unreliable; WalletConnect is the canonical Solana hardware path on desktop today.

### Swap
- **Phase B** - Aftermath router (`/router/trade/route` + `/router/trade/transaction`), Sui → IKA, feature-flagged `VITE_PHASE_B_SUI_SWAP` (default true).

### Agents (MCP)
- **Native messaging host** - `wallet-extension/native-host/chromatika-mcp-host.mjs` (zero-deps node script). Two invocation modes:
  - default: chrome-spawned host, hosts `POST /mcp` HTTP MCP transport on `127.0.0.1:<port>` with bearer-token auth, forwards `tools/list` + `tools/call` to the extension via native messaging stdio.
  - `--stdio-bridge`: child-process spawned by stdio MCP clients (Claude Desktop default), forwards line-delimited JSON-RPC to the chrome-spawned host via env-var-configured URL + token.
  - Setup: `pnpm setup:native-host --extension-id=<id>` registers the host on the user's OS.
- **Bridge** - `src/background/mcp/mcp-native-bridge.ts` connects via `chrome.runtime.connectNative`, capped exp backoff (5 attempts, 1s→30s).
- **Read tier (no popup)** - `listVaults`, `getActiveVault`, `getActiveNetworks`, `getLockState`, `listActiveAlerts`. `getActiveVault` returns `policyVault: {...} | null` from the cached snapshot.
- **Approve tier (popup-gated, with PolicyVault no-popup mode where applicable)**:
  - `signMessage` ({ chain: 'evm' | 'solana', messageHex, evmChainId? }) → ika MPC signs.
  - `sendEvmTx` ({ to, value?, data?, chainId?, gas?, ... }) → existing `ApproveTxScreen` popup → broadcast txHash. Skips popup when active vault has a PolicyVault link, request is under-cap, not panicked, not in cool-down.
  - `signTransaction` ({ ... }) → sign-only; always shows popup (no no-popup mode by design).
  - `sendSolanaTx` ({ to, lamports }) OR ({ to, mint, amountRaw }) → native SOL or SPL transfer; same PolicyVault no-popup behavior.
- **Settings UI** - `AgentsSettingsSection`: enable/disable, per-install bearer token (reveal/copy/rotate), agent URL, native-host status, optional fixed listen port.

### x402 (HTTP 402 payments)
- **Spec target** - x402 v2.0 spec at `github.com/x402-foundation/x402`, `exact` scheme on Solana, USDC mint only (`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`).
- **Fetch interception** - `dapp-interface/x402-fetch-wrapper.ts` wraps `window.fetch`; failure modes (caps / user reject / signer error / retry network) all surface the original 402 unchanged.
- **Dispatcher** - `src/background/x402/x402-dispatch.ts`. Two signing paths share `x402-solana-build.ts`:
  - **ika MPC** (`x402-solana-signer.ts`) - default; dWallet's derived Solana address pays.
  - **WalletConnect** (`x402-walletconnect-signer.ts`) - when `session.solanaWcAccount` is set, signs via `enqueueHardwareSign({ vendor: 'walletconnect', kind: 'solanaTx' })`; ika MPC bypassed entirely.
- **Caps** - `chromatika_x402_caps_v1`: per-counterparty + global daily caps in USD (defaults $5/seller, $25 global).
- **Receipts** - `chromatika_x402_receipts_v1`, capped at 200 most recent, configurable retention. Status: `pending` / `settled` / `failed` / `rejected`. **Private receipts** option encrypts `{ resourceUrl, sellerAddress, signatureHex }` via `EncryptXyzBackend` (self-recipient envelope); plain fields (host, amount, status, settlement tx) stay visible.
- **UI** - `X402ApprovalScreen` popup, `PaymentsPage` for cap matrix + live-polling receipts.

### Encrypted UX (dWallet labels + activity notes via Encrypt.xyz)
- **Per-dWallet label** - opt-in, lab-grade pre-alpha. Stored on-chain as real Encrypt ciphertexts via gRPC `CreateInput`; reveal goes through signed `ReadCiphertext`. Multi-chunk (cap 64 utf-8 bytes, 4× EUint128 chunks). On-chain status polling 4s; pill shows `verified` ✓ / `encrypting…` / `missing` (devnet wipe). Opt-in **auto-rebuild after devnet wipe** (`chromatika_label_auto_rebuild_v1`, default OFF) caches plaintext + auto-re-encrypts on `missing`.
- **`EncryptionBackend` interface** - `EncryptXyzBackend` (self-recipient envelope) is default; `DirectEd25519Backend` (cross-recipient via X25519 ECDH + HKDF-SHA256 + AES-GCM-256, HD-derived inbox key) is shipped; `SealBackend` deferred. See [`ENCRYPTION_BACKEND.md`](ENCRYPTION_BACKEND.md).
- **Encrypted activity notes** - tRPC `encryptActivityNote` / `decryptActivityNote` / `removeActivityNote` / `getActivityNoteStatus`. Decrypt requires unlock + 2× ika `signMessageSol` for K chunks (~1-3s on devnet).

### PC-Token hidden transfers (encrypt.xyz)
- **Module** at `src/background/encrypt-pc/`: program constants, types, PDA derivations, 9-account encryptCpiAccounts CPI suffix, ix builders for Wrap / Transfer / InitializeAccount / Unwrap{Burn,Decrypt,Complete}, amount-encrypt via existing `CreateInput` gRPC, balance read via `ReadCiphertext`, top-level wrap / hidden-transfer / 3-step unwrap flows.
- **Market registry** at `src/background/encrypt-pc/pc-token-markets.ts` (`chromatika_pc_token_markets_v1`): each entry is `(splMint, programId, mintAuthority?, network)`; supports multiple deployments.
- **UI** - `PcTokenMarketsPanel` (Settings) for adding / activating / removing markets. Wrap on Portfolio rows; Send + Unwrap on synthetic pcToken rows; `HiddenSendDisclaimerModal` enforces 3-checkbox honesty disclosure on first hidden-send per vault.
- **Privacy model** - amounts + recipient pcToken account hidden on-chain; sender wallet visible; ciphertext accounts deterministic per (mint, owner) so repeat sends correlate. Trust model: single mock executor in pre-alpha. Self-deploy required (mirrors PC-Swap pattern). Setup runbook in [`PC_TOKEN.md`](PC_TOKEN.md).

### Signed-tx records (origin capture)
- **`chromatika_signed_txs_v1` store** - per-vault map, capped at 500 records per vault with FIFO rotation. Each record holds `{ txHash, origin, chainId, vaultId, timestampMs, kind, encryptedNote? }`. `signAndBroadcastEvm` (both ledger + ika code paths) records on broadcast success. Wallet-UI sends now record for sol / sui / btc / apt / deso paths; dapp-bridge records origin for sui / aptos. Activity feed merges by `digest === txHash` and surfaces `origin` + `signedByThisWallet` + `hasEncryptedNote`. Drain analysis, broadcast alerts, panic forensics build on this.

### Safety broadcast alerts
- **Signed alerts feed** - chromatika polls a JSON feed (default `https://www.chromatika.xyz/safety-alerts.json`) every 5 min via `chrome.alarms`. Each alert is a `SignedAlertV1` envelope with optional `panicTargets: string[]` (vault object ids). Ed25519 sig verified against canonical-JSON bytes under a bundled publisher allowlist. Storage `chromatika_alerts_v1`, capped at 200.
- **Persistent in-app banner** - mounted in `MainWalletShell`; shows highest-severity active alert.
- **Chrome notifications** for `severity: 'critical'`. Click opens side panel with `?alertId=<id>`.
- **Auto dNR phishing-rule append (TTL'd)** for critical alerts with `affectedDomains` (rule IDs 10000-19999, collision-free with the eth-phishing-detect bundle 1-4900). Per-rule cleanup alarm at expiry.
- **Auto-panic on receipt** - when a verified alert lists the active vault's policy-vault id in `panicTargets`, `runNewAlertActions` builds + signs the `panic` PTB locally. Result: chromatika-team can freeze user keys at the protocol level on drain detection while the user is AFK.
- **Settings UI** (`AlertsSettingsSection.tsx`): mute, opt-out, custom feed URL, alert history, publisher allowlist viewer.
- **MCP `listActiveAlerts` read tool** - filters by domain + severity floor. No popup.
- **Publishing CLI** at `scripts/publish-alert.mjs`: `--gen-key`, `--gen-dev-key`, `sign`, `feed`, `sample`, `sample-panic`. Sample fixtures at `public/dev-fixtures/`.
- **TODO**: replace `PLACEHOLDER_DEV_PUBLISHER_PUBKEY_B64` in `alerts-publishers.ts` with the real chromatika-team production publisher pubkey before mainnet.
- **Future**: Sui Move `BroadcastChannel` object + `PublisherCap` registry (on-chain anchor), walrus body for long-form alerts, cross-chain anchors, soft-block dapp-bridge for flagged domains.

### Policy Vault (on-chain spend caps + panic + rescue)
- **Move package** at `wallet-extension/move/chromatika-policy/sources/sign_gate.move` - wraps an ika `DWalletCap` in a shared `PolicyVault` object so all signing for that dWallet must go through the module. Exposes `wrap_dwallet_cap` / `sign_with_policy` / `panic` / `unfreeze` / `rescue_sign` / setters / `pop_presign` / `replenish` / `request_unwrap` / `cancel_unwrap` / `claim_unwrap`. Curve-agnostic: same module wraps SECP256K1 and ED25519 dWalletCaps.
- **Sui mainnet deploy** (2026-05-11): `0x8cd25cd3ae7966b61eeae97d77b7e029b29b37307b533b505c6a76b63e22d727` (built via `--dump-bytecode-as-base64 --no-tree-shaking` against v2 `ika_dwallet_2pc_mpc` at `0x23b5bd96...`). Wired in built-in registry at [`src/background/policy-vault/policy-vault-builtin.ts`](../src/background/policy-vault/policy-vault-builtin.ts) → end users on Sui mainnet get the team-deployed package automatically. The Settings "chromatika team only" override input still works for iteration deploys on testnet / devnet / locally rebuilt mainnet bytecode.
- **Hard decoders** in `sign_gate_evm.move` (RLP for legacy + EIP-1559 + EIP-2930), `sign_gate_btc.move` (BIP143 sighash preimage), `sign_gate_deso.move` (DeSo binary tx layout). Each emits a `*Decoded` event with chain-derived value for audit.
- **Cap-increase staged delay** (opt-in): `stage_cap_raises: bool`, pending-cap state, lazy-commit. Symmetric off-toggle (turning ON immediate, turning OFF staged). `MIN_UNFREEZE_DELAY_MS = 0` - the user controls every policy parameter, chromatika is opinionated about defaults but never enforces them.
- **TS infra** at `src/background/policy-vault/`: storage, PTB builders, on-chain reader + parser, actions orchestrator. **Per-(vault, dwallet) storage** keys: `chromatika_policy_vault_v1_<vaultId>_<dwalletId>` (link + cached snapshot), `chromatika_policy_audit_v1_<vaultId>_<dwalletId>` (200-entry FIFO audit log), `chromatika_policy_presigns_v1_<vaultId>_<dwalletId>` (presign cap id cache). Multi-wrap supported: one chromatika vault can wrap multiple dWallets (e.g. one SECP256K1 + one ED25519, or several of each).
- **Both curves wrappable**: `optInToPolicyVault({ curve })` accepts `SECP256K1` (curve=0, sigAlgo=0 ECDSA) or `ED25519` (curve=2, sigAlgo=3 EdDSA). SECP-signed chains (BTC / EVM / DeSo) enforce hard chain-decoded caps via the existing `sign_gate_*` decoders; ED25519-signed chains (Sui PTB / Solana ix / Aptos move calls) enforce caller-declared (soft) caps until per-format decoders ship. Panic / cooldown / unfreeze gates apply uniformly to both curves.
- **TS dispatch** - `signBytesEvm` dispatches through `sign_evm_with_policy` when `isEvmTx` + `KECCAK256` + policy-gated (hard on value, soft on price - chain decode authoritative; price logged on-chain). BTC + DeSo dispatch through `sign_btc_with_policy` / `sign_deso_with_policy` similarly. Wallet-UI EVM / BTC / DeSo sends work post-opt-in via `signAndBroadcastEvm` / `signBitcoinTxSighashPreimage` / `signAndSubmitDeSoTransactionHex` resolving `declaredValueMicros` and threading through. Dispatchers resolve the right wrap by `session.dwalletMeta?.[curve]?.dwalletId` at sign time.
- **tRPC** at `src/server/routers/policy-vault.ts` covers all entries. `getPolicyVaultState` returns `{ packageConfig, links: Array<{ link, snapshot }>, activeVaultBaseChain }`; every write mutation (`panicVault` / `unfreezeVault` / `setPolicy*` / `commitPending*` / `addPolicyActuator` / `removePolicyActuator` / `replenishPolicyPresign` / `topUpPolicy*` / `clearLocalPolicyVaultLink` / `requestPolicyUnwrap` / `cancelPolicyUnwrap` / `claimPolicyUnwrap`) + audit query/clear takes `dwalletId: SuiAddressSchema`. `optInToPolicyVault` accepts `{ curve?, dwalletId? }`.
- **UI**: [`PolicyVaultPage`](../src/ui/pages/PolicyVaultPage.tsx) is its own bottom-nav tab (was an inline panel under Settings); renders the three-state panel (no-package / configured-not-opted-in / opted-in with cap gauge, actuators, tune drawer, **PANIC** button, audit log, exit policy two-step). Multi-wrap-aware: shows a hint banner above the primary wrap when `links.length > 1`. Settings still hosts long-tail policy prefs under Safety → "Prompts I've dismissed".
- **Post-create prompt** ([`PostCreatePolicyVaultPrompt.tsx`](../src/ui/components/PostCreatePolicyVaultPrompt.tsx)): bottom-sheet modal that fires after every dWallet DKG resolves on a Sui-base vault. Defaults: $1000/day cap, 60s cooldown, 7-day unfreeze, 1-day staged-change + unwrap delay, 0.01 IKA + 0.01 SUI seed. "Don't ask me again on any new dWallet" checkbox sets `chromatika_policy_vault_prompt_globally_dismissed_v1`. Re-enable under Settings → Safety → "Prompts I've dismissed".
- **Side effects on panic** - DeSo derived-key auto-clear (local link cleared; on-chain revoke deferred to v1).
- **`PolicyVaultBanner`** mounted at top of SendPage shows policy-gated cap remaining, spent today, cool-down, panicked countdown for the primary wrap (per-curve banner pick is a follow-up when SendPage threads curve context).
- **Vault removal sweeper**: [`wallet-service.ts`](../src/background/wallet-service.ts) `removeVault` calls `clearAllPolicyVaultLinksForVault(vaultId)` + `clearAllPolicyAuditForVault(vaultId)` + `clearAllPolicyPresignsForVault(vaultId)`. On-chain `PolicyVault` objects remain (local-only forget).
- **Safety-alerts auto-panic**: `autoPanicPolicyTargetsForAlert` iterates `listPolicyVaultLinks` and panics every dWallet whose `vaultObjectId` matches the alert's `panicTargets`.
- **MCP gate**: `maybeSkipPopupForPolicy({ ..., curve? })` picks the per-curve wrap. `getActiveVault` returns `policyVaults: PolicyVaultStateForAgent[]` (array, one per wrapped dWallet).
- **Move tests**: BTC / DeSo / EVM hard-decoder unit tests under `wallet-extension/move/chromatika-policy/tests/sign_gate_*_test.move` (BIP143 amount extraction, DeSo binary tx, EIP-1559 RLP). `sign_gate` state-machine + bypass-attack tests are not in tree today (intended to land in a follow-up; needs `override = true` on Sui / MoveStdlib in Move.toml to resolve the multi-version dep conflict that ika's transitive Sui dep at a different rev triggers).
- **Solana-base policy is DISABLED in UI today.** `PolicyVaultPanel` renders a "Sui-only for now" notice when active vault baseChain is Solana; `PolicyVaultBanner` does not mount on Solana sends; `optInToPolicyVault` throws `no-package` on Solana-base. The Anchor program at `wallet-extension/solana/chromatika-policy/` stays in tree as pre-alpha scaffolding for ika Solana Alpha-1 (CPI bodies stub to no-ops; `anchor build` still works for verifying the Rust program compiles, no TS test harness today — solana-bankrun ships no Windows binary and the program has no real signer to test against). See [`POLICY_VAULT.md`](POLICY_VAULT.md), [`POLICY_VAULT_V1_5.md`](POLICY_VAULT_V1_5.md), [`POLICY_VAULT_SOLANA.md`](POLICY_VAULT_SOLANA.md).

### Multi-vault, scan, restore
- **Activity scan service** at `src/background/scan/`: tRPC mutations `scanForHd` / `scanForPasskey` / `scanForSeeker` / `scanForWaap` / `scanForLazor`. Default chains: Sui mainnet + Solana mainnet + Solana devnet. Super-pro picker covers EVM long-tail, Bitcoin, Aptos, DeSo, Cosmos, Polkadot.
- **Multi-vault siblings**: `ikaEncryptionIndex?: number` on Hardware / WaaP / Lazor records + `passkeyEncryptionIndex?: number` on Passkey records. Re-pairing same identity produces sibling vaults at incrementing indices. HD vaults get `accountIndex?: number` + `importVaultsBatch` for multi-account import from one phrase.
- **Dwallet inventory + orphan match**: tRPC `dwalletInventoryForActiveVault` returns owned caps annotated with `matchedVaultId` / `matchedVaultLabel` / `matchedIkaIndex` (or `null` for orphans).
- **`FindMoreAccountsPanel`** in SettingsPage post-unlock: surfaces inventory with orphan badges, runs scans, mounts inline `WalletSetupFlow` for sibling-add.
- **Three-mode `seedSource` UX** for Lazor + WaaP: `*-signature` (deterministic, no phrase needed) / `recovery-generate` (chromatika-issued 24-word phrase) / `recovery-restore` (paste existing phrase to rediscover dWallet).

### Deploy scripts
- **Sui**: `scripts/deploy-sui-policy.mjs` wraps `sui move build` + `sui client publish --json`. Auto-extracts `packageId`, prints next-step instructions.
- **Solana**: `scripts/deploy-solana-policy.mjs` wraps `anchor build` + `anchor deploy`. Optionally splices program pubkey into `lib.rs` + `Anchor.toml` via `--sync-program-id`.
- **package.json scripts**: `build:`, `test:`, `deploy:` for both Sui + Solana policy packages, with per-network variants (`:testnet` / `:mainnet` / `:devnet` / `:dry-run`).
- **Quickstart**: [`POLICY_DEPLOY_QUICKSTART.md`](POLICY_DEPLOY_QUICKSTART.md).

### Tooling
- Strict TS, Vitest (510 unit tests across 68 files at last run), Playwright smoke e2e, ESLint (flat config, react-hooks + typescript-eslint recommended).
- GitHub Actions CI: install → lint → test → build.

---

## Gated (code exists, flag off or scoped)

| Feature | Flag / gate | Current behaviour | Blocker to ship |
|---|---|---|---|
| Solana ika base | `VITE_SOLANA_IKA_BASE=true` (dev only) | Wired for exploration against `@ika.xyz/pre-alpha-solana-client` **0.1.1**: SECP256K1 DKG + EVM/BTC signing (`approve_message` with `DWalletSignatureScheme` u16 LE + gRPC `Sign` carrying `dwallet_attestation`) and ED25519 DKG + Solana message signing run over ika pre-alpha gRPC (`solana-grpc-client.ts`). `DWalletMeta` persists `dwalletAttestationBytesB64` + `dwalletPublicKeyB64` per Solana dWallet. Solana-base vaults derive the ika `UserShareEncryptionKeys` root seed from the Solana fee payer keypair via `keccak256(secretKey64 \|\| encryption_key_index_le)` (`ikaRootSeedFromSolanaKeypair`). `SolanaIkaAdapter` Sui-object reads still throw (see Stubs). All signatures come from a single mock signer - **never promote as production**. | Upstream ika Solana Alpha 1; real MPC signing; program/data wipe cycles until then. |
| Team faucet onboarding | `VITE_FUNDER_URL` + `VITE_FUNDER_TOKEN` (unset) | freshly-created Sui-base vaults (passkey / WaaP / mnemonic / hardware-Sui) automatically `POST /fund` to the team funder Worker (`funder/`, Cloudflare Worker) for a small drip of mainnet SUI + IKA. Unset env vars = silent no-op. Worker enforces per-address one-shot + `DAILY_CAP` (default 25) + optional `LIFETIME_CAP`. Solana-base paths excluded by `record.baseChain === 'sui'` gate in `finalizeUnlock`. | Mainnet pricing calibration in `funder/src/config.ts`; funder wallet top-up; deploy `funder/` to a stable hostname; populate `VITE_FUNDER_*` in production build. |
| Encrypt.xyz SPL ENC deposit | notes-only stub (`encrypt-spl-deposit-stub.ts`) | tRPC returns the user-funded path notes (acquire ENC + ATA top-up + Encrypt instruction reference URL). No on-chain builders shipped. | `create_deposit` / `top_up` ix builders against the published Encrypt program. |
| Encrypt.xyz PC-Swap (phase 4) | notes-only stub (`encrypt-pc-phase-stub.ts:getEncryptPcSwapPhase4Stub`) | Returns `optional_after_pc_token` + the upstream PC-Swap book URL. PC-Token (phase 3) is shipped (see Shipped). | Private AMM design + program alignment with encrypt.xyz team (~3+ weeks). |

Phase B Sui swap is flag-gated but the flag defaults on - listed under Shipped.

---

## Stubs (scaffolded, not wired)

| Feature | Where | Why | Unblocked by |
|---|---|---|---|
| `SolanaIkaAdapter` Sui-only reads | `src/background/ika/ika-adapter.ts:149-186` | `getPresignInParticularState`, `getEncryptedUserSecretKeyShare`, `getSign`, `getSignInParticularState`, `executeTx` still throw on Solana base (Sui PTB / object graph only). DKG + sign bypass the adapter and go through `SolanaIkaGrpcClient` directly. **Verified 2026-05-10** against `@ika.xyz/sdk@0.4.1` (Sui-only signatures, no Solana variant) + `@ika.xyz/pre-alpha-solana-client@0.1.1` (gRPC client exposes only `requestDKG` / `requestPresign` / `requestSign` - zero read APIs). | Ika Solana Alpha 1 (not yet shipped per upstream README disclaimer); when it lands, either upstream exposes presign/sign/encrypted-share reads over gRPC, or chromatika reads the Solana program PDAs directly via `@solana/web3.js`. |
| Switchboard price source | Listed in waterfall comments only | Explicitly dropped (`src/config/price-sources.ts`). | Remove from architecture-final.html if permanent, or implement. |

---

## Future hardening (tracked, not started)

Items listed in `WALLET_SECURITY.md` under "Roadmap (not shipped yet)" plus engineering follow-ups found in review. Items with `✅ shipped` notes have been moved to [CHANGELOG.md](CHANGELOG.md).

- **E2E coverage for core flows** - `real-onboarding-createvault.spec.ts` now exercises the full create-vault cold-SW tRPC path. Still missing: vault switch, send, dapp connect+sign, approval popup, auto-lock round-trip.
- **Upstream PRs to drop the wallet-side workarounds** - `@mysten/sui` GraphQL `getObjects` chunking is a runtime wrapper in `src/background/sui-client.ts:installGetObjectsChunking` (chunks 12 ids + 100ms delay). `@ledgerhq/live-network` is a no-op stub at `wallet-extension/stubs/ledger-live-network/` applied via `pnpm.overrides`. Both replacements are version-agnostic so package bumps no longer require patch refreshes. File issues upstream.
- **MV3 SW WASM data-URL workaround** - `vite` stays pinned at `8.0.3` exact (`8.0.9` and `8.0.10` have a separate ESM `import.meta.url` regression). Independent root issue: chromium MV3 service workers can't construct a `URL` from the multi-MB `data:application/wasm;base64,…` blob that wasm-bindgen emits as the default fallback in `@ika.xyz/sdk`. Workaround landed in `src/background/service-worker-document-shim.ts`. Drop the workaround when chromium gives MV3 SWs `URL.createObjectURL` back, OR when `@ika.xyz/sdk` ships its WASM as a separate `.wasm` asset.
- **Kiosks as a dedicated page** - currently a panel inside NftsPage; architecture-final.html implies a dedicated tab. Promote or update the architecture doc.
- **dWallet discovery (Phase 3 completion)** - full "import and reconcile all owned dWallets" beyond the incremental path.
- **Multichain funding aggregator (Phase C/D)** - beyond the Sui-only Phase B swap; tracked as a roadmap item.
- **Real x402 facilitator round-trip** - the wire format is spec-aligned per `scheme_exact_svm.md`, the signer is implemented for both ika MPC and WalletConnect paths, but no real Solana facilitator has been exercised end-to-end. Pin one (Coinbase CDP / Second State / x402-rs / etc.) and add a smoke harness.
- **Solana sendTx MCP tool (arbitrary)** - sibling of the existing `sendEvmTx`; would compose with x402 + WC paths so an agent with a WC-paired Seeker can pay arbitrary SPL transfers, not just x402 USDC. Needs a Solana approval popup with decoded-params view.
- **Non-EVM message-sign origin recording** - send-path origin recording is wired across all chains, but message-sign paths still need the same hook so drain analysis sees them.
- **MCP `signTransaction` nonce-race documentation** - if real users hit a slow-caller race, may need a "sign + reserve nonce on this account in extension state" pattern so subsequent dapp `eth_sendTransaction` calls don't claim the same nonce.

---

## Archived (not on roadmap)

- **zkLogin / OAuth-backed vault** - removed from product surface. Identity model is ika dWallet only for dapp/on-chain activity; see the root README "vault setup methods" section for the canonical setup paths (HD / imported privkey / passkey / WaaP / Lazor / Ledger / Trezor / MWA / WalletConnect).

---

## Updating this file

When you ship or drop something:
1. Update the relevant section here (move feature between Shipped / Gated / Stubs / Future / Archived as needed).
2. Append a dated entry to [CHANGELOG.md](CHANGELOG.md) with the file paths + test counts + decision rationale.
3. Remove / rewrite any "target" / "future" / "not shipped" wording elsewhere that contradicts the new state.
4. Do all of the above in the same commit as the code change.
