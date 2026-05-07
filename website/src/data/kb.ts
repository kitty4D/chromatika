export type KbCategoryId = "start" | "identity" | "security" | "chains" | "hardware" | "product";

export type KbArticle = {
  slug: string;
  title: string;
  categoryId: KbCategoryId;
  summary: string;
  /** plain text blocks; first line of block starting with "- " becomes list items when rendered */
  body: string[];
};

export const kbCategories: { id: KbCategoryId; label: string; blurb: string }[] = [
  {
    id: "start",
    label: "start here",
    blurb: "what Chromatika is, how to try the build, where truth lives in the repo.",
  },
  {
    id: "identity",
    label: "identity & dWallets",
    blurb:
      "ika base chains, dWallet Vault vs dWallet vs Chromatika vault: the words users trip on.",
  },
  {
    id: "security",
    label: "security & vault",
    blurb: "encryption, session, auto-lock, and what we do not promise in pre-release.",
  },
  {
    id: "chains",
    label: "chains & dapps",
    blurb: "EVM, Bitcoin, Solana, Sui, Aptos; providers; signing quirks worth knowing.",
  },
  {
    id: "hardware",
    label: "hardware",
    blurb: "Ledger, Trezor (partial), Solana mobile wallet adapter and Seeker-style pairing.",
  },
  {
    id: "product",
    label: "status & roadmap",
    blurb: "shipped vs gated vs stubs: a friendly mirror of STATUS.md for readers.",
  },
];

export const kbArticles: KbArticle[] = [
  {
    slug: "what-is-chromatika",
    title: "what is Chromatika?",
    categoryId: "start",
    summary:
      "A pre-release Chrome MV3 wallet where your cross-chain face is ika dWallet-backed, not a pile of unrelated HD accounts.",
    body: [
      "Chromatika is a browser extension (Manifest V3) that behaves as a multi-chain wallet with a deliberate rule: transactions, dapp connections, signing, and addresses shown on supported networks trace to an ika dWallet (2PC-MPC), not a separate plain HD identity per chain.",
      "You get a local encrypted Chromatika vault (Argon2id + AES-256-GCM) that can hold multiple dWallet Vault records. Each is an owner keyring for a given ika base chain, with its own dWallets and keys.",
      "Primary UI is the side panel; the popup covers quick actions, approvals, and hardware flows. Browse user guides and tech guides from the site header, or open the knowledge base for short themed articles.",
    ],
  },
  {
    slug: "try-the-extension",
    title: "try the extension (developers)",
    categoryId: "start",
    summary: "Clone the repo, pnpm install in wallet-extension, build, load unpacked from dist/.",
    body: [
      "Chromatika is not positioned as a public Chrome Web Store drop yet. Developers load an unpacked build.",
      "From the repo root: cd wallet-extension, pnpm install, pnpm run build, then in chrome://extensions enable developer mode and Load unpacked pointing at wallet-extension/dist.",
      "pnpm test runs Vitest; pnpm run test:e2e builds and runs Playwright smoke tests. See the repo README for architecture links.",
    ],
  },
  {
    slug: "terminology-core",
    title: "terminology: dWallet Vault, dWallet, Chromatika vault",
    categoryId: "identity",
    summary: "Three layers of naming: get these right and the rest of the docs click.",
    body: [
      "Chromatika vault: the local encrypted store unlocked with your app password. It holds JSON records for multiple dWallet Vaults plus metadata.",
      "dWallet Vault: the owner wallet for a given ika base chain (Sui or Solana). It funds ika fees and owns dWallet objects on that base. Created from a new mnemonic, import paths, hardware, or dWallet-anchored flows.",
      "dWallet: the ika MPC wallet used as canonical identity for dapps and user-visible addresses on supported chains.",
      "In UX, avoid saying Vault alone. Say dWallet Vault (owner keyring) or Chromatika vault (encrypted app store) so users know which layer you mean.",
    ],
  },
  {
    slug: "ika-base-chains",
    title: "ika base chains (Sui vs Solana)",
    categoryId: "identity",
    summary:
      "Sui is the production ika path. Solana ika base is dev pre-alpha with mock signing, not custody you trust with real value.",
    body: [
      "Base chain is where ika anchors a dWallet: Sui uses object IDs; Solana uses PDAs in future-facing code.",
      "Sui: @ika.xyz/sdk, GraphQL-first Sui client shared with IkaClient. This is the path you can explore for real PTB / presign / sign flows today.",
      "Solana ika base is behind a dev flag. It uses pre-alpha grpc and mock signing. All signatures come from a single mock signer. Treat it as SDK exploration only; program data can be wiped. Never promote as production MPC.",
      "Product copy should label Solana pre-alpha surfaces clearly and avoid encouraging mainnet or real-asset reliance there.",
    ],
  },
  {
    slug: "vault-and-session",
    title: "vault encryption and session",
    categoryId: "security",
    summary:
      "Argon2id + AES-GCM vault; non-extractable CryptoKey while unlocked; session storage holds derived key bytes, not your password.",
    body: [
      "The Chromatika vault blob uses Argon2id (RFC 9106 second option style parameters) and AES-256-GCM for confidentiality and integrity of stored records.",
      "While unlocked, the background session keeps a non-extractable AES CryptoKey and KDF metadata so switching dWallet Vaults does not always re-prompt for the password.",
      "Unlock rehydrate uses chrome.storage.session for derived key material, not the plaintext password. Auto-lock ties to idle alarms and OS screen lock signals.",
      "Pre-release stance: schema and crypto may change without migrations for old installs. Clearing extension storage and re-onboarding is the recovery path when we break dev profiles.",
    ],
  },
  {
    slug: "dapp-permissions-and-phishing",
    title: "dapp permissions and phishing protection",
    categoryId: "security",
    summary:
      "Origin-scoped consent for injected providers; dynamic declarativeNetRequest rules cap out under Chrome limits.",
    body: [
      "Injected bridges validate origin and event source before forwarding wallet actions. Treat every new dapp as untrusted until the user connects.",
      "Phishing uses declarativeNetRequest with a bundled list plus periodic refresh of MetaMask eth-phishing-detect style data, capped under Chrome rule count limits.",
      "This is defense in depth, not a guarantee. Users should still verify domains and transaction details.",
    ],
  },
  {
    slug: "supported-chains",
    title: "supported chains (overview)",
    categoryId: "chains",
    summary:
      "EVM, Bitcoin (segwit + taproot), Solana, Sui, Aptos for full signing; DeSo + Cosmos + Polkadot for read-only address discovery via the activity-scan service.",
    body: [
      "EVM uses ethers v6: personal_sign, typed data, and sends. Dapp eth_sendTransaction routes through an approval popup; wallet-initiated sends skip the double gate by design.",
      "Bitcoin sends use bitcoinjs-lib with segwit and taproot paths. Trezor BTC also ships now via PSBT decomposition (P2WPKH).",
      "Solana uses @solana/web3.js for sends and off-chain message signing in line with common dapp expectations.",
      "Sui uses @mysten/sui (pinned at 2.16) with SuiGraphQLClient end to end. The wallet does not talk Mysten JSON-RPC at all anymore; NFT, kiosk, activity, SuiNS, and IkaClient all ride the single vault GraphQL transport. Hand-rolled GraphQL via client.query covers anything the SDK does not yet expose.",
      "Aptos uses @aptos-labs/ts-sdk.",
      "Read-only surfaces: DeSo, Cosmos chains (Cosmos Hub, Osmosis, Juno, Stargaze, Akash, Stride, Sei), and Polkadot show up in the activity-scan service for address discovery. Signing on those chains is not wired yet.",
    ],
  },
  {
    slug: "sui-personal-message-note",
    title: "Sui personal message signing (Mysten-standard)",
    categoryId: "chains",
    summary:
      "sui_signPersonalMessage now produces Mysten-standard signatures: PersonalMessage intent + BLAKE2b digest signed via the ika ed25519 MPC path.",
    body: [
      "Personal-message signing on Sui used to follow an ika-compatible SHA512 path that most dapps could not verify. That gap is closed: chromatika now BCS-encodes the message as vector<u8>, prepends the PersonalMessage intent prefix [3, 0, 0], BLAKE2b-256 hashes the bytes, and signs the digest via the ika ed25519 MPC path.",
      "Result: signatures round-trip byte-for-byte through @mysten/sui Ed25519Keypair.signPersonalMessage and verifyPersonalMessageSignature. Sui dapps that use verifyPersonalMessageSignature (most of them) now verify chromatika signatures natively, and the future Seal backend SessionKey flow is unblocked on the same path.",
      "Transaction signing already used Mysten intent + BLAKE2b via signBuiltSuiTransactionBytes; the personal-message path now matches. The compatibility test lives at chains/sui-personal-message.test.ts.",
    ],
  },
  {
    slug: "injected-providers",
    title: "injected providers (dapp bridge)",
    categoryId: "chains",
    summary:
      "EIP-1193 / 6963, Bitcoin window, Aptos, Solana and Sui shims plus Wallet Standard registration.",
    body: [
      "Ethereum-compatible dapps see a standards-shaped provider with chain add/switch where implemented.",
      "Solana and Sui wallet-standard style registration allows ecosystem dapps to discover Chromatika alongside other wallets.",
      "Bitcoin and Aptos entry points exist for compatible sites, always gated behind explicit user consent like other namespaces.",
    ],
  },
  {
    slug: "hardware-wallets",
    title: "hardware wallets (Ledger, Trezor, MWA)",
    categoryId: "hardware",
    summary:
      "WebHID for Ledger in extension pages; Trezor Connect iframe path; Solana mobile wallet adapter for Seeker-class devices.",
    body: [
      "Ledger uses WebHID from popup or side panel contexts, never from the service worker. Users prove addresses and sign on device rather than pasting seed material for hardware accounts.",
      "Trezor ships partial support: discovery and several signing paths; Bitcoin may still error until PSBT decomposition is finished. STATUS lists the exact gap.",
      "Solana Mobile Wallet Adapter supports local Android intents on the same phone and remote QR pairing from desktop to Seeker-class wallets. Remote flows persist auth tokens so repeat signing skips rescans until reauthorization fails.",
    ],
  },
  {
    slug: "whats-shipped",
    title: "what ships today vs gated vs stub",
    categoryId: "product",
    summary:
      "Mirror of high-level STATUS.md as of 2026-05-06: Policy Vault, safety alerts, x402, MCP, multi-vault siblings, encrypted labels.",
    body: [
      "Core shipped: Argon2id vault v3 (multi-record), per-vault dwalletMeta overlay, session AES CryptoKey (no plaintext password in RAM), auto-lock on idle + OS screen lock, declarativeNetRequest phishing list with daily MetaMask refetch.",
      "Ika on Sui base: DKG, three presign pools (SECP256K1_ECDSA, SECP256K1_TAPROOT, ED25519_EDDSA) with 5-min refill alarm, sign, re-encrypt, dynamic IKA + SUI fee pricing. IkaClient runs on the vault SuiGraphQLClient (no JSON-RPC anywhere).",
      "Multi-chain clients: ethers v6 EVM, bitcoinjs-lib BTC (segwit + taproot), @solana/web3.js Solana, @mysten/sui 2.16 with GraphQL only, @aptos-labs/ts-sdk Aptos. DeSo binary tx hard-decoded for Policy Vault.",
      "On-chain Policy Vault: opt-in spend cap + cool-down + actuators + panic + unfreeze + rescue address. Move-side hard-decoders for EVM RLP, BIP143 BTC sighash, and DeSo binary tx so the cap is enforced on chain-derived value. Solana base policy program scaffolded but the CPI approve_message is a stub awaiting ika Solana Alpha-1.",
      "Safety alerts: signed Ed25519 alert feed with publisher allowlist, auto-panic broadcast for opted-in vaults, friend-actuator unfreeze, publisher CLI for incident response.",
      "Agents (MCP): native messaging host with HTTP MCP transport on 127.0.0.1 + bearer token, --stdio-bridge for stdio clients (Claude Desktop), read tier with no popup, approve tier popup-gated, and Policy-Vault-gated no-popup mode for under-cap sends.",
      "x402 HTTP payments: window.fetch interception for HTTP 402 + PAYMENT-REQUIRED, USDC SVM exact scheme, per-counterparty + global daily caps, receipts capped at 200 with thumbs-up/down quality flag.",
      "Multi-vault siblings + activity scan: ikaEncryptionIndex for passkey, lazor, waap, and seeker so the same identity can hold multiple sibling vaults; FindMoreAccountsPanel runs scans and offers inline sibling-add. Encrypted dWallet labels with opt-in plaintext cache + auto-rebuild after devnet wipe. DirectEd25519 cross-recipient envelope (HD-derived X25519 inbox key).",
      "Hardware: Ledger via WebHID (EVM, Sui, Solana, BTC PSBT), Trezor for EVM + Solana + Bitcoin (BIP84 P2WPKH via PSBT decomposition), Solana MWA local on Android, WalletConnect v2 as the canonical Solana hardware path on desktop. MWA-remote is default off in prod (VITE_ENABLE_MWA_REMOTE=false) until the public reflector firms up.",
      "Phase B Sui to IKA swap via Aftermath router lives behind VITE_PHASE_B_SUI_SWAP (default on in tree). Evaluate testnet liquidity yourself; falls back to manual-funding messaging if liquidity is thin.",
      "Gated: Solana ika base behind a dev flag, devnet only, mock signing, do not present as production custody. Encrypt.xyz integration is pre-alpha lab-grade and not for secrets.",
      "For the living list with all the per-feature detail, read wallet-extension/docs/STATUS.md in the repository.",
    ],
  },
  {
    slug: "resource-library",
    title: "guides and knowledge base on this site",
    categoryId: "start",
    summary:
      "How the themed knowledge base, user guides markdown, and tech guides markdown relate on www.chromatika.xyz.",
    body: [
      "The knowledge base (/knowledge-base and /article/* / /category/*) collects short themed articles: start here, identity, vault security, chains, hardware, and product status.",
      "User guides render from markdown under website/src/library/user-guides/ at /library/user/*. They are exhaustive, task-first reference.",
      "Tech guides render from website/src/library/tech-guides/ at /library/tech/*. They document implementation shapes: crypto, ika, chrome APIs, and integrations.",
      "After editing library markdown locally, run pnpm run sync:library from the website package so sibling links keep mapping to routes. When anything disagrees with wallet-extension/docs/, trust the repo.",
    ],
  },
  {
    slug: "getting-help",
    title: "source docs and help",
    categoryId: "start",
    summary: "Where to read next once you leave this marketing-safe summary.",
    body: [
      "Repository: github.com context from your checkout: README.md (root), wallet-extension/README.md (wallet detail), wallet-extension/docs/STATUS.md (truth index).",
      "Terminology: wallet-extension/docs/TERMINOLOGY.md. Security practices and roadmap gaps: wallet-extension/docs/WALLET_SECURITY.md.",
      "Multi-dWallet Vault phases: wallet-extension/docs/DWALLET_VAULT_MODEL.md. Architecture diagram: wallet-extension/docs/architecture-final.html.",
      "This website summarizes for humans; use the nav for user guides, tech guides, and the knowledge base. When docs disagree, the docs folder in the repo wins.",
    ],
  },
  {
    slug: "dwallet-lifecycle",
    title: "creating and signing with dWallets",
    categoryId: "identity",
    summary:
      "DKG creates an ika MPC dWallet; presign pools keep signs feeling instant; dynamic fee pricing keeps coin splits honest.",
    body: [
      "Distributed key generation (DKG) creates a new ika dWallet on the active base chain. Chromatika holds a non-extractable user share locally and the network holds an encrypted copy on chain; together they form a 2PC-MPC keypair where neither side ever sees the full secret.",
      "Three presign pools live per vault: SECP256K1_ECDSA (the default for EVM and BTC ECDSA), SECP256K1_TAPROOT (for taproot Schnorr), and ED25519_EDDSA. A 5-minute alarm refills the pools when locked state allows. Warm presigns are why a routine sign feels instant rather than waiting on a fresh round trip.",
      "Solana ika base is different: Ed25519 is deterministic per RFC 8032 and the pre-alpha gRPC presign endpoint is gated to imported ECDSA, so chromatika does a one-shot Presign per Sign rather than pooling. Sign is still required; skipping it surfaces as a misleading 'no key for dwallet' error.",
      "Dynamic IKA + SUI fee pricing through getRequiredCoinAmounts queries the on-chain pricing map and adds a small buffer, so coin splits never under-pay and trigger an abort. After a fresh DKG, accept-share zero-trust verifies the encrypted user share before the dWallet is marked usable.",
      "For depth: see the create-dwallet and presign-pool user guides, and the ika-dkg-flow tech guide.",
    ],
  },
  {
    slug: "multi-vault-siblings",
    title: "multi-vault siblings and account discovery",
    categoryId: "identity",
    summary:
      "Re-onboarding the same identity makes sibling vaults; activity scan finds dWallets you already created on chain.",
    body: [
      "When you re-onboard the same identity (passkey, lazor, waap, seeker, or HD mnemonic), chromatika produces sibling vaults at incrementing ikaEncryptionIndex rather than overwriting your earlier one. Each sibling is a different ika encryption key derived from the same root credential, so each can own its own dWallets without colliding with the others.",
      "The activity-scan service surveys default chains (Sui mainnet, Solana mainnet + devnet) for any address tied to your identity, with a super-pro picker that adds an EVM long-tail (zkSync, Linea, Scroll, Blast, Mantle, and friends), Bitcoin, Aptos, DeSo, Cosmos chains, and Polkadot. A reinstall on a new device that re-pairs the same Seeker or passkey will rediscover the dWallets you already created.",
      "dwalletInventoryForActiveVault annotates each owned cap with matchedVaultId, matchedVaultLabel, and matchedIkaIndex, or marks it as an orphan when no local sibling claims it. FindMoreAccountsPanel in Settings runs the scan and offers inline sibling-add flows so you do not have to leave the wallet UI.",
      "HD mnemonic vaults get a paste-phrase + multi-account batch import path inline. Pick the BIP44 account indices you actually want from one phrase rather than re-importing N times.",
      "For depth: see the find-more-accounts and multi-vault-siblings user guides, and the scan-service-architecture tech guide.",
    ],
  },
  {
    slug: "policy-vault",
    title: "Policy Vault: spend caps, panic, unfreeze, rescue",
    categoryId: "security",
    summary:
      "Opt-in on-chain spending policy for a dWallet: daily cap, cool-down, actuator allowlist, panic + unfreeze, rescue address, and Move-side hard-decoders.",
    body: [
      "PolicyVault is an opt-in Move package on Sui that wraps a dWallet's signing authority. Once wrapped, every sign is gated by daily cap (in micro-USD), cool-down, actuator allowlist, and panic state before the chain produces a signature. Even if your browser, host, or extension worker is fully owned, the attacker is bounded by what you wrote on chain.",
      "Panic + unfreeze: any actuator can flip the panic switch, which freezes the vault for at least your pre-set unfreeze delay (chromatika defaults to 7 days, you can pick anything). A rescue address gives you a one-shot drain to a hardware-only destination while panicked, so even a hostile insider cannot redirect residuals.",
      "Staged cap-raises (opt-in): cap raises wait stage_delay_ms (default 24h) before applying, while cap decreases stay immediate. Symmetrically, turning staging off is itself staged so an attacker who flipped it on cannot disarm and drain in the same window.",
      "Hard-decoders on Sui base: Move parses RLP for EVM (legacy + 1559 + 2930), BIP143 sighash for BTC, and the v0 binary tx layout for DeSo. The cap is enforced on chain-derived value, not whatever chromatika claims off chain. Hard on value, soft on price; the caller-supplied price is emitted on chain via a Decoded event so any lie is forensically detectable.",
      "Solana base policy program is scaffolded today (Anchor 0.30), with full storage + state + 12 instructions, but the on-chain do_approve_message_cpi is a stub awaiting ika Solana Alpha-1. Treat that path as structural plumbing only; do not present it as production custody.",
      "For depth: see the policy-vault user guide and the policy-vault tech guide.",
    ],
  },
  {
    slug: "safety-alerts",
    title: "signed safety alerts and panic broadcast",
    categoryId: "security",
    summary:
      "Chromatika polls a signed Ed25519 alert feed; opted-in vaults can auto-panic; friend actuators can unfreeze.",
    body: [
      "Chromatika polls a signed alert feed on a slow alarm. Each alert is Ed25519-signed by a publisher on the publisher allowlist, and can target specific dWallets by id or globally raise the room temperature for a class of incident.",
      "Auto-panic: when an alert references a vault you have explicitly opted in for, the service worker signs a panic PTB on the linked PolicyVault and the wallet shows a banner with the panic state and your unfreeze countdown. You always preview before opting any vault in to auto-panic.",
      "Friend-actuator unfreeze: any address on the actuator list of the PolicyVault can unfreeze after the delay elapses, even if your primary device is compromised. Combine that with the staged cap-raises and a rescue address for a serious self-custody safety net.",
      "Operationally, the publisher CLI at scripts/publish-alert.mjs supports sign --panic-targets for targeted broadcasts and a dev-only sample-panic for local round-trip testing. Runbook in docs/SAFETY_ALERTS.md.",
      "For depth: see the safety-alerts user guide and the alerts-poller-and-actions tech guide.",
    ],
  },
  {
    slug: "encrypted-notes-and-labels",
    title: "encrypted activity notes and dWallet labels",
    categoryId: "security",
    summary:
      "DirectEd25519 cross-recipient envelope for activity notes; pre-alpha lab-grade encrypt.xyz for dWallet labels with auto-rebuild after devnet wipe.",
    body: [
      "Activity notes use the DirectEd25519 cross-recipient envelope: an HD-derived X25519 inbox key per identity (domain-separated from the ika seed so the two cannot collide), ECDH against the recipient's inbox pubkey, HKDF-SHA256, and AES-GCM-256. Inline body up to 8 KiB; larger payloads pair with walrus. Determinism survives reinstall when the underlying credential is deterministic.",
      "dWallet labels use the pre-alpha encrypt.xyz integration as lab-grade encryption. The upstream disclaimer is explicit: this is NOT for secrets, network data may be wiped at any time, and the trust model is not final. Chromatika treats it accordingly.",
      "Auto-rebuild after devnet wipe: opt in via a per-label toggle to cache the plaintext locally inside the encrypted vault blob. When the on-chain status flips to 'missing' (the typical post-wipe state), chromatika re-runs encrypt and rotates the ciphertext identifier in place rather than making you clear and start over. The toggle is OFF by default, since the strictest-posture user wants no plaintext on disk.",
      "Encryption Lab page exposes raw encrypt + decrypt + read-ciphertext flows for SDK exploration. The mainnet posture for any of this is wait-for-Alpha-1.",
      "For depth: see the activity-notes, encrypted-dwallet-labels, and encryption-lab user guides.",
    ],
  },
  {
    slug: "x402-payments",
    title: "x402 HTTP payments",
    categoryId: "chains",
    summary:
      "Wallet wraps window.fetch and routes HTTP 402 + PAYMENT-REQUIRED through an approval popup, capped per counterparty and globally.",
    body: [
      "x402 is the HTTP 402 + PAYMENT-REQUIRED flow for paying APIs and content. Chromatika's content script wraps window.fetch on every page so any 402 response is auto-routed to the wallet's approval popup, signed (USDC SVM exact scheme), and the page-side fetch retries transparently with a PAYMENT-SIGNATURE header.",
      "Two signing paths share the build: ika MPC by default, and WalletConnect-relayed Solana for users on Seeker, Phantom, or Solflare. The dispatcher picks based on whether the active session has a Solana WalletConnect account.",
      "Caps gate every payment. A per-counterparty daily cap and a global daily cap (USD per day, local-timezone bucketed) live alongside per-receipt thumbs-up / thumbs-down quality flags. Receipts are capped at the 200 most recent and log status (pending, settled, failed, rejected) plus the on-chain settlement digest.",
      "Settlement is fire-and-forget after the page sees the response. Cancel and reject states are logged; the page retry simply does not complete. Override your caps from Settings -> Payments before relaxing them.",
      "For depth: see the x402-payments user guide and the x402-caps-receipts tech guide.",
    ],
  },
  {
    slug: "sui-ika-swap",
    title: "Sui to IKA swap (Aftermath)",
    categoryId: "chains",
    summary:
      "Phase B in-app swap routes Sui to IKA via Aftermath's REST router; degrades to manual funding when liquidity is thin.",
    body: [
      "The SwapCard at the top of the wallet shell calls Aftermath's REST router (/router/trade/route + /router/trade/transaction). Zero new npm deps; the wallet just fetch'es route + transaction bytes, deserialises the Transaction, and signs with the dWallet Vault's Sui keypair via the existing ika Sui flow.",
      "Defaults live in swap-config.ts: MIN_SUI_RESERVE_MIST = 50_000_000n leaves enough SUI for gas, DEFAULT_SLIPPAGE_BPS = 100 (1%) is the starting slippage, and QUOTE_CACHE_TTL_MS = 30_000 keeps quote refreshes from spamming the router.",
      "Feature-flagged behind VITE_PHASE_B_SUI_SWAP, default true in tree. Evaluate testnet liquidity yourself before relying on it. If Aftermath is down or the IKA pool is shallow on testnet, the SwapCard degrades cleanly to manual-funding messaging rather than executing a bad route.",
      "tRPC procedures: swapStatus shows current pool depth + cached quote, swapQuote refreshes the route, executeSwap signs and submits.",
      "For depth: see the sui-ika-swap user guide and the aftermath-router tech guide.",
    ],
  },
  {
    slug: "walletconnect-and-seeker-remote",
    title: "WalletConnect and Seeker remote pairing",
    categoryId: "hardware",
    summary:
      "WalletConnect v2 is the canonical Solana hardware path on desktop today; Seeker remote MWA pairs over a public reflector with persisted auth tokens.",
    body: [
      "WalletConnect v2 is the canonical Solana hardware path on desktop today. It is more stable than MWA-remote in production right now, which is why VITE_ENABLE_MWA_REMOTE defaults to false in prod builds: WalletConnect handles Seeker, Phantom, Solflare, and other WC-compatible Solana wallets through the same shared session.",
      "Seeker remote MWA (when enabled) opens wss://reflect.solanamobile.com from the side panel or popup. It cannot run inside the service worker because the underlying lib touches window.btoa and atob; chromatika dispatches accordingly. You scan the association URL on your Seeker, approve in Seed Vault, and the persisted auth_token + reflectorHost let every subsequent sign reauthorize without rescanning the QR.",
      "Because Seed Vault never exposes secret bytes, MWA + Solana base vaults derive an in-extension Solana fee-payer keypair deterministically from the wallet's signature over IKA_USK_DERIVATION_MESSAGE at index 1. Same Seeker on any device produces the same fee-payer address, so SOL persists across reinstalls.",
      "The Solana base ika seed comes from the same wallet signature at index 0. Ed25519 RFC 8032 determinism gives reinstall-safe key recovery without a phrase: same Seeker, same dWallet, on a fresh chromatika install.",
      "For depth: see the walletconnect and seeker-remote user guides, and the mwa-remote-qr-pairing tech guide.",
    ],
  },
  {
    slug: "agents-and-mcp",
    title: "agents (MCP) and the native messaging host",
    categoryId: "product",
    summary:
      "Chromatika's MCP surface lets agents read wallet state and request signed actions through chrome native messaging, with popup approvals for anything that signs.",
    body: [
      "Chromatika ships an MCP (Model Context Protocol) surface so agents like Claude Desktop, Cursor, or Cline can read wallet state and request signed actions. The bridge runs through wallet-extension/native-host/chromatika-mcp-host.mjs, a zero-deps Node script that hosts an HTTP MCP transport on 127.0.0.1:<port> with bearer-token auth. A --stdio-bridge mode forwards line-delimited JSON-RPC for stdio-only clients.",
      "Setup once per OS: pnpm setup:native-host --extension-id=<id> writes the per-OS native messaging directory entry (and on Windows a .bat shim + reg add). Optionally pin a fixed listen port (1024-65535) so Claude Desktop's config does not churn across chrome restarts.",
      "Read tier (no popup): listVaults, getActiveVault, getActiveNetworks, getLockState. These wrap existing wallet-service and network-registry APIs and respect lock state.",
      "Approve tier (popup-gated): signMessage opens an approval popup for ika MPC message signing, sendEvmTx routes through the existing approval popup with full gas + simulation UI before broadcast, and signTransaction signs without broadcast for relayer / bundler / abstract-wallet flows.",
      "Policy-Vault-gated no-popup mode: when the active vault has a PolicyVault link, the request is under-cap, not panicked, and not in cool-down, the popup is skipped and the chain enforces the cap directly. signTransaction (sign-only EVM) intentionally never skips the popup, because sign-without-broadcast is a more deliberate operation.",
      "For depth: see the agent-surface-mcp user guide and the mcp-protocol-overview tech guide.",
    ],
  },
];

export function articleBySlug(slug: string): KbArticle | undefined {
  return kbArticles.find((a) => a.slug === slug);
}

export function articlesInCategory(categoryId: KbCategoryId): KbArticle[] {
  return kbArticles.filter((a) => a.categoryId === categoryId);
}
