export type GuideSectionId = "start" | "daily" | "advanced" | "hardware";

export type GuideMediaSlot = {
  kind: "screenshot" | "video";
  /** public URL under /guide/assets/... or external embed src */
  src: string;
  alt: string;
  caption?: string;
};

export type GuideArticle = {
  slug: string;
  title: string;
  sectionId: GuideSectionId;
  summary: string;
  /** ISO date string YYYY-MM-DD for display */
  lastUpdated?: string;
  body: string[];
  media?: GuideMediaSlot[];
};

export const guideSections: { id: GuideSectionId; label: string; blurb: string }[] = [
  {
    id: "start",
    label: "getting started",
    blurb: "install, first unlock, onboarding, where the side panel vs popup matters.",
  },
  {
    id: "daily",
    label: "everyday use",
    blurb: "sends, balances, activity, networks, and dapp connections at a steady pace.",
  },
  {
    id: "advanced",
    label: "advanced",
    blurb: "ika surfaces, presign context, custom networks, dev and power workflows.",
  },
  {
    id: "hardware",
    label: "hardware",
    blurb: "Ledger, Trezor where supported, Solana MWA and Seeker-style remote pairing.",
  },
];

export const guideArticles: GuideArticle[] = [
  {
    slug: "how-to-use-this-guide",
    title: "how to use this guide",
    sectionId: "start",
    lastUpdated: "2026-04-28",
    summary:
      "what each section covers, how screenshots and video will show up, and when to read safety articles first.",
    body: [
      "This guide is task-based. Each article walks through one job you might do in Chromatika, starting with the shortest safe path.",
      "Screenshots and short videos will sit in a media strip under the steps when we publish captures. Until then you will see placeholders or notes where a visual is coming.",
      "If a task can move money or expose a seed phrase, read the safety hub first. The wallet will still ask you to confirm risky actions, but your own judgment is the first layer.",
      "- Start with getting started if you are new.\n- Jump to everyday use for sends and connections.\n- Open advanced when you are tuning ika or networks.\n- Use hardware when your keys live on a device.",
    ],
  },
  {
    slug: "first-run-side-panel",
    title: "first run: side panel and popup",
    sectionId: "start",
    summary:
      "where Chromatika lives in Chrome, what the side panel is for vs the popup, and how approvals appear.",
    lastUpdated: "2026-04-28",
    body: [
      "Chromatika's primary surface is the Chrome side panel, pinned next to the page you are browsing. The popup opens for quick actions and for flows that need a focused window such as some hardware approvals.",
      "When a dapp asks to connect or sign, you may see a small Chrome popup spawned by the extension. Treat every popup as sensitive: verify the site and action before approving.",
      "Screenshot placeholder: side panel open on a test page with the Chromatika mark visible in the header chrome.",
    ],
  },
  {
    slug: "create-unlock-vault",
    sectionId: "start",
    title: "create or unlock your Chromatika vault",
    summary:
      "app password, Argon2id vault blob, and why the wallet locks on idle: no secrets in this article, only what to expect on screen.",
    lastUpdated: "2026-04-28",
    body: [
      "Creating a vault picks an app password and wraps your dWallet Vault records in the local encrypted store. Unlocking derives key material in memory; auto-lock clears it after idle or OS screen lock depending on platform signals.",
      "You will not paste a seed phrase into this article. The real flow stays inside the extension. Follow on-screen prompts only.",
      "Video placeholder: 45s silent walkthrough from cold install to unlocked side panel (to record).",
    ],
  },
  {
    slug: "send-funds-overview",
    sectionId: "daily",
    title: "send funds (overview)",
    summary:
      "choose chain, enter amount and destination, confirm on device if hardware, with a sanity checklist before broadcast.",
    lastUpdated: "2026-04-28",
    body: [
      "Open Send from the side panel, pick the asset and network that match what the recipient expects, and paste or scan their address.",
      "Double-check the chain type. Many losses are “right address, wrong network.”",
      "If you use a hardware account, the last step happens on the device. The extension never asks you to export a hardware seed phrase to “heal” a send.",
      "Screenshot placeholder: send form with testnet amounts and a highlighted network row.",
    ],
  },
  {
    slug: "connect-dapp",
    sectionId: "daily",
    title: "connect to a dapp",
    summary:
      "EVM, Solana, Sui, Bitcoin, and Aptos bridges each have a consent step. Verify origin before you approve.",
    lastUpdated: "2026-04-28",
    body: [
      "When a page requests a wallet, Chromatika checks the origin and shows what capability the site is asking for. If you do not recognize the domain, reject and navigate away.",
      "After you connect, review transaction details on every signature request. Phishing sites love urgency.",
      "Screenshot placeholder: approval sheet with origin hostname callout.",
    ],
  },
  {
    slug: "network-switcher",
    sectionId: "advanced",
    title: "networks and custom RPCs",
    summary:
      "built-in registry plus custom entries: know what you are trusting when you add a custom endpoint.",
    lastUpdated: "2026-04-28",
    body: [
      "The network selector combines built-in entries with custom rows you add. A malicious RPC can lie about balances and txs. Only use endpoints you trust.",
      "Testnet faucets and dev endpoints belong in dev profiles, not mixed with accounts you treat as valuable.",
      "Screenshot placeholder: network list with testnet badge.",
    ],
  },
  {
    slug: "ledger-first-steps",
    sectionId: "hardware",
    title: "Ledger: first connection",
    summary:
      "WebHID in the extension page context, address proof on device, and where Bitcoin support differs from EVM.",
    lastUpdated: "2026-04-28",
    body: [
      "Ledger connects over WebHID from the popup or side panel after you click connect. The service worker cannot open HID by itself.",
      "Prove addresses on the device screen before you treat an account as yours. The extension should never ask for the Ledger seed phrase.",
      "Video placeholder: plugging in, WebHID allowlist, and showing an address on device.",
    ],
  },
];

export function guideArticleBySlug(slug: string): GuideArticle | undefined {
  return guideArticles.find((a) => a.slug === slug);
}

export function guideArticlesInSection(sectionId: GuideSectionId): GuideArticle[] {
  return guideArticles.filter((a) => a.sectionId === sectionId);
}
