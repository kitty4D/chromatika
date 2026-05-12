/** hands-on chromatika walkthrough sections (paired with screenshots in public/images/rich-user-guide). */

export type TutorialStep = {
  id: string;
  title: string;
  /** short label for nav */
  short: string;
  body: string[];
  images?: { src: string; alt: string }[];
};

export const tutorialLead =
  "a visual walkthrough of the chromatika wallet extension. chromatika is a multi-chain browser wallet that uses ika dWallets (MPC split keys) as your on-chain identity across EVM, Sui, Solana, Bitcoin, and Aptos.";

export const tutorialPreRelease =
  "pre-release notice: chromatika has not shipped to end users. Solana ika base is a pre-alpha mock signer - never use it for real value. storage and crypto are dev-only.";

export const tutorialInstallCommands = [
  "cd wallet-extension",
  "pnpm install",
  "pnpm run build",
];

export const tutorialSteps: TutorialStep[] = [
  {
    id: "vault",
    title: "creating your first vault",
    short: "vault",
    body: [
      "when you open chromatika for the first time, you will see the onboarding screen.",
      "chromatika offers multiple ways to create a dWallet Vault - the encrypted container that holds your keys: passkey (recommended), WAAP (sign in with waap), hardware wallet (Seeker / Phantom via MWA), or advanced paths (Lazor, BIP39, import mnemonic, import private key). each option creates the vault and derives the keys needed for ika dWallet operations.",
    ],
    images: [{ src: "/images/rich-user-guide/01-onboarding.png", alt: "chromatika onboarding vault options" }],
  },
  {
    id: "home",
    title: "the home screen",
    short: "home",
    body: [
      "after unlocking, you land on the home screen.",
      "the vault name and address appear at the top - tap the address to copy, tap the chain pill for explorer links. SUI and IKA balances show your fee-payer balances on the ika network.",
      "the vault account card bundles quick actions - send, receive, swap, scan. bottom nav spans HOME, dWallet, ASSETS, ACTIVITY, POLICY. the vault total line shows aggregate USD balance (cached refresh, typically about 5 minutes).",
    ],
    images: [{ src: "/images/rich-user-guide/02-vault-home.png", alt: "chromatika vault home" }],
  },
  {
    id: "dwallets",
    title: "managing dWallets",
    short: "dWallets",
    body: [
      "each dWallet is a distinct on-chain identity created via ika distributed key generation. a single dWallet can expose addresses for every supported chain.",
      "SECP256K1 curve drives EVM, Bitcoin (P2WPKH + Taproot), and DeSo. ED25519 drives Sui, Solana, and Aptos.",
      "create a new dWallet with the + button and pick your curve. DKG runs in the background with a progress banner and usually finishes in a few seconds.",
    ],
    images: [{ src: "/images/rich-user-guide/06-dwallets.png", alt: "chromatika dWallet list" }],
  },
  {
    id: "send",
    title: "sending tokens",
    short: "send",
    body: [
      "select the chain tab (evm, sui, btc, solana), paste the recipient, enter a human-readable amount, then review and send.",
      "for ERC20 or SPL tokens, use the token dropdown. the wallet auto-discovers balances where providers allow.",
    ],
    images: [{ src: "/images/rich-user-guide/03-send.png", alt: "chromatika send screen" }],
  },
  {
    id: "assets-activity",
    title: "assets and activity",
    short: "assets",
    body: [
      "assets pulls balances from each chain client. prices follow the configurable waterfall (CoinGecko, DefiLlama, Pyth, and friends).",
      "activity merges explorer history with the local signed-tx record. you can attach encrypted notes to transactions via encrypt.xyz pre-alpha where enabled.",
    ],
    images: [
      { src: "/images/rich-user-guide/05-assets.png", alt: "chromatika assets tab" },
      { src: "/images/rich-user-guide/04-activity.png", alt: "chromatika activity tab" },
    ],
  },
  {
    id: "staking",
    title: "ika staking",
    short: "staking",
    body: [
      "stake IKA with network validators. the staking surface lists validators, commissions, APY, and your active positions with stake, claim, and unstake actions.",
      "staking operations are Sui programmable transaction blocks that talk to the ika system package.",
    ],
    images: [{ src: "/images/rich-user-guide/07-ika-staking.png", alt: "chromatika ika staking" }],
  },
  {
    id: "x402",
    title: "x402 payments",
    short: "x402",
    body: [
      "chromatika intercepts HTTP 402 responses so you can pay for web content with USDC on Solana under the x402 exact scheme.",
      "the payments page covers daily caps, private encrypted receipts, and a full receipt log with status and quality ratings.",
    ],
    images: [{ src: "/images/rich-user-guide/08-payments.png", alt: "chromatika x402 payments settings" }],
  },
  {
    id: "policy",
    title: "Policy Vault",
    short: "policy",
    body: [
      "Policy Vault wraps your dWallet signing authority in on-chain spend caps, cool-down, panic, rescue address, and staged raises.",
      "after creating a new dWallet, chromatika can prompt once with sensible defaults so you can wrap in one tap.",
    ],
    images: [
      { src: "/images/rich-user-guide/09-policy-vault.png", alt: "chromatika policy vault" },
      { src: "/images/rich-user-guide/12-policy-prompt.png", alt: "chromatika post-create policy prompt" },
    ],
  },
  {
    id: "mcp",
    title: "agent surface (MCP)",
    short: "MCP",
    body: [
      "the native messaging host exposes read-tier tools (no popup) and approve-tier tools that open the standard approval UI.",
      "bearer-token auth gates the localhost HTTP listener; stdio bridge mode exists for desktop agents.",
    ],
    images: [{ src: "/images/rich-user-guide/10-agents.png", alt: "chromatika agents MCP status" }],
  },
  {
    id: "lab",
    title: "chroma lab",
    short: "lab",
    body: [
      "developer and experimental surface for encrypt.xyz pre-alpha: encrypted dWallet labels plumbing, encrypted input creation, and ciphertext reads.",
      "Solana ika base only - lab-grade, not production custody.",
    ],
    images: [{ src: "/images/rich-user-guide/11-chroma-lab.png", alt: "chromatika chroma lab" }],
  },
];

export const tutorialQuickRef: { action: string; where: string }[] = [
  { action: "unlock wallet", where: "side panel or popup - password, passkey, or hardware" },
  { action: "switch dWallet", where: "home screen - tap a different dWallet card" },
  { action: "switch network", where: "settings gear - networks, or the network pill on the home card" },
  { action: "connect a dapp", where: "visit a dapp - chromatika advertises via EIP-6963 (EVM) or Wallet Standard (Sui / Solana)" },
  { action: "panic the policy vault", where: "policy tab - panic button (any actuator can trigger)" },
  { action: "check MCP status", where: "agents tab - connection status and tools" },
];
