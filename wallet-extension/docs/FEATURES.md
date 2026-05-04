# chromatika features and positioning

Single-page product summary and feature list (shipped, gated, planned). Authoritative status detail stays in [STATUS.md](STATUS.md). Terminology: [TERMINOLOGY.md](TERMINOLOGY.md). Vault roadmap: [DWALLET_VAULT_MODEL.md](DWALLET_VAULT_MODEL.md). Security: [WALLET_SECURITY.md](WALLET_SECURITY.md).

**Vault KDF for external copy:** use Argon2id + AES-256-GCM (see STATUS + WALLET_SECURITY). Older docs may still mention PBKDF2; prefer this file + STATUS for accuracy.

---

## 500-character description

**490 characters (UTF-8, verified).** Usable for store blurbs, decks, and short intro slots (under typical 500-char limits).

```
Chromatika is a pre-release Chrome MV3 wallet: user-facing chain identity is Ika dWallet–backed (MPC on Sui; Solana ika is dev pre-alpha, mock signing only). One extension: side panel + popup, Argon2id+AES vault, multi dWallet Vault records, tRPC to the service worker, EVM/BTC/SOL/Sui/Aptos, EIP-1193/Wallet Standard/Bitcoin/Aptos injection, Ledger, Trezor (partial), Solana MWA, NFTs, Sui Kiosk, Sui→IKA swap, price feeds, phishing DNR. Not on Chrome Web Store. GraphQL-first Sui for ika.
```

**Shorter option (~280 characters)** if the platform is stricter:

```
Pre-release Chrome extension wallet: Ika dWallets (Sui MPC) as canonical cross-chain identity; EVM, BTC, SOL, Sui, Aptos; dapp providers; hardware; NFTs, Kiosk, swap, phishing block. Dev-only. Solana ika = pre-alpha.
```

---

## one-page description

**What it is:** Chromatika is a **browser extension (Manifest V3)** that acts as a **multi-chain crypto wallet** with a deliberate identity rule: **transactions, dapp connections, signing, and addresses shown to users on supported networks trace to an Ika dWallet** (2PC-MPC), not a separate “plain HD” account as the user’s canonical on-chain face. A **local encrypted “Chromatika vault”** (Argon2id + AES-256-GCM) holds one or more **dWallet Vaults** (owner keyring per ika base chain); each holds **dWallets** (MPC) and multi-chain public material.

**Ika and base chains:** **Sui** is the production Ika path (`@ika.xyz/sdk`, GraphQL-first Sui client). **Solana** as ika base is **gated** (`VITE_SOLANA_IKA_BASE`); it uses pre-alpha **mock** signing and devnet gRPC, not real MPC, until upstream ships Alpha. Pre-alpha disclaimers surface in the root README and on every Solana ika UI surface; do not submit real-value transactions on this stack.

**UI and architecture:** **Side panel** is the primary surface; **popup** handles quick actions, approvals, and hardware UIs. **tRPC** over extension messaging talks to a **background service worker** that holds the vault, keyring, Ika client, **presign pools** (secp and ed25519 families), per-chain clients, and services. **Content script** injects **EIP-1193 / 6963**, `window.bitcoin`, `window.solana` / Sui / Aptos shims, with origin-validated messaging. **SharedWorker** syncs popup and side panel when both are open.

**Chains and capabilities:** **EVM** (ethers v6, typed data and tx signing), **Bitcoin** (segwit/taproot), **Solana**, **Sui** (GraphQL; `IkaTransaction` for ika flows), **Aptos**. **Data:** configurable **price waterfall** (CoinGecko, DefiLlama, optional CMC, Pyth, Chainlink, GeckoTerminal for IKA), **multi-chain NFT** (keys optional for EVM/SOL richness), **Sui Kiosk** via Mysten’s kiosk client, **MediaSafetyMode** for remote images. **Phishing** uses **declarativeNetRequest** and MetaMask’s list. **Phase B** **Sui→IKA** swap via Aftermath is feature-flagged, default on.

**Hardware:** **Ledger** (WebHID in extension pages, Sui + EVM + Solana + BTC PSBT), **Trezor** (Solana + EVM + BTC PSBT via `@trezor/connect-web`; no Sui app), **Solana MWA** (local Android intent + remote QR pair, off-by-default in prod), **WalletConnect v2** for Solana relay-session pairing (canonical desktop solana hardware path today). **zkLogin** is **out of scope** (removed from product surface).

**Status:** **Pre-release**; no public Chrome Web Store build implied by docs. **STATUS.md** is the index for **shipped / gated / stubs / future**.

---

## feature list (shipped, gated, planned)

### core wallet and security

- **Shipped:** multi-record encrypted vault (v3), **Argon2id** + **AES-GCM**; session with non-extractable key material; **auto-lock** (idle/alarms, OS screen lock); unlock rehydrate via **session** storage (no password persisted).
- **Planned / roadmap** (WALLET_SECURITY.md + STATUS): optional **Mysten BLAKE2b** path for Sui `signPersonalMessage` **alongside** current ika Ed25519+SHA512 behavior; **offscreen** media cache (manifest TBD); migrate **Sui activity** off JSON-RPC when GraphQL list APIs exist.

### ika / dWallets

- **Shipped:** DKG, presign pools, sign, re-encrypt; **SuiGraphQLClient** for Ika; dynamic ika coin pricing; per-vault presign storage and refill alarm.
- **Gated:** **Solana ika base** (devflag): DKG and signing over gRPC; **not** production MPC.
- **Planned:** full **dWallet discovery** on import/refresh (Phase 3 in DWALLET_VAULT_MODEL.md); **nested dWallet tree UX** (Phase 6; future direction, not currently scheduled).

### chains and dapps

- **Shipped:** EVM send + dapp `eth_sendTransaction` with approval UI; wallet-UI send without double approval; BTC sends; Solana send + message signing; Sui tx + `signBuiltSuiTransactionBytes` / personal message (compatibility note on BLAKE2b); Aptos.
- **Planned / stubs:** **SolanaIkaAdapter** Sui-only read methods still throw on Solana base; **Trezor Bitcoin** decomposition; **Switchboard** price source (dropped in config unless revived).

### UI surfaces (shipped, per STATUS)

- Assets, Activity, Send, Portfolio, DWallet portfolio, NFTs, DApps, Ika staking, network selector, settings, vault/dWallet management, ChromaLab (dev), Wallet; Kiosk as **panel inside NFTs** (STATUS notes promoting to a dedicated page as future follow-up to architecture doc).

### data and integrations

- **Shipped:** price waterfall + cache; NFT pipeline across chains (with API keys for some providers); Sui Kiosk; Phase B Sui→IKA swap (flag, default on).
- **Gated / roadmap stubs:** **Encrypt.xyz** SPL deposit, PC-Token, PC-Swap (tRPC `not_wired` stubs).
- **Planned (roadmap):** **multichain funding** beyond Phase B (Phases C/D); optional **ika dWallet explorer**.

### engineering / tooling (shipped)

- Vitest, Playwright e2e, ESLint, CI; STATUS lists **e2E gaps** (vault switch, send, dapp connect, approval popup) as future coverage.

### explicitly not on the roadmap

- **zkLogin / OAuth vault** (archived; identity is dWallet-based per product rules).

---

## sources

- [STATUS.md](STATUS.md) — shipped / gated / stubs / future hardening
- [WALLET_SECURITY.md](WALLET_SECURITY.md) — storage, dapp signing notes, roadmap hardening
- [DWALLET_VAULT_MODEL.md](DWALLET_VAULT_MODEL.md) — multi–dWallet Vault phases
