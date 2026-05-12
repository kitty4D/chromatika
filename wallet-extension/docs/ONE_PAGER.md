# Chromatika - one pager

## What it is

**Chromatika** is a Chrome (MV3) browser-extension wallet for **EVM, Bitcoin, Solana, Sui, and Aptos**. It runs as a side panel for the main UI and a popup for quick actions, with dapp providers injected on every page (EIP-1193 / 6963 + Wallet Standard for Solana and Sui + `window.bitcoin` + `window.aptos`).

The thing that makes Chromatika different: **your spend limits and your panic button live on-chain, not inside the extension.** Even if the Chromatika code itself gets fully compromised, an attacker cannot drain you above the daily cap you set, cannot disable the panic button, and cannot bypass the time-delayed unfreeze. The browser extension is **not** the trust boundary.

---

## The lead feature: Policy Vault

Policy Vault is a small program on Sui mainnet that owns your dWallet's signing capability. After you opt in, every signature your wallet makes has to pass through that program first. The program checks: is this under your daily cap? Are you in a cool-down? Is the panic flag off? Is the address asking to sign actually one of your registered devices? If any answer is no, the signature does not happen. Not "the wallet shows a warning." It does not happen. The validators refuse.

What that gets you in plain language:

- **Daily spend cap.** You pick a number (default $1000/day on first opt-in). The wallet cannot sign for more than that in any 24-hour window. Raising the cap is itself an on-chain transaction; turn on the optional staged-delay safety (24 hours by default) and any cap raise has to wait the delay, giving any of your other registered devices (or a friend-actuator) time to press panic during the window.
- **One-click panic.** Freezes every signature for 7 days by default (you pick the unfreeze delay). Real on-chain freeze, not a UX nag. After the delay you can unfreeze yourself.
- **Rescue address.** While the wallet is panicked, it can only sign sends to a destination you pre-registered (e.g. your Ledger). So even mid-attack you can rescue what is left to safety.
- **Friend-and-family social recovery.** Add a friend's Sui address as a panic trigger. Lost your device? They press the button for you. They can freeze your wallet; they cannot drain it.
- **Auto-panic on drain alerts** (opt-in). Chromatika publishes signed safety alerts when we detect a drain pattern hitting addresses like yours. If you opt in, your wallet will auto-panic while you're AFK.
- **Sovereign exit.** Request unwrap, wait the delay, claim. You can always extract your dWallet from Policy Vault on your own schedule. The same delay that stops an attacker from bypassing the cap also gates the exit; that is intentional and symmetric.

**Why this is only possible with Chromatika.** A traditional wallet keeps the entire private key on your device. It can sign anything, anytime, with no outside check. Chromatika's signing power is split: half lives on your device, half lives on a network of validators called Ika. Neither side can move funds alone. That split is what lets a small program on Sui mainnet gate every signature. A local-keys wallet literally cannot enforce this from on-chain.

**Auditable.** The Policy Vault Move package is published on Sui mainnet at `0x8cd25cd3ae7966b61eeae97d77b7e029b29b37307b533b505c6a76b63e22d727`. The source is in this repo at [`../move/chromatika-policy/sources/sign_gate.move`](../move/chromatika-policy/sources/sign_gate.move). If you don't trust the team-deployed cut, you can build and publish your own copy and point your install at it.

---

## One identity, every chain

Chromatika's "account" is the **dWallet**, not a separate key per chain. One dWallet drives addresses on EVM + Bitcoin + Solana + Sui + Aptos. Switching chains does not switch identities. Switching dWallets does.

- You can hold **several dWallets** in one extension (separate personas, separate spending budgets, separate Policy Vault wraps).
- The **active dWallet** is shown clearly before any connect or sign, so you know which budget you are using.
- One Chromatika vault can wrap **both a SECP256K1 and an ED25519 dWallet** (the curve covers different chains). Each wrap is its own Policy Vault with its own cap and panic state.

Today the live Ika base chain is **Sui**. Solana as an Ika base is **pre-alpha** (devnet, mock single-signer); we describe it below under "what's pre-release."

---

## What else ships

- **AI-agent surface (MCP).** Claude Desktop and other agents can ask the wallet to send transactions on your behalf. Under your daily cap, no popup. Over your cap, the on-chain program aborts. Policy Vault is the safety net that lets you give an agent budget without giving it your keys.
- **Web payments (x402).** Pages that need a small stablecoin payment can charge you with an HTTP 402; the wallet intercepts, asks for approval (or auto-pays under your per-seller and global caps), and replays the request. Receipts log every payment with status and on-chain settlement.
- **Encrypted activity** (pre-alpha, opt-in). Encrypted dWallet labels, encrypted activity notes, hidden SPL transfers via Encrypt.xyz. Lab-grade today; not on by default.
- **Safety alerts feed.** Chromatika polls a signed alert feed every 5 minutes. Critical alerts trigger Chrome notifications, auto phishing-block rules, and optionally auto-panic on your Policy Vault.
- **Hardware wallets.** Ledger (EVM, Sui, Solana, Bitcoin PSBT), Trezor (EVM, Solana, Bitcoin), Solana Seeker via QR-pair, WalletConnect v2 for any phone wallet.
- **Multi-chain breadth.** Built-in network registry plus custom networks, NFT galleries (Sui, Bitcoin Ordinals, EVM, Solana, Aptos), Sui Kiosk with listings + transfer policies, Sui to IKA swap via Aftermath, ika staking with full validator browse.
- **Privacy-aware NFTs.** MediaSafetyMode defaults to IPFS / Arweave only; an offscreen cache fetches images with `credentials: 'omit'` so NFT hosts cannot set cookies or read referer.
- **Phishing protection.** Bundled MetaMask `eth-phishing-detect` list plus a daily refetch, applied via declarativeNetRequest redirect rules.

---

## Trust signals

- **Source is open to everyone.** Full source is on GitHub under BUSL 1.1 (text at [`../../LICENSE`](../../LICENSE)). Anyone can read it, audit it, or build it from source.
- **Zero fees collected by the wallet.** No action in the wallet routes a cut to a Chromatika address. Not sending, not signing, not swapping, not staking, not x402 payments. You pay network gas and protocol fees; nothing extra.
- **On-chain pieces are auditable.** Policy Vault Move package id is published above and verifiable on Suiscan. If you would rather not trust our deployed copy, you can publish your own and point the extension at it.

---

## What's pre-release / not for real funds

- **Pre-release overall.** Chromatika has not shipped to end users. Storage and crypto schemas may break without migration; treat installs as dev or design validation, not as a finished consumer product.
- **Solana as an Ika base is pre-alpha.** Devnet only, mock single-signer, **not** real MPC. Do not sign real-value transactions on that base. (Note: sending Solana from a **Sui-base** dWallet is the normal flow and works fine; the pre-alpha caveat is only when you switch the Ika base itself to Solana for SDK exploration.)
- **Not yet on the Chrome Web Store.** You load it unpacked from a build today.

---

## Where to go deeper

- Locked UI / stack diagram: [`architecture-final.html`](architecture-final.html)
- Product rules + file map: [`../README.md`](../README.md)
- Shipped / gated / stubs / future index: [`STATUS.md`](STATUS.md)
- Policy Vault deep dive (threat model, deploy runbook, abort codes): [`POLICY_VAULT.md`](POLICY_VAULT.md)
- Terminology (dWallet vs dWallet Vault vs Chromatika vault): [`TERMINOLOGY.md`](TERMINOLOGY.md)
- Security disclosures + third-party API privacy: [`WALLET_SECURITY.md`](WALLET_SECURITY.md)
