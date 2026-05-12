/**
 * storage layer for the chromatika `PolicyVault` (on-chain spend caps + panic + rescue).
 *
 * two storage shapes:
 *
 * 1. **global package config** (`chromatika_policy_package_v1`): for the production deploy
 *    we ship the team-deployed, UpgradeCap-burned packageIds as built-in defaults via
 *    [`policy-vault-builtin.ts`](./policy-vault-builtin.ts). The Settings UI is read-only
 *    here; users never paste packageIds. `setPolicyPackageConfig` still exists for team
 *    testing flows (advanced mode only) so a non-`:final` iteration deploy can be wired in
 *    during development. `getPolicyPackageConfig` falls back to the built-in for the active
 *    network when no override is stored.
 *
 * 2. **per-vault link** (`chromatika_policy_vault_v1_<chromatikaVaultId>`): set when the
 *    user opts in by wrapping their dWallet cap. holds the shared `PolicyVault` object id +
 *    a few cached read-only fields. live policy state (panicked, cap remaining, actuators,
 *    rescue address) is always read fresh from chain via `SuiGraphQLClient.core.getObject`.
 *
 * the chain is the source of truth. this module persists ONLY the pointer (vault object id)
 * + a write-time snapshot for offline UI rendering (e.g. when chromatika opens before the
 * Sui RPC roundtrip completes).
 */

import { STORAGE_KEYS, VAULT_SCOPED_KEYS } from '@/background/storage';
import type { SuiNetworkId } from '@/config/sui';
import { getSession } from '@/background/session';
import {
  type BuiltinPolicyPackage,
  type SolanaCluster,
  getBuiltinPolicyForSolana,
  getBuiltinPolicyForSui,
} from './policy-vault-builtin';

const PACKAGE_STORAGE_KEY = STORAGE_KEYS.POLICY_PACKAGE_V1;

export interface PolicyPackageConfig {
  /** Sui package id (`0x` + 64 hex chars). must point to a published `chromatika_policy` package. */
  packageId: string;
  /** wall-clock when chromatika first stored this package id. */
  setAtMs: number;
  /** optional human label for multiple-deploy scenarios (e.g. "chromatika-team mainnet"). */
  label?: string;
  /**
   * optional Solana program id for the parallel `chromatika-policy` Solana program.
   * required only when the user wants to opt in a Solana-base dWallet to policy gating.
   * pre-alpha: this enables the storage shape + UI surface, but the on-chain Solana
   * `sign_with_policy` instruction is a stub until ika Solana Alpha-1 ships a CPI target
   * for caller-PDA-as-authority approve_message. format: base58 Solana pubkey (32 bytes).
   */
  solanaProgramId?: string;
  /** True when this config came from `policy-vault-builtin.ts` (the team-deployed
   *  immutable production package) rather than a user-supplied / test override. */
  builtin?: boolean;
  /** SHA-256 of the deployed bytecode (matches the audited source's compiled output).
   *  Populated only for built-in entries. Lets users verify on-chain bytecode matches
   *  the audited source without trusting any off-chain index. */
  auditHash?: string;
}

/**
 * The result of resolving "what policy package should the wallet use right now?". Combines
 * the optional stored override with the built-in defaults from `policy-vault-builtin.ts`.
 * The Sui packageId and the Solana programId are independent (Sui-base dWallets use
 * `packageId`; Solana-base dWallets use `solanaProgramId`), so this struct may have either
 * or both populated (or neither, when no built-in exists for the active network and no
 * override is stored).
 */
export interface ResolvedPolicyPackage {
  packageId: string | null;
  solanaProgramId: string | null;
  /** Source of the Sui side: 'builtin' means it came from the team-deployed registry. */
  packageIdSource: 'builtin' | 'override' | null;
  solanaProgramIdSource: 'builtin' | 'override' | null;
  /** Full built-in entry for the Sui side, when available (for showing audit hash etc). */
  builtinSui: BuiltinPolicyPackage | null;
  /** Full built-in entry for the Solana side. */
  builtinSolana: BuiltinPolicyPackage | null;
}

export interface PolicyVaultLink {
  /**
   * for Sui base: the Sui object id of the shared `PolicyVault` (`0x` + 64 hex).
   * for Solana base: the base58 Solana PDA address of the `PolicyVault` account.
   * the shape diverges by base chain; consumers should branch on `baseChain` (defaults
   * to 'sui' when absent for legacy installs).
   */
  vaultObjectId: string;
  /** dWallet id this vault wraps (matches chromatika's `DWalletMeta.dwalletId`). */
  dwalletId: string;
  /** first actuator at opt-in (the user's own Sui or Solana address per `baseChain`). */
  primaryActuator: string;
  /** wall-clock at opt-in. */
  optInAtMs: number;
  /** curve + sig algo pinned at opt-in. mirrors the on-chain values for client-side dispatch. */
  curve: number;
  signatureAlgorithm: number;
  /**
   * which ika base this policy vault was created on. defaults to 'sui' when absent
   * (back-compat for installs that opted in before Solana support shipped). Solana base
   * is pre-alpha, see POLICY_VAULT_SOLANA.md for the deployment runbook + caveats.
   */
  baseChain?: 'sui' | 'solana';
  /** last synced snapshot of the on-chain state (for offline UI rendering). */
  cachedSnapshot?: PolicyVaultSnapshot;
  /** wall-clock of the last successful chain sync that populated `cachedSnapshot`. */
  lastSyncMs?: number;
}

/**
 * plaintext snapshot of `PolicyVault` fields the UI displays. always treat as stale; chain
 * is authoritative. we persist this only so cold-start chromatika can render before the
 * Sui roundtrip completes.
 */
export interface PolicyVaultSnapshot {
  panicked: boolean;
  panicAtMs: number;
  unfreezeDelayMs: number;
  unfreezeUnlocksAtMs: number;
  dailyCapMicros: string; // BigInt-safe
  spentTodayMicros: string;
  coolDownMs: number;
  lastSignAtMs: number;
  actuators: string[];
  hasRescueAddress: boolean;
  ikaBalance: string;
  suiBalance: string;
  presignsRemaining: number;
  epochDay: number;
  // staging (cap-increase staged delay; opt-in safety)
  stageCapRaises: boolean;
  stageDelayMs: number;
  hasPendingCap: boolean;
  pendingCapMicros: string;       // bigint-safe; "0" when no pending
  pendingCapAtMs: number;
  pendingStageOff: boolean;
  pendingStageOffAtMs: number;
  // unwrap two-step (user-controlled exit)
  unwrapRequested: boolean;
  unwrapAtMs: number;             // 0 when no pending unwrap
}

function vaultStorageKey(vaultId: string, dwalletId: string): string {
  return VAULT_SCOPED_KEYS.policyVault(vaultId, dwalletId);
}

// ─── package config (global) ───────────────────────────────────────────────────────

function builtinToPackageConfig(b: BuiltinPolicyPackage): PolicyPackageConfig {
  return {
    packageId: b.identifier,
    setAtMs: Date.parse(b.publishedAt) || Date.now(),
    label: b.label,
    builtin: true,
    auditHash: b.bytecodeHashSha256,
  };
}

/**
 * Read the override stored in chrome.storage (advanced-mode team-iteration path). Returns
 * raw storage with no built-in fallback. Most consumers should prefer `getPolicyPackageConfig`,
 * which merges this override with the built-in for the active Sui network.
 */
async function getStoredPolicyPackageOverride(): Promise<PolicyPackageConfig | null> {
  return new Promise((resolve) => {
    chrome.storage.local.get([PACKAGE_STORAGE_KEY], (r) => {
      const v = r[PACKAGE_STORAGE_KEY];
      if (v && typeof v === 'object' && typeof (v as PolicyPackageConfig).packageId === 'string') {
        resolve(v as PolicyPackageConfig);
      } else {
        resolve(null);
      }
    });
  });
}

/**
 * Resolve the active policy package config for the current session's Sui network. Returns
 * the stored override when present (team-iteration path), otherwise falls back to the
 * built-in for the active network (`policy-vault-builtin.ts`). Returns null only when
 * neither exists.
 *
 * The session is read inline so all existing consumers get the merge "for free" without
 * having to thread the network id through every call site. Tests that don't initialize a
 * session get the override-only behavior (matching the legacy pre-built-in behavior).
 */
export async function getPolicyPackageConfig(): Promise<PolicyPackageConfig | null> {
  const override = await getStoredPolicyPackageOverride();
  if (override) return override;

  const session = getSession();
  if (!session) return null;
  const builtin = getBuiltinPolicyForSui(session.network);
  if (!builtin) return null;
  return builtinToPackageConfig(builtin);
}

/**
 * Resolve the active policy package for the given Sui network + Solana cluster. Returns
 * the built-in by default; an override (set via the advanced-mode-gated
 * `setPolicyPackageConfig`) takes precedence on the Sui side when present.
 *
 * Callers should prefer this over the raw `getPolicyPackageConfig` whenever they need
 * "what package should this dWallet use?" - that question is network-dependent.
 */
export async function resolveActivePolicyPackage(
  suiNetwork: SuiNetworkId,
  solanaCluster: SolanaCluster,
): Promise<ResolvedPolicyPackage> {
  const override = await getPolicyPackageConfig();
  const builtinSui = getBuiltinPolicyForSui(suiNetwork);
  const builtinSolana = getBuiltinPolicyForSolana(solanaCluster);

  // The override (if present) replaces the Sui side. Built-in handles Solana unless the
  // override also specifies a solanaProgramId.
  let packageId: string | null = null;
  let packageIdSource: 'builtin' | 'override' | null = null;
  let solanaProgramId: string | null = null;
  let solanaProgramIdSource: 'builtin' | 'override' | null = null;

  if (override?.packageId) {
    packageId = override.packageId;
    packageIdSource = override.builtin ? 'builtin' : 'override';
  } else if (builtinSui) {
    packageId = builtinSui.identifier;
    packageIdSource = 'builtin';
  }

  if (override?.solanaProgramId) {
    solanaProgramId = override.solanaProgramId;
    solanaProgramIdSource = 'override';
  } else if (builtinSolana) {
    solanaProgramId = builtinSolana.identifier;
    solanaProgramIdSource = 'builtin';
  }

  return {
    packageId,
    solanaProgramId,
    packageIdSource,
    solanaProgramIdSource,
    builtinSui,
    builtinSolana,
  };
}

/**
 * Set an override package config. Advanced-mode only at the UI layer - the Settings
 * panel does NOT expose a paste input for this in production. Used by the team during
 * iteration testing to point chromatika at a non-`:final` deploy. Validated to be a
 * well-formed Sui object id; the Solana side is validated by the existing PolicyVaultLink
 * shape check.
 */
export async function setPolicyPackageConfig(cfg: PolicyPackageConfig): Promise<void> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(cfg.packageId)) {
    throw new Error('packageId must be a 0x-prefixed 32-byte hex Sui object id');
  }
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [PACKAGE_STORAGE_KEY]: cfg }, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

export async function clearPolicyPackageConfig(): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.remove([PACKAGE_STORAGE_KEY], () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

// ─── per-(vault, dwallet) link ────────────────────────────────────────────────────
//
// Keyed by `(vaultId, dwalletId)` so a single chromatika vault can opt-in multiple
// dWallets (same or different curves) into independent PolicyVaults with their own
// settings. `listPolicyVaultLinks(vaultId)` enumerates all opted-in dWallets by
// scanning chrome.storage.local for the `policyVaultPrefix(vaultId)` family.

export async function getPolicyVaultLink(
  chromatikaVaultId: string,
  dwalletId: string,
): Promise<PolicyVaultLink | null> {
  const key = vaultStorageKey(chromatikaVaultId, dwalletId);
  return new Promise((resolve) => {
    chrome.storage.local.get([key], (r) => {
      const v = r[key];
      if (v && typeof v === 'object' && typeof (v as PolicyVaultLink).vaultObjectId === 'string') {
        resolve(v as PolicyVaultLink);
      } else {
        resolve(null);
      }
    });
  });
}

/** Enumerate every opted-in dWallet for a chromatika vault. Returns links in stable
 *  insertion order (chrome.storage.local preserves object key order in practice). */
export async function listPolicyVaultLinks(chromatikaVaultId: string): Promise<PolicyVaultLink[]> {
  const prefix = VAULT_SCOPED_KEYS.policyVaultPrefix(chromatikaVaultId);
  return new Promise((resolve) => {
    // get(null) returns the entire local store; we filter to our prefix. policy-vault
    // listing is not a hot path (panel mount + tRPC query), so the full-scan cost is fine.
    chrome.storage.local.get(null, (r) => {
      const out: PolicyVaultLink[] = [];
      for (const k of Object.keys(r)) {
        if (!k.startsWith(prefix)) continue;
        const v = r[k];
        if (v && typeof v === 'object' && typeof (v as PolicyVaultLink).vaultObjectId === 'string') {
          out.push(v as PolicyVaultLink);
        }
      }
      resolve(out);
    });
  });
}

/** loose base58 check: 32-44 chars in the standard alphabet. Solana addresses are 32-44 chars. */
const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export async function setPolicyVaultLink(
  chromatikaVaultId: string,
  link: PolicyVaultLink,
): Promise<void> {
  const isSolana = link.baseChain === 'solana';
  if (isSolana) {
    if (!SOLANA_ADDRESS_RE.test(link.vaultObjectId)) {
      throw new Error('vaultObjectId must be a base58 Solana PDA address (32-44 chars)');
    }
    // Solana-base dWallet ids are also base58 PDAs (per CLAUDE.md "solana dWallets will be PDAs (base58)")
    if (!SOLANA_ADDRESS_RE.test(link.dwalletId)) {
      throw new Error('dwalletId must be a base58 Solana PDA on Solana base');
    }
  } else {
    if (!/^0x[0-9a-fA-F]{64}$/.test(link.vaultObjectId)) {
      throw new Error('vaultObjectId must be a 0x-prefixed 32-byte hex Sui object id');
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(link.dwalletId)) {
      throw new Error('dwalletId must be a 0x-prefixed 32-byte hex Sui object id');
    }
  }
  const key = vaultStorageKey(chromatikaVaultId, link.dwalletId);
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [key]: link }, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

export async function updatePolicyVaultSnapshot(
  chromatikaVaultId: string,
  dwalletId: string,
  snapshot: PolicyVaultSnapshot,
): Promise<void> {
  const link = await getPolicyVaultLink(chromatikaVaultId, dwalletId);
  if (!link) return;
  const next: PolicyVaultLink = {
    ...link,
    cachedSnapshot: snapshot,
    lastSyncMs: Date.now(),
  };
  const key = vaultStorageKey(chromatikaVaultId, dwalletId);
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [key]: next }, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

export async function clearPolicyVaultLink(
  chromatikaVaultId: string,
  dwalletId: string,
): Promise<void> {
  const key = vaultStorageKey(chromatikaVaultId, dwalletId);
  return new Promise((resolve, reject) => {
    chrome.storage.local.remove([key], () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

/** Remove every policy-vault link for a chromatika vault. Called from `removeVault`
 *  so deleting a vault doesn't leak per-dwallet rows. Scans the full local store
 *  and removes any keys matching `policyVaultPrefix(vaultId)`. */
export async function clearAllPolicyVaultLinksForVault(chromatikaVaultId: string): Promise<void> {
  const prefix = VAULT_SCOPED_KEYS.policyVaultPrefix(chromatikaVaultId);
  return new Promise((resolve) => {
    chrome.storage.local.get(null, (r) => {
      const keys = Object.keys(r).filter((k) => k.startsWith(prefix));
      if (keys.length === 0) {
        resolve();
        return;
      }
      chrome.storage.local.remove(keys, () => resolve());
    });
  });
}
