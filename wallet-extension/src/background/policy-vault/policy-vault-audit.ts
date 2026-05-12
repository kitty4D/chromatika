/**
 * per-(vault, dwallet) audit log of every Policy Vault decision the user makes via chromatika.
 *
 * the Move side already emits authoritative on-chain events (`DailyCapChanged`,
 * `PanicTriggered`, `PolicySigned`, etc.). this is the **client-side mirror** that:
 *   1. captures intent + tx digest BEFORE the chain confirms (so users see "I asked for X
 *      at time T" even when the tx is in flight or fails)
 *   2. captures sign-time decisions the chain doesn't see (e.g. sign was aborted client-side
 *      because pre-flight detected panic, before the PTB even broadcast)
 *   3. provides a fast-render history without round-tripping the GraphQL events index every
 *      time the user opens the panel
 *
 * storage: `chromatika_policy_audit_v1_<vaultId>_<dwalletId>` -> `AuditEntry[]`. capped at 200
 * entries per (vault, dwallet), FIFO rotation. cleared on `clearLocalPolicyVaultLink` for the
 * matching dwallet.
 *
 * entries are append-only from chromatika's perspective. the user can `clearPolicyAuditLog`
 * to wipe local state (the on-chain events remain queryable forever via Sui explorers).
 */

import { VAULT_SCOPED_KEYS } from '@/background/storage';

const MAX_ENTRIES_PER_DWALLET = 200;

function storageKey(vaultId: string, dwalletId: string): string {
  return VAULT_SCOPED_KEYS.policyAudit(vaultId, dwalletId);
}

/**
 * single audit entry. `kind` is the canonical action; `prev` / `next` capture the before/after
 * state for setters; `digest` is the Sui tx hash when the entry corresponds to an executed
 * mutation (omitted for client-side-only events like sign aborts).
 */
export interface PolicyAuditEntry {
  vaultId: string;
  /** dWallet the entry belongs to (matches the wrapping PolicyVaultLink). */
  dwalletId: string;
  timestampMs: number;
  kind:
    | 'opt-in'
    | 'panic'
    | 'unfreeze'
    | 'set-daily-cap'
    | 'set-cool-down'
    | 'set-rescue-address'
    | 'add-actuator'
    | 'remove-actuator'
    | 'replenish-presign'
    | 'top-up-ika'
    | 'top-up-sui'
    | 'sign-cap-applied'
    | 'sign-aborted-over-cap'
    | 'sign-aborted-panicked'
    | 'sign-aborted-cool-down'
    | 'local-link-cleared'
    // staged-delay opt-in safety
    | 'stage-cap-raises-toggled'
    | 'pending-cap-staged'
    | 'pending-cap-committed'
    | 'pending-stage-off-staged'
    | 'pending-stage-off-committed'
    | 'set-stage-delay'
    // unwrap two-step
    | 'unwrap-requested'
    | 'unwrap-cancelled'
    | 'vault-unwrapped';
  /** Sui tx digest when applicable. */
  digest?: string;
  /** before-value for setters (e.g. previous cap as micro-USD string). */
  prev?: string;
  /** after-value for setters. */
  next?: string;
  /** free-form note: error reason, asset symbol, recipient hint, etc. */
  detail?: string;
}

async function read(vaultId: string, dwalletId: string): Promise<PolicyAuditEntry[]> {
  const key = storageKey(vaultId, dwalletId);
  return new Promise((resolve) => {
    chrome.storage.local.get([key], (r) => {
      const v = r[key];
      if (Array.isArray(v)) resolve(v as PolicyAuditEntry[]);
      else resolve([]);
    });
  });
}

async function write(
  vaultId: string,
  dwalletId: string,
  entries: PolicyAuditEntry[],
): Promise<void> {
  const key = storageKey(vaultId, dwalletId);
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [key]: entries }, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

/** append a new entry; auto-rotates FIFO at MAX_ENTRIES_PER_DWALLET. */
export async function appendPolicyAuditEntry(
  entry: Omit<PolicyAuditEntry, 'timestampMs'> & { timestampMs?: number },
): Promise<void> {
  const finalized: PolicyAuditEntry = {
    timestampMs: entry.timestampMs ?? Date.now(),
    vaultId: entry.vaultId,
    dwalletId: entry.dwalletId,
    kind: entry.kind,
    digest: entry.digest,
    prev: entry.prev,
    next: entry.next,
    detail: entry.detail,
  };
  const existing = await read(entry.vaultId, entry.dwalletId);
  existing.push(finalized);
  while (existing.length > MAX_ENTRIES_PER_DWALLET) existing.shift();
  await write(entry.vaultId, entry.dwalletId, existing);
}

/** read entries (oldest-first) for a specific dWallet. caller can reverse for newest-first. */
export async function listPolicyAuditEntries(
  vaultId: string,
  dwalletId: string,
  limit?: number,
): Promise<PolicyAuditEntry[]> {
  const all = await read(vaultId, dwalletId);
  if (typeof limit === 'number' && limit > 0 && all.length > limit) {
    return all.slice(all.length - limit);
  }
  return all;
}

/** wipe local audit state for a specific dWallet. on-chain events remain queryable. */
export async function clearPolicyAuditEntries(vaultId: string, dwalletId: string): Promise<void> {
  const key = storageKey(vaultId, dwalletId);
  return new Promise((resolve, reject) => {
    chrome.storage.local.remove([key], () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

/** Wipe audit state for every dWallet in a vault. Used by `removeVault`. */
export async function clearAllPolicyAuditForVault(vaultId: string): Promise<void> {
  const prefix = VAULT_SCOPED_KEYS.policyAuditPrefix(vaultId);
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

/** convenience for tests that need to seed entries. */
export const __test__ = { MAX_ENTRIES_PER_DWALLET };
