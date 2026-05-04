# Chromatika — one pager

## What it is

**Chromatika** is a **Chrome MV3** browser wallet (React, TypeScript, Vite). It targets **EVM, Bitcoin, Solana, Sui, and Aptos** from one surface: a **side panel** as the main UI, a **popup** for quick actions, and injected **dapp providers**: **EIP-1193 + EIP-6963**, **`window.solana` / `window.sui`** plus **Wallet Standard** (Chromatika Solana + Sui wallets), **`window.aptos`**, **`window.bitcoin`**, with **connect + permission** parity for non-EVM where implemented.

---

## What makes it different

### 1. dWallet-first identity (not “HD account per chain”)

In Chromatika, **transactions, dapp connections, signing, and the addresses users see** on supported chains are meant to trace to an **Ika dWallet** (2-party MPC coordinated with the Ika stack on **Sui** today). The wallet does **not** treat a plain mnemonic-derived “main” address per chain as the user’s canonical identity for dapps and sends.

**Plain language:** your “account” in the product sense is the **dWallet**, and that one logical account can drive **many chains** (different curves and encodings), **including Sui**, not a separate unrelated key per network.

### 2. Multiple dWallets, one extension

Users can work with **several dWallets** (separate personas or accounts). The **active dWallet** should be obvious before connect or sign, because it defines the address set dapps see.

### 3. Ika base chain: Sui today; Solana path is exploratory

**Sui** is the live path for Ika PTBs, `IkaClient`, and production-shaped flows. **Solana** as an Ika base is **pre-alpha** (devnet, mock signing in current form): **not** production MPC or custody; for SDK exploration only. Product copy and UX must not imply mainnet-grade security there.

### 4. Architecture choices that diverge from typical wallets

| Area | Chromatika |
|------|------------|
| UI ↔ background | **tRPC** over `chrome.runtime.sendMessage`, not HTTP APIs |
| Sui reads/writes | **GraphQL-first** (`SuiGraphQLClient` / `client.core.*`); JSON-RPC only where GraphQL does not cover the call yet |
| Ika + Sui | **Same** GraphQL client for vault logic and `IkaClient` so Sui transport stays consistent |
| Signing prep | **Presign pools** (ECDSA secp256k1, Taproot, Ed25519) with periodic refill for smoother Ika signing |
| NFTs / media | **MediaSafetyMode** (e.g. IPFS/Arweave-only by default) to reduce risky image loads |
| Multi-surface UI | **SharedWorker** to keep popup and side panel in sync when both are open |
| In-wallet IKA | **Sui ika system** stake / withdraw (fee-payer signing); **Solana-base** vaults see a guard message (staking is Sui-only) |
| Security extras | Local **vault** (AES-256-GCM + Argon2id RFC 9106 §4 option 2), **Ledger** + **Trezor** via WebHID / connect-web (Solana, EVM, BTC PSBT), **Solana MWA** + **WalletConnect** for phone-wallet pairing, **phishing** protection via declarative redirect rules |

### 5. Breadth without hiding the thesis

Built-in **network registry** (major L1/L2s and testnets) plus **custom networks**, **price** and **NFT** service targets, and **Sui Kiosk**-oriented features sit on top of the same rule: **on-chain-facing identity stays dWallet-backed** where the product promises it.

---

## Status

Chromatika is **pre-release**. Behavior, storage schemas, and Ika integration details may change; treat shipping assumptions as **dev and design validation**, not a finished consumer product yet.

---

## Where to go deeper

- Locked UI/stack diagram: [`architecture-final.html`](architecture-final.html)
- Product rules and file map: [`../README.md`](../README.md)
- Terms (dWallet vs dWallet Vault vs Chromatika vault): [`TERMINOLOGY.md`](TERMINOLOGY.md)
