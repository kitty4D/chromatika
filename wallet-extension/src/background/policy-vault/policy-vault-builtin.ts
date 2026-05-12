/**
 * Built-in chromatika Policy Vault package registry.
 *
 * Each entry points at a team-deployed `chromatika_policy` Move package (Sui) or
 * `chromatika-policy` Anchor program (Solana) whose upgrade authority has been
 * irrevocably destroyed at publish time. The user never deploys their own; chromatika
 * always uses the built-in for the active network.
 *
 * ## Why team-deploy + immutable
 *
 * Each user self-deploying the same Move package would mean each user repays mainnet rent
 * for identical bytecode, would silently fail to burn the UpgradeCap (the most common
 * footgun), and would have no way to verify their build matches the audited source. Team
 * deploy with the UpgradeCap consumed in the same publish transaction lifts the trust
 * story to "one publicly-verified bytecode hash, immutable forever, no upgrade authority
 * anywhere on chain." See `local/wallet-special/policy-vault-deployment.md` for the full
 * trust analysis.
 *
 * ## Filling in entries
 *
 * After the team runs `pnpm run deploy:sui-policy:<env>:final` (or
 * `pnpm run deploy:solana-policy:<env>:final`), capture the printed identifiers and paste
 * them into the matching entry below alongside the bytecode hash, the audit hash + report
 * URL, and the publish transaction reference. Ship a chromatika release.
 *
 * Entries set to `null` mean "no built-in for this network yet"; the chromatika Settings
 * panel surfaces a "policy not available on this network" message rather than an opt-in
 * button when the active network resolves to null.
 *
 * Pre-release posture: per `CLAUDE.md`, chromatika has not shipped to end users. Empty
 * registry today is fine; first real entries land alongside the audited production cut.
 */

import type { SuiNetworkId } from '@/config/sui';

export type SolanaCluster = 'mainnet' | 'testnet' | 'devnet' | 'localnet';

export type PolicyNetworkKey =
  | `sui-${SuiNetworkId}`
  | `sol-${SolanaCluster}`;

export interface BuiltinPolicyPackage {
  /** sui packageId (0x + 64 hex) for sui-* networks, base58 program id for sol-* clusters. */
  identifier: string;
  /** which side this entry is for; redundant with the map key but helps callers. */
  baseChain: 'sui' | 'solana';
  /** wall-clock when the team published; ISO 8601 string. */
  publishedAt: string;
  /** True only when the deploy was run with --burn-upgrade-cap / --final and the burn
   *  transaction was confirmed. We never set this true for iteration deploys. */
  upgradeAuthorityBurned: boolean;
  /** SHA-256 of the deployed bytecode (Sui: package bytecode; Solana: program .so). Lets
   *  users verify "the bytes on chain match what the team published" without trusting any
   *  off-chain service. */
  bytecodeHashSha256?: string;
  /** git commit the bytecode was built from. Pinned so audits and user verification can
   *  rebuild the same bytecode from source. */
  sourceCommit?: string;
  /** Audit firm name + URL to the audit report PDF. Required for any mainnet entry. */
  audit?: {
    firm: string;
    reportUrl: string;
    reportSha256: string;
  };
  /** Explorer link to the publish transaction (Sui) or program deploy tx (Solana). */
  publishTxExplorerUrl?: string;
  /** Explorer link to the package object (Sui) or program account (Solana). */
  explorerUrl?: string;
  /** Optional human-readable label for the package; mostly for the chromatika Settings
   *  panel ("chromatika built-in (sui mainnet, audited 2026-XX-XX)"). */
  label?: string;
  /** Sui UpgradeCap object id when `upgradeAuthorityBurned: false`. Held by the team
   *  deployer until the audited `:final` deploy burns it via `0x2::package::make_immutable`.
   *  Recorded here so audits can verify "the cap exists at this object id" or "the cap has
   *  been destroyed" against chain state. Omitted for Solana entries. */
  upgradeCapObjectId?: string;
}

/**
 * The registry. ALL entries start as null until the team runs the corresponding
 * `:final` deploy script and pastes the result here. Empty entries are fine pre-release.
 *
 * IMPORTANT: never set `upgradeAuthorityBurned: true` for an entry whose burn transaction
 * has not been confirmed on chain. A wrong `true` here would mislead users into thinking
 * the package is immutable when it isn't.
 */
export const POLICY_PACKAGE_BUILTINS: Record<PolicyNetworkKey, BuiltinPolicyPackage | null> = {
  // 2026-05-11 iteration deploy on Sui mainnet. UpgradeCap retained on the deploy
  // address so the team can upgrade as needed; flip to `upgradeAuthorityBurned: true`
  // only after a `:final` deploy that destroys this cap via 0x2::package::make_immutable
  // and the burn tx is confirmed on chain. No audit yet, so the `audit` field is intentionally
  // omitted; pre-release per `CLAUDE.md`, audit lands before any production cut.
  'sui-mainnet': {
    identifier: '0x8cd25cd3ae7966b61eeae97d77b7e029b29b37307b533b505c6a76b63e22d727',
    baseChain: 'sui',
    publishedAt: '2026-05-11T15:00:00Z',
    upgradeAuthorityBurned: false,
    upgradeCapObjectId: '0x1028d1afa57312bc860c1169979805d1983f667e6b5f96c2ed5910e58d6064b9',
    explorerUrl: 'https://suiscan.xyz/mainnet/object/0x8cd25cd3ae7966b61eeae97d77b7e029b29b37307b533b505c6a76b63e22d727',
    publishTxExplorerUrl: 'https://suiscan.xyz/mainnet/tx/FeCTdrz1K3HAyDjRsjgy428YK4iCB6JmMaQLkYDJAYSx',
    label: 'chromatika built-in (sui mainnet, iteration deploy 2026-05-11)',
  },
  'sui-testnet': null,
  'sol-mainnet': null,
  'sol-testnet': null,
  'sol-devnet': null,
  'sol-localnet': null,
};

/** Resolve the built-in Sui packageId (with audit metadata) for a given Sui network. */
export function getBuiltinPolicyForSui(network: SuiNetworkId): BuiltinPolicyPackage | null {
  const key: PolicyNetworkKey = `sui-${network}`;
  return POLICY_PACKAGE_BUILTINS[key] ?? null;
}

/** Resolve the built-in Solana programId (with audit metadata) for a given cluster. */
export function getBuiltinPolicyForSolana(cluster: SolanaCluster): BuiltinPolicyPackage | null {
  const key: PolicyNetworkKey = `sol-${cluster}`;
  return POLICY_PACKAGE_BUILTINS[key] ?? null;
}

/** True if any built-in is available for the given key (Sui or Solana). */
export function hasBuiltinPolicy(key: PolicyNetworkKey): boolean {
  return POLICY_PACKAGE_BUILTINS[key] !== null;
}
