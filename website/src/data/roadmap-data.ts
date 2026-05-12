export type RoadmapStatus =
  | "designed"
  | "in-progress"
  | "planned"
  | "upstream-blocked"
  | "pre-mainnet";

export type RoadmapLink = { label: string; href: string };

export type RoadmapItem = {
  id: string;
  title: string;
  status: RoadmapStatus;
  tagline: string;
  body: string;
  links?: RoadmapLink[];
};

export type RoadmapSection = {
  id: string;
  label: string;
  items: RoadmapItem[];
};

export const roadmapLastReviewed = "2026-05-11";

export const roadmapLegend: { status: RoadmapStatus; blurb: string }[] = [
  { status: "designed", blurb: "spec is written and reviewed; no code yet." },
  { status: "in-progress", blurb: "partial implementation behind a gate, or one phase shipped with more to come." },
  { status: "planned", blurb: "on the list, not started." },
  { status: "upstream-blocked", blurb: "waiting on an external dependency before we can finish." },
  { status: "pre-mainnet", blurb: "must close before chromatika opens to end users." },
];

export const roadmapFeatured: RoadmapItem[] = [
  {
    id: "chromashard",
    title: "ChromaShard",
    status: "designed",
    tagline: "identity-sharded portable wallet recovery",
    body: "useless recovery string + 4 of 7 logins = your wallet back, in any compatible wallet. a portable threshold-encrypted bundle that wraps every secret a wallet user owns (seed phrases, raw private keys, future agent tokens) into a single string that is safe to publish. recovery requires proving control of a quorum of identity factors the user pre-registered: passkeys, hardware devices, recovery passphrases, email and DM inboxes, cloud-storage accounts. default 4-of-7. no coordinator, no federated network, no chromatika-run service required to recover. losing one or two factors is survivable. a single OAuth account breach is useless on its own. the library spec is intentionally portable so any other wallet can implement it.",
    links: [{ label: "read the full spec", href: "/features/chromashard" }],
  },
  {
    id: "policy-ed25519",
    title: "Hardened Policy Vault on every curve (ED25519 parity)",
    status: "planned",
    tagline: "every chain enforces the same on-chain spend cap, panic, and rescue gates, regardless of curve.",
    body: "today chromatika's on-chain Policy Vault wraps any dWallet cap (both SECP256K1 and ED25519) in a Sui Move shared object so all signing must pass the gate. SECP-signed chains (Bitcoin, EVM, DeSo) already get hard chain-decoded caps: the Move decoder reads the actual transaction bytes and clamps the value, so a lying client can't bypass the daily limit. ED25519-signed chains (Sui PTB, Solana ix, Aptos move calls) currently enforce only caller-declared (soft) caps. the v2 lane ships per-format Move decoders for each ED25519 payload type, so the same hard enforcement applies whether your dWallet is signing an EVM transfer or a Sui Move call. panic, cool-down, unfreeze, rescue address, and staged-change delay already work uniformly across both curves.",
    links: [
      { label: "Policy Vault deploy + trust story", href: "/features/policy-vault" },
      {
        label: "engineering notes (repo)",
        href: "https://github.com/kitty4D/chromatika/blob/main/wallet-extension/docs/POLICY_VAULT.md",
      },
    ],
  },
  {
    id: "seeker-native",
    title: "Chromatika for Solana Seeker (native Android companion)",
    status: "planned",
    tagline: "open the wallet right from your Seeker, with the same dWallet, no re-pair.",
    body: "today Seeker support lives inside the desktop extension via Solana Mobile Wallet Adapter: scan a QR, pair the phone, sign on-device. the next step is a native android companion so chromatika is a first-class app on the Seeker home screen, not a desktop attachment. the ika seed already derives deterministically from the phone wallet's signature (RFC 8032 ed25519 is reproducible), so the native app inherits the same dWallet as the desktop pairing automatically. no fresh DKG, no separate identity, no seed phrase shuffle. cross-device pickup works out of the box.",
    links: [
      {
        label: "Seeker remote pairing runbook (repo)",
        href: "https://github.com/kitty4D/chromatika/blob/main/wallet-extension/docs/SEEKER_REMOTE_PAIRING.md",
      },
    ],
  },
];

export const roadmapSections: RoadmapSection[] = [
  {
    id: "security",
    label: "Security & recovery",
    items: [
      {
        id: "policy-solana",
        title: "Policy Vault on Solana base",
        status: "upstream-blocked",
        tagline: "the same wrap-your-keys-in-an-on-chain-gate protection, for dWallets anchored on Solana.",
        body: 'the Anchor program at wallet-extension/solana/chromatika-policy/ already exists as pre-alpha scaffolding. the CPI body that hands authority to the ika program is intentionally stubbed until ika ships Solana Alpha-1 with a real signer surface; until then the UI honestly renders "Policy Vault is Sui-only for now" on Solana-base vaults rather than pretending it works. when Alpha-1 lands, we wire the CPI and ship feature parity with the Sui-base Policy Vault.',
        links: [
          {
            label: "Solana Anchor program notes (repo)",
            href: "https://github.com/kitty4D/chromatika/blob/main/wallet-extension/docs/POLICY_VAULT_SOLANA.md",
          },
        ],
      },
      {
        id: "broadcast-channel",
        title: "On-chain BroadcastChannel for safety alerts",
        status: "planned",
        tagline: "signed drain warnings on-chain, with a Move-level publisher registry instead of a JSON feed.",
        body: "chromatika already polls a signed alerts feed every 5 min, auto-panics any Policy Vault listed in panicTargets, and surfaces persistent in-app banners plus chrome notifications. the next step moves the feed itself on-chain: a Sui Move BroadcastChannel object plus a PublisherCap registry, optional Walrus-stored long-form bodies, and cross-chain anchors so the same alert can freeze a Solana-base vault. soft-blocks for flagged dapp-bridge origins are on the same lane.",
      },
    ],
  },
  {
    id: "reach",
    label: "Reach",
    items: [
      {
        id: "solana-alpha1",
        title: "Solana ika base - Alpha 1 (real MPC, no mock signer)",
        status: "upstream-blocked",
        tagline: "every Solana-base signature comes from a distributed network, not a single mock signer.",
        body: "today the Solana ika base path is wired against ika's pre-alpha gRPC client for SDK exploration, but every signature is produced by a single mock signer. the wallet labels it clearly everywhere users can see: pre-alpha, devnet only, do not submit real-value transactions. when ika ships Alpha-1, the same chromatika code paths flip from mock to distributed MPC with no UX rewrite required.",
      },
      {
        id: "ledger-sui-ptb",
        title: "Native Sui PTB on Ledger",
        status: "upstream-blocked",
        tagline: "sign Sui PTBs on your Ledger like you sign every other chain.",
        body: "hardware vaults for Sui currently store a suiPrivateKeyBech32 for the fee-payer keypair until the official Ledger Sui app supports native PTB signing on-device. that's technical debt we own honestly; the moment the Ledger Sui app ships full PTB support, chromatika swaps the path and stops persisting Sui secrets for hardware accounts.",
      },
    ],
  },
  {
    id: "privacy",
    label: "Privacy stack (Encrypt.xyz integration)",
    items: [
      {
        id: "encrypt-spl-deposit",
        title: "Encrypt SPL deposit (acquire ENC + top-up flows)",
        status: "planned",
        tagline: "the missing piece of the encrypt.xyz deposit story, baked into the wallet.",
        body: "chromatika already integrates encrypt.xyz for per-dWallet encrypted labels, encrypted activity notes, and PC-Token hidden transfers. the next piece is in-wallet deposit flows: a one-screen acquire ENC plus top up your ATA UX that wraps the create_deposit and top_up instructions on the published Encrypt program. today the wallet returns a notes-only path with a deep link; v1 makes it a real button.",
      },
      {
        id: "pc-swap-p4",
        title: "PC-Swap phase 4 (private AMM)",
        status: "planned",
        tagline: "hide the amounts on a swap, not just on a transfer.",
        body: "PC-Token (phase 3) already lets users wrap an SPL into a hidden-balance synthetic and transfer it without exposing amounts on-chain. phase 4 is the private AMM: swap one PC-Token for another with the amount also hidden from observers. design and program alignment with the encrypt.xyz team is the gating work; once the program ships, chromatika is the first wallet integration.",
        links: [{ label: "encrypt + ika feature map", href: "/features/encrypt-ika" }],
      },
    ],
  },
  {
    id: "agent",
    label: "Agent surface",
    items: [
      {
        id: "mcp-solana-tx",
        title: "MCP sendSolanaTx (arbitrary SPL + native SOL, agent-driven)",
        status: "planned",
        tagline: "the missing sibling of sendEvmTx in the agent toolkit.",
        body: "chromatika's MCP agent surface already exposes sendEvmTx so an authorized agent can move funds on any EVM chain through the wallet's approval popup (with Policy Vault no-popup mode when caps allow). the Solana equivalent ships next: native SOL transfers plus arbitrary SPL transfers, composable with the existing x402 and WalletConnect paths.",
      },
      {
        id: "x402-facilitator",
        title: "Real x402 facilitator round-trip",
        status: "planned",
        tagline: "pay the bill at a real facilitator, not just a spec-aligned mock.",
        body: "the x402 fetch-interception, caps, receipts, ika MPC signer, and WalletConnect signer all ship today, wire-format spec-aligned per the exact scheme on Solana. the gap is end-to-end coverage against a real facilitator with a smoke harness that exercises the full 402 -> sign -> retry -> settle loop in CI. when one facilitator is pinned and green, we light up the live badge in the Payments page.",
      },
      {
        id: "msg-provenance",
        title: "Non-EVM message-sign provenance",
        status: "planned",
        tagline: "every off-chain signature carries the origin that asked for it, on every chain.",
        body: "send-path origin recording already works across EVM, Solana, Sui, Bitcoin, Aptos, and DeSo. the message-sign paths still need the same hook on the non-EVM chains so drain analysis and the activity feed see them too. small lift, large clarity win.",
      },
    ],
  },
  {
    id: "discovery",
    label: "Discovery & UX",
    items: [
      {
        id: "dwallet-discovery-p3",
        title: "Full dWallet discovery (Phase 3)",
        status: "in-progress",
        tagline: "find every dWallet you ever made, even the orphan ones, on any device.",
        body: "chromatika today already does incremental dWallet discovery for the active vault (scan service, sibling-vault auto-detect, orphan badges in the Find More Accounts panel). Phase 3 closes out the reconcile every owned dWallet at import time and refresh time picture so a fresh chromatika install with the same identity recovers everything in one pass.",
        links: [
          {
            label: "multi-vault model (repo)",
            href: "https://github.com/kitty4D/chromatika/blob/main/wallet-extension/docs/DWALLET_VAULT_MODEL.md",
          },
          { label: "user guide: find more accounts", href: "/library/user/find-more-accounts" },
        ],
      },
      {
        id: "nested-tree-p6",
        title: "dWallet-anchored nested-tree management (Phase 6)",
        status: "planned",
        tagline: "a folder-tree view of your wallet-of-wallets, with each branch its own anchor.",
        body: "anchored vault discovery works today on the flat list. Phase 6 ships the nested-tree UX: dWallets that own subtrees of vaults, drag-to-reparent, per-branch policy and naming. waits on a focused ika spike to finalize the on-chain anchor schema.",
      },
      {
        id: "funding-cd",
        title: "Multichain funding aggregator (Phases C/D)",
        status: "planned",
        tagline: 'go from "i have USDC on chain X" to "fund my Sui-base vault with IKA" in one flow.',
        body: "Phase B already ships in-wallet Sui to IKA routing via the Aftermath router, feature-flagged on by default. Phases C and D expand the same one-screen fund my vault pattern to multichain inputs: bridge in from EVM or Solana, swap on the destination chain, and land the result in the active vault's chain set.",
      },
      {
        id: "kiosks-tab",
        title: "Kiosks as a dedicated tab",
        status: "planned",
        tagline: "Sui Kiosk management gets first-class real estate, not a sub-panel.",
        body: "today Kiosk management is a panel inside the NFTs page. promoting it to a dedicated bottom-nav tab finishes that story.",
      },
    ],
  },
];

export const roadmapShipped: { date: string; title: string; detail: string }[] = [
  {
    date: "2026-05-11",
    title: "Policy Vault on Sui mainnet, with ED25519 wrappable",
    detail:
      "team-deployed package id baked into the built-in registry, post-create policy prompt fires after every new dWallet, ED25519 dWallets now wrap (soft caps until per-format decoders ship).",
  },
  {
    date: "2026-05-10",
    title: "Two-step Policy Vault exit + team-deploy model",
    detail:
      "request unwrap countdown plus separate claim unwrap tx replaces instant exit. team-deploy with optional --burn-upgrade-cap makes the on-chain package verifiably immutable. CHANGELOG §2026-05-10.",
  },
  {
    date: "2026-05-10",
    title: "Offscreen NFT media cache",
    detail:
      "third-party NFT and Ordinals imagery flows through a centralized offscreen document with IndexedDB cache, 100 MB / 7-day TTL, credentials omit + no-referrer. CHANGELOG §2026-05-10.",
  },
  {
    date: "2026-05-09",
    title: "Encrypt.xyz docs matched to shipped code paths",
    detail:
      "STATUS + FEATURES no longer overstated stubs: PC-token wired vs awaiting-program, SPL ENC deposit stub copy honest. CHANGELOG subsection under §2026-05-10.",
  },
  {
    date: "2026-05-08",
    title: "Solana ika TS surface audit (upstream still blocked)",
    detail:
      "re-checked @ika.xyz/sdk + pre-alpha Solana client: no Solana read APIs yet; SolanaIkaAdapter throws kept. Recommended stance unchanged until ika Solana Alpha 1.",
  },
  {
    date: "2026-05-07",
    title: "Offscreen NFT fetch path + `<NftImage>` UI",
    detail:
      "SW ensure-ready bridge, IndexedDB LRU + TTL eviction, idle alarm tears down the doc, `<NftImage>` mints per-side-panel blob URLs. CHANGELOG subsection under §2026-05-10.",
  },
  {
    date: "2026-05-06",
    title: "Policy Vault unwrap choreography in TS + panel",
    detail:
      "tRPC request/cancel/claim unwrap, snapshot fields unwrapRequested / unwrapAtMs, PolicyVaultPanel exit disclosure states, audit kinds for unwrap transitions. CHANGELOG subsection under §2026-05-10.",
  },
  {
    date: "2026-05-05",
    title: "Policy Vault unwrap semantics in Move (two-step)",
    detail:
      "request_unwrap / cancel_unwrap / claim_unwrap, actuator edits blocked while unwrap pending, staged delay before claim, migration story spelled out vs instant migration risk. CHANGELOG subsection under §2026-05-10.",
  },
  {
    date: "2026-05-04",
    title: "Built-in Policy package registry + :final deploy flags",
    detail:
      "team-deploy posture in policy-vault-builtin.ts, Settings paste-only-under-team-collapsible, deploy-sui-policy.mjs --burn-upgrade-cap, Anchor --final analogue for Solana. CHANGELOG subsection under §2026-05-10.",
  },
  {
    date: "2026-05-03",
    title: "Activity scan + sibling vaults from one identity",
    detail:
      "re-pair the same passkey / WaaP / Lazor / Seeker on a fresh install and chromatika auto-detects dWallets, inline sibling-add, orphan-cap badges in Settings.",
  },
  {
    date: "2026-05-03",
    title: "WaaP and Lazor restore-via-signature",
    detail:
      "same login, any device, same dWallet, no recovery phrase. determinism probe; non-deterministic authenticators fall back to 24-word phrase path.",
  },
  {
    date: "2026-05-02",
    title: "Trezor Bitcoin PSBT signing",
    detail:
      "BIP84 P2WPKH sends on Trezor via PSBT decomposition and Esplora prev-tx fetches. Sui still unsupported by Trezor Connect; Bitcoin is.",
  },
];
