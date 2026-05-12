/** home page: chain marks, carousel slides (marketing copy).
 * logos are copied from `wallet-extension/public/logos` (+ ika.svg from extension public). */

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
  /** internal `/library/...` route for "learn more" CTA, rendered as SPA Link */
  guideHref?: string;
  /** from extension `public/logos` (synced to `website/public/logos`) */
  logoSrc?: string;
};

export const homeTechCarouselSlides: TechCarouselSlide[] = [
  {
    id: "ika",
    title: "ika",
    logoSrc: "/logos/ika.svg",
    intro:
      "ika is the coordination layer for distributed signing - it turns dWallets into first-class identities so apps get auditable cryptography and real cross-chain reach without exposing protocol plumbing to end users.",
    howWeUse:
      "chromatika's dWallets run through ika end-to-end - DKG, presign refill, ika-priced PTBs, and cross-chain signing all use the Sui-base ika SDK that production uses today.",
    howWeUseBullets: [
      "Solana ika base is wired up but stays behind the pre-alpha gate: mock signing only, never sold as production custody.",
    ],
    guideHref: "/library/tech/ika-seed-derivation-overview",
    links: [
      { label: "ika.xyz", href: "https://www.ika.xyz/" },
      { label: "github", href: "https://github.com/dwallet-labs/ika" },
      { label: "x / ika", href: "https://x.com/ikadotxyz" },
    ],
  },
  {
    id: "encrypt",
    title: "encrypt",
    logoSrc: "/logos/encrypt.svg",
    intro:
      "encrypt is the cryptography reference next to ika - documented ciphersuites and signature-handling rules so MPC wallets stay interoperable instead of vibes-based.",
    howWeUse:
      "chromatika follows encrypt's curve, hash, and signature-parsing spec wherever ika dWallets touch personal-message bytes or user-share encryption.",
    guideHref: "/library/tech/encrypt-pre-alpha-overview",
    links: [
      { label: "encrypt.xyz", href: "https://www.encrypt.xyz/" },
      { label: "encrypt repo", href: "https://github.com/dwallet-labs/encrypt-pre-alpha" },
      { label: "x / encrypt", href: "https://x.com/encrypt_xyz" },
    ],
  },
  {
    id: "lazorkit",
    title: "LazorKit",
    logoSrc: "/logos/lazorkit.svg",
    intro:
      "LazorKit is Solana's passkey-native smart-wallet stack: WebAuthn on the front, program-owned accounts on chain, and an SDK that treats seed-phrase friction as a bug.",
    howWeUse:
      "Lazor is one of chromatika's primary onboarding paths for Solana-base dWallet Vaults - tap a passkey to anchor a fresh vault to a Lazor smart wallet, no seed phrase to memorize.",
    guideHref: "/library/tech/ika-seed-solana-lazor",
    links: [
      { label: "lazorkit.com", href: "https://www.lazorkit.com/" },
      { label: "docs", href: "https://docs.lazorkit.com/" },
      { label: "x", href: "https://x.com/lazorkit" },
    ],
  },
  {
    id: "sui-passkeys",
    title: "Sui Passkeys",
    logoSrc: "/logos/sui.svg",
    intro:
      "Sui Passkeys is Mysten's WebAuthn-native signing scheme on Sui - your device's passkey becomes the signer, with no seed phrase to back up and no extension popup for every approval.",
    howWeUse:
      "chromatika offers Sui Passkeys as a primary onboarding path for a new dWallet Vault: the passkey's PRF output deterministically seeds the vault's user-share, so creation is one Face ID or Touch ID prompt and any synced device with the same passkey rebuilds the same dWallet Vault.",
    howWeUseBullets: [
      "the passkey seeds the dWallet Vault's user-share - chain assets are still owned by the dWallet's ika MPC shares, not the passkey credential itself.",
    ],
    guideHref: "/library/user/passkey-vault",
    links: [
      {
        label: "Mysten passkey docs",
        href: "https://sdk.mystenlabs.com/typescript/cryptography/passkey",
      },
      {
        label: "Sui SIP-9",
        href: "https://github.com/sui-foundation/sips/blob/main/sips/sip-9.md",
      },
      { label: "webauthn.io", href: "https://webauthn.io/" },
    ],
  },
  {
    id: "seeker",
    title: "Solana Seeker",
    logoSrc: "/logos/skr.svg",
    intro:
      "Seeker is Solana Mobile's flagship hardware-wallet phone - a pocket-sized Solana node with secure UI and tight integration with the mobile-wallet-adapter stack.",
    howWeUse:
      "chromatika pairs with Seeker (or any MWA-compatible wallet) over Solana Mobile's reflector wire, then persists a reauthorization token so repeat signs skip the QR dance until the phone revokes trust.",
    howWeUseBullets: [
      "pairing signs a fixed derivation message so the same Seeker rebuilds the same dWallet Vault user-share seed on a new computer - no HD mnemonic ever leaves the phone.",
    ],
    guideHref: "/library/user/seeker-remote",
    links: [
      { label: "solana mobile", href: "https://solanamobile.com/" },
      { label: "Seeker", href: "https://solanamobile.com/seeker" },
      { label: "github / SDK", href: "https://github.com/solana-mobile/mobile-wallet-adapter" },
    ],
  },
  {
    id: "waap",
    title: "WaaP",
    logoSrc: "/logos/WaaP.svg",
    intro:
      "WaaP is wallet-as-protocol from the human.tech stack: one-click sign-on and trustless account recovery, sitting alongside Human Passport for keys, sessions, and identity.",
    howWeUse:
      "WaaP is one of chromatika's primary onboarding paths for new dWallet Vaults - sign in with WaaP and chromatika opens a fresh dWallet Vault behind it, no seed phrase needed.",
    guideHref: "/library/user/waap-vault",
    links: [
      { label: "waap.xyz", href: "https://waap.xyz/" },
      { label: "human.tech docs", href: "https://docs.human.tech/" },
      { label: "x / Waapxyz", href: "https://x.com/WaaPxyz" },
    ],
  },
];
