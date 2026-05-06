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
      "EVM, Bitcoin (segwit + taproot), Solana, Sui, Aptos: different clients, same dWallet identity rule.",
    body: [
      "EVM uses ethers v6: personal_sign, typed data, and sends. Dapp eth_sendTransaction routes through an approval popup; wallet-initiated sends skip the double gate by design.",
      "Bitcoin sends use bitcoinjs-lib with segwit and taproot paths as implemented in the extension.",
      "Solana uses @solana/web3.js for sends and off-chain message signing in line with common dapp expectations.",
      "Sui uses @mysten/sui 2.x with GraphQL as the default transport for Ika-adjacent reads. JSON-RPC remains for a few legacy service paths until migrated.",
      "Aptos uses @aptos-labs/ts-sdk.",
    ],
  },
  {
    slug: "sui-personal-message-note",
    title: "Sui personal message signing (compatibility note)",
    categoryId: "chains",
    summary:
      "sui_signPersonalMessage follows ika Ed25519 + SHA512 for raw bytes, not Mysten's BLAKE2b personal-message intent.",
    body: [
      "Some dapps only verify Mysten's native PersonalMessage intent (BLake2b). Chromatika intentionally signs the ika-compatible path for personal messages today.",
      "Transaction signing uses Mysten intent + BLAKE2b via signBuiltSuiTransactionBytes as documented in STATUS.",
      "Parity work to offer BLAKE2b personal-message mode alongside ika mode may land later. Track WALLET_SECURITY.md and STATUS.md for wording updates.",
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
      "Mirror of high-level STATUS.md: vault v3, ika on Sui, multi-chain UI, swap flag, hardware surfaces.",
    body: [
      "Shipped highlights: Argon2id vault v3, ika DKG/presign/sign/re-encrypt on Sui base, presign pools per vault, phishing dNR, multi-chain clients, side panel surfaces (assets, activity, send, NFTs, dapps, ika staking, settings).",
      "Phase B Sui→IKA swap via Aftermath is implemented behind a feature flag that defaults on in tree. Still evaluate network liquidity yourself on testnets.",
      "Gated: Solana ika base dev flag, some roadmap encrypt.xyz stubs returning not_wired.",
      "Stubs: parts of SolanaIkaAdapter still throw for Sui-shaped reads; Trezor Bitcoin decomposition; offscreen media cache not present.",
      "For the living list, read wallet-extension/docs/STATUS.md in the repository.",
    ],
  },
  {
    slug: "resource-library",
    title: "guides and knowledge base on this site",
    categoryId: "start",
    summary:
      "How the themed knowledge base, user guides markdown, and tech guides markdown relate on chromatika.dev.",
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
];

export function articleBySlug(slug: string): KbArticle | undefined {
  return kbArticles.find((a) => a.slug === slug);
}

export function articlesInCategory(categoryId: KbCategoryId): KbArticle[] {
  return kbArticles.filter((a) => a.categoryId === categoryId);
}
