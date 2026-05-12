/** indexed by header search alongside KB + library markdown. */
export type StaticSearchHit = { slug: string; title: string; summary: string; href: string };

export const staticSearchHits: StaticSearchHit[] = [
  {
    slug: "roadmap",
    title: "roadmap",
    summary: "where chromatika is headed: recovery, Policy Vault depth, Seeker, encrypt, agents, UX",
    href: "/roadmap",
  },
  {
    slug: "tutorial",
    title: "hands-on tutorial",
    summary: "visual getting started: install, vault, home, dWallets, send, staking, x402, policy, MCP",
    href: "/tutorial",
  },
  {
    slug: "chromashard-spec",
    title: "ChromaShard spec",
    summary: "identity-sharded portable wallet recovery specification",
    href: "/features/chromashard",
  },
  {
    slug: "policy-vault-trust",
    title: "Policy Vault deploy & trust",
    summary: "on-chain caps, immutable package story, unwrap delay, verification checklist",
    href: "/features/policy-vault",
  },
  {
    slug: "encrypt-ika-map",
    title: "encrypt.xyz + ika feature map",
    summary: "cross-cutting map of encrypt, ika MPC, and adjacent wallet tech",
    href: "/features/encrypt-ika",
  },
];
