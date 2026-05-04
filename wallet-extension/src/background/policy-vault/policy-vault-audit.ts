/**
 * per-vault audit log of every Policy Vault decision the user makes via chromatika.
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
 * storage: `chromatika_policy_audit_v1_<vaultId>` -> `AuditEntry[]`. capped at 200 entries
 * per vault, FIFO rotation. cleared on `clearLocalPolicyVaultLink`.
 *
 * entries are append-only from chromatika's perspective. the user can `clearPolicyAuditLog`
 * to wipe local state (the on-chain events remain queryable forever via Sui explorers).
 */

import { VAULT_SCOPED_KEYS } from '@/background/storage';

const MAX_ENTRIES_PER_VAULT = 200;

function storageKey(vaultId: string): string {
  return VAULT_SCOPED_KEYS.policyAudit(vaultId);
}

/**
 * single audit entry. `kind` is the canonical action; `prev` / `next` capture the before/after
 * state for setters; `digest` is the Sui tx hash when the entry corresponds to an executed
 * mutation (omitted for client-side-only events like sign aborts).
 */
export interface PolicyAuditEntry {
  vaultId: string;
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
    | 'set-stage-delay';
  /** Sui tx digest when applicable. */
  digest?: string;
  /** before-value for setters (e.g. previous cap as micro-USD string). */
  prev?: string;
  /** after-value for setters. */
  next?: string;
  /** free-form note: error reason, asset symbol, recipient hint, etc. */
  detail?: string;
}

async function read(vaultId: string): Promise<PolicyAuditEntry[]> {
  const key = storageKey(vaultId);
  return new Promise((resolve) => {
    chrome.storage.local.get([key], (r) => {
      const v = r[key];
      if (Array.isArray(v)) resolve(v as PolicyAuditEntry[]);
      else resolve([]);
    });
  });
}

async function write(vaultId: string, entries: PolicyAuditEntry[]): Promise<void> {
  const key = storageKey(vaultId);
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [key]: entries }, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

/** append a new entry; auto-rotates FIFO at MAX_ENTRIES_PER_VAULT. */
export async function appendPolicyAuditEntry(
  entry: Omit<PolicyAuditEntry, 'timestampMs'> & { timestampMs?: number },
): Promise<void> {
  const finalized: PolicyAuditEntry = {
    timestampMs: entry.timestampMs ?? Date.now(),
    vaultId: entry.vaultId,
    kind: entry.kind,
    digest: entry.digest,
    prev: entry.prev,
    next: entry.next,
    detail: entry.detail,
  };
  const existing = await read(entry.vaultId);
  existing.push(finalized);
  while (existing.length > MAX_ENTRIES_PER_VAULT) existing.shift();
  await write(entry.vaultId, existing);
}

/** read entries (oldest-first). caller can reverse for newest-first display. */
export async function listPolicyAuditEntries(
  vaultId: string,
  limit?: number,
): Promise<PolicyAuditEntry[]> {
  const all = await read(vaultId);
  if (typeof limit === 'number' && limit > 0 && all.length > limit) {
    return all.slice(all.length - limit);
  }
  return all;
}

/** wipe local audit state for a vault. on-chain events remain queryable. */
export async function clearPolicyAuditEntries(vaultId: string): Promise<void> {
  const key = storageKey(vaultId);
  return new Promise((resolve, reject) => {
    chrome.storage.local.remove([key], () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

/** convenience for tests that need to seed entries. */
export const __test__ = { MAX_ENTRIES_PER_VAULT };
