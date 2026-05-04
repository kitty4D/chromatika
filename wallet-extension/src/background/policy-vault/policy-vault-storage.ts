/**
 * storage layer for the chromatika `PolicyVault` (on-chain spend caps + panic + rescue).
 *
 * two storage shapes:
 *
 * 1. **global package config** (`chromatika_policy_package_v1`): set once after the
 *    chromatika_policy::sign_gate Move package is deployed. holds the published Sui
 *    `packageId`. until set, opt-in is disabled and the UI surfaces a "deploy first"
 *    runbook (mirrors the PC-Token "self-deploy required" pattern).
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
}

function vaultStorageKey(vaultId: string): string {
  return VAULT_SCOPED_KEYS.policyVault(vaultId);
}

// ─── package config (global) ───────────────────────────────────────────────────────

export async function getPolicyPackageConfig(): Promise<PolicyPackageConfig | null> {
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

// ─── per-vault link ───────────────────────────────────────────────────────────────

export async function getPolicyVaultLink(chromatikaVaultId: string): Promise<PolicyVaultLink | null> {
  const key = vaultStorageKey(chromatikaVaultId);
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
  const key = vaultStorageKey(chromatikaVaultId);
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [key]: link }, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

export async function updatePolicyVaultSnapshot(
  chromatikaVaultId: string,
  snapshot: PolicyVaultSnapshot,
): Promise<void> {
  const link = await getPolicyVaultLink(chromatikaVaultId);
  if (!link) return;
  const next: PolicyVaultLink = {
    ...link,
    cachedSnapshot: snapshot,
    lastSyncMs: Date.now(),
  };
  const key = vaultStorageKey(chromatikaVaultId);
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [key]: next }, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

export async function clearPolicyVaultLink(chromatikaVaultId: string): Promise<void> {
  const key = vaultStorageKey(chromatikaVaultId);
  return new Promise((resolve, reject) => {
    chrome.storage.local.remove([key], () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}
