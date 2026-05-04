/** home page: chain marks, foundation links, carousel slides (marketing copy).
 *  logos are copied from `wallet-extension/public/logos` (+ ika.svg from extension public). */

export type ChainMark = {
  id: string;
  name: string;
  iconSrc: string;
};

export const homeChains: ChainMark[] = [
  { id: "btc", name: "Bitcoin", iconSrc: "/logos/btc.svg" },
  { id: "evm", name: "EVM", iconSrc: "/logos/eth.svg" },
  { id: "sol", name: "Solana", iconSrc: "/logos/sol.svg" },
  { id: "sui", name: "Sui", iconSrc: "/logos/sui.svg" },
  { id: "apt", name: "Aptos", iconSrc: "/logos/apt.svg" },
];

export type FoundationTech = {
  id: string;
  label: string;
  href: string;
  iconSrc: string;
};

export const homeFoundationTech: FoundationTech[] = [
  {
    id: "ika",
    label: "ika",
    href: "https://www.ika.xyz/",
    iconSrc: "/logos/ika.svg",
  },
  {
    id: "encrypt",
    label: "encrypt",
    href: "https://github.com/dwallet-labs/ika/blob/main/docs/content/docs/sdk/cryptography.mdx",
    iconSrc: "/logos/encrypt.svg",
  },
  {
    id: "solana",
    label: "solana",
    href: "https://solana.com/",
    iconSrc: "/logos/sol.svg",
  },
  { id: "sui", label: "sui", href: "https://sui.io/", iconSrc: "/logos/sui.svg" },
];

export type TechCarouselExternalLink = {
  label: string;
  href: string;
};

export type TechCarouselSlide = {
  id: string;
  title: string;
  /** first paragraph: who they are, vendor-flavored, enthusiastic */
  intro: string;
  /** paragraph under "how we use it" */
  howWeUse: string;
  howWeUseBullets?: string[];
  links: TechCarouselExternalLink[];
  /** from extension `public/logos` (synced to `website/public/logos`) */
  logoSrc?: string;
};

export const homeTechCarouselSlides: TechCarouselSlide[] = [
  {
    id: "ika",
    title: "ika",
    logoSrc: "/logos/ika.svg",
    intro:
      "ika is building the coordination layer for programmable distributed signing: a network and tooling stack that turns dWallets into first-class identities you can actually ship in products. the mission is auditable cryptography, real cross-chain reach, and UX that does not ask end users to become protocol archaeologists.",
    howWeUse:
      "Chromatika routes dWallet creation, presign pools, ika-priced PTBs, and cross-chain signing through the Sui-base ika SDK path production uses today. we treat the coordinator, pricing tables, and user-share flows as the source of truth for anything that touches your vault's MPC identity.",
    howWeUseBullets: [
      "DKG, accept-share, presign refill, and sign / re-encrypt PTBs share one client stack with the wallet vault.",
      "Solana ika base stays behind the pre-alpha gate: mock signing only, never sold as production custody.",
    ],
    links: [
      { label: "ika.xyz", href: "https://www.ika.xyz/" },
      { label: "github", href: "https://github.com/dwallet-labs/ika" },
      { label: "sdk docs (book)", href: "https://github.com/dwallet-labs/ika/tree/main/docs/content/docs" },
      { label: "x / ika", href: "https://x.com/ikadotxyz" },
    ],
  },
  {
    id: "encrypt",
    title: "encrypt",
    logoSrc: "/logos/encrypt.svg",
    intro:
      "Encrypt names the public cryptography story beside ika: documented ciphersuites, signature normalization, and user-share handling so MPC wallets stay interoperable instead of vibes-based. it is the reference for how bytes get hashed, wrapped, and verified when dWallets touch ed25519-class curves and personal payloads.",
    howWeUse:
      "we follow ika's published Ed25519 + SHA-512 personal-message path for `sui_signPersonalMessage` style bytes, not Mysten's BLAKE2b intent, and we lean on the same spec when reasoning about user share encryption and completed signature parsing.",
    howWeUseBullets: [
      "`parseSignatureFromSignOutput` and curve / algorithm mapping stay aligned with ika's cryptography chapter.",
      "dapps that assume Mysten-native personal-message verification need a compatibility conversation; the wallet documents the gap on purpose.",
    ],
    links: [
      { label: "cryptography.mdx", href: "https://github.com/dwallet-labs/ika/blob/main/docs/content/docs/sdk/cryptography.mdx" },
      { label: "ika repo", href: "https://github.com/dwallet-labs/ika" },
      { label: "ika.xyz", href: "https://www.ika.xyz/" },
      { label: "x / encrypt", href: "https://x.com/encrypt_xyz" },
    ],
  },
  {
    id: "lazorkit",
    title: "LazorKit",
    logoSrc: "/logos/lazorkit.svg",
    intro:
      "LazorKit is Solana's passkey-native smart-wallet execution layer: WebAuthn on the front, program-owned accounts on chain, and a developer SDK that treats seed-phrase anxiety as a bug. they aim to make \"sign in like a normal app\" the default for Solana dapps that still want programmable custody.",
    howWeUse:
      "Chromatika watches LazorKit the same way we watch Seeker and MWA: as the template for device-bound Solana auth without pasting secrets through the clipboard. onboarding flows and hardware metaphors on Solana ika base borrow language and expectations from their UX.",
    howWeUseBullets: [
      "Choose-step entry on Solana surfaces Lazor-style passkey paths beside Seeker pairing.",
      "when Solana-base ika grows real MPC, we expect passkey-anchored vault stories to interlock with these account models, not fight them.",
    ],
    links: [
      { label: "lazorkit.com", href: "https://www.lazorkit.com/" },
      { label: "docs", href: "https://docs.lazorkit.com/" },
      { label: "github org", href: "https://github.com/lazor-kit" },
      { label: "x", href: "https://x.com/lazorkit" },
    ],
  },
  {
    id: "sui-passkeys",
    title: "Sui + passkeys",
    logoSrc: "/logos/sui.svg",
    intro:
      "Sui is Mysten's horizontally scaled Layer 1 for digital asset ownership: object-centric storage, Move for safer resource logic, and tooling (including GraphQL-first data planes) built for apps that need honest throughput without bespoke indexer hacks. passkeys and sponsor-ready flows are first-class topics on their product roadmap, not an aftermarket patch.",
    howWeUse:
      "production ika today is Sui-base: GraphQL core APIs feed vault reads, ika PTBs ride Mysten transactions, and Enoki-class passkey stories are on our radar wherever Mysten ships wallet infrastructure we can align with.",
    howWeUseBullets: [
      "`SuiGraphQLClient` is the default transport anywhere core covers the read (JSON-RPC only for legacy gaps).",
      "dWallet objects, caps, and ika-priced splits stay expressed as Move calls the wallet simulates with the same client you use in their docs.",
    ],
    links: [
      { label: "sui.io", href: "https://sui.io/" },
      { label: "build hub", href: "https://sui.io/build" },
      { label: "docs", href: "https://docs.sui.io/" },
      { label: "github / Mysten", href: "https://github.com/MystenLabs/sui" },
      { label: "x", href: "https://x.com/SuiNetwork" },
    ],
  },
  {
    id: "seeker",
    title: "Solana Seeker",
    logoSrc: "/logos/skr.svg",
    intro:
      "Seeker is Solana Mobile's flagship hardware wallet phone: a pocket-sized Solana node with secure UI, travel-ready signing, and tight integration with the mobile wallet adapter stack. it is meant to feel like a premium consumer device, not a dev board duct-taped to Ledger principles.",
    howWeUse:
      "remote mobile-wallet adapter pairing lets Chromatika on desktop complete MWA sessions through Solana Mobile's reflector wire while Seeker (or any compatible wallet) holds the keys. chromatika persists reauthorization tokens so repeat signing skips QR gymnastics until the phone revokes trust.",
    howWeUseBullets: [
      "pairing signs a fixed derivation message so ika user-share seeds stay deterministic per device without exporting an HD mnemonic from the phone.",
      "local Android `solana-wallet://` intents remain the sibling path when extension and wallet share one device.",
    ],
    links: [
      { label: "solana mobile", href: "https://solanamobile.com/" },
      { label: "Seeker", href: "https://solanamobile.com/seeker" },
      { label: "docs", href: "https://docs.solanamobile.com/" },
      { label: "github / SDK", href: "https://github.com/solana-mobile/mobile-wallet-adapter" },
      { label: "x", href: "https://x.com/solanamobile" },
    ],
  },
  {
    id: "waap",
    title: "WaaP",
    logoSrc: "/logos/WaaP.svg",
    intro:
      "WaaP is wallet as a protocol from the human.tech stack: one-click sign-on, trustless account recovery, and a product surface aimed toward borderless finance and identity. it sits with Human Passport and Human Network as open ecosystem infrastructure for keys, sessions, and identity.",
    howWeUse:
      "Chromatika offers WaaP as a sign-on path when you create a vault: you can open a new encrypted vault through WaaP instead of relying only on a seed phrase, key import, or hardware onboarding.",
    howWeUseBullets: [
      "WaaP is an auth entry point into vault creation, not a replacement for Chromatika's local vault encryption or ika dWallet flows after you are in.",
    ],
    links: [
      { label: "waap.xyz", href: "https://waap.xyz/" },
      { label: "human.tech docs", href: "https://docs.human.tech/" },
      { label: "x / Waapxyz", href: "https://x.com/WaaPxyz" },
    ],
  },
];
