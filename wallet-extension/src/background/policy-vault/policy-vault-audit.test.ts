/**
 * tests for the per-vault audit log. mocks chrome.storage so each test sees a fresh in-mem
 * store. validates append + FIFO rotation + isolation across vaults + clear.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type ChromeStorageMock = {
  store: Record<string, unknown>;
  get: (keys: string[], cb: (r: Record<string, unknown>) => void) => void;
  set: (items: Record<string, unknown>, cb: () => void) => void;
  remove: (keys: string[], cb: () => void) => void;
};

const storageMock: ChromeStorageMock = {
  store: {},
  get(keys, cb) {
    const out: Record<string, unknown> = {};
    for (const k of keys) if (k in this.store) out[k] = this.store[k];
    cb(out);
  },
  set(items, cb) {
    Object.assign(this.store, items);
    cb();
  },
  remove(keys, cb) {
    for (const k of keys) delete this.store[k];
    cb();
  },
};

beforeEach(() => {
  storageMock.store = {};
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: { local: storageMock },
    runtime: { lastError: null },
  };
});

afterEach(() => {
  vi.resetModules();
});

const VAULT_A = 'vault-a';
const VAULT_B = 'vault-b';

describe('policy-vault-audit', () => {
  it('starts empty', async () => {
    const m = await import('./policy-vault-audit');
    const entries = await m.listPolicyAuditEntries(VAULT_A);
    expect(entries).toEqual([]);
  });

  it('appends entries in order; preserves timestampMs', async () => {
    const m = await import('./policy-vault-audit');
    await m.appendPolicyAuditEntry({ vaultId: VAULT_A, kind: 'opt-in', timestampMs: 100 });
    await m.appendPolicyAuditEntry({
      vaultId: VAULT_A,
      kind: 'set-daily-cap',
      timestampMs: 200,
      prev: '0',
      next: '50000000',
    });
    await m.appendPolicyAuditEntry({ vaultId: VAULT_A, kind: 'panic', timestampMs: 300 });
    const got = await m.listPolicyAuditEntries(VAULT_A);
    expect(got).toHaveLength(3);
    expect(got[0]!.kind).toBe('opt-in');
    expect(got[1]!.kind).toBe('set-daily-cap');
    expect(got[1]!.prev).toBe('0');
    expect(got[1]!.next).toBe('50000000');
    expect(got[2]!.kind).toBe('panic');
    expect(got[0]!.timestampMs).toBe(100);
  });

  it('auto-stamps timestampMs when omitted', async () => {
    const m = await import('./policy-vault-audit');
    const before = Date.now();
    await m.appendPolicyAuditEntry({ vaultId: VAULT_A, kind: 'unfreeze' });
    const after = Date.now();
    const got = await m.listPolicyAuditEntries(VAULT_A);
    expect(got[0]!.timestampMs).toBeGreaterThanOrEqual(before);
    expect(got[0]!.timestampMs).toBeLessThanOrEqual(after);
  });

  it('isolates per-vault keys', async () => {
    const m = await import('./policy-vault-audit');
    await m.appendPolicyAuditEntry({ vaultId: VAULT_A, kind: 'opt-in', timestampMs: 100 });
    await m.appendPolicyAuditEntry({ vaultId: VAULT_B, kind: 'panic', timestampMs: 200 });
    const a = await m.listPolicyAuditEntries(VAULT_A);
    const b = await m.listPolicyAuditEntries(VAULT_B);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]!.kind).toBe('opt-in');
    expect(b[0]!.kind).toBe('panic');
  });

  it('FIFO rotates at MAX_ENTRIES_PER_VAULT (200)', async () => {
    const m = await import('./policy-vault-audit');
    // push 250 entries; oldest 50 should be evicted.
    for (let i = 0; i < 250; i++) {
      await m.appendPolicyAuditEntry({
        vaultId: VAULT_A,
        kind: 'sign-cap-applied',
        timestampMs: i,
        next: String(i),
      });
    }
    const got = await m.listPolicyAuditEntries(VAULT_A);
    expect(got).toHaveLength(200);
    // first entry should now be entry #50 (250 - 200).
    expect(got[0]!.next).toBe('50');
    expect(got[199]!.next).toBe('249');
  });

  it('limit param returns the most recent N entries', async () => {
    const m = await import('./policy-vault-audit');
    for (let i = 0; i < 10; i++) {
      await m.appendPolicyAuditEntry({
        vaultId: VAULT_A,
        kind: 'sign-cap-applied',
        timestampMs: i,
        next: String(i),
      });
    }
    const got = await m.listPolicyAuditEntries(VAULT_A, 3);
    expect(got).toHaveLength(3);
    expect(got[0]!.next).toBe('7');
    expect(got[1]!.next).toBe('8');
    expect(got[2]!.next).toBe('9');
  });

  it('clear removes all entries for a vault but leaves other vaults intact', async () => {
    const m = await import('./policy-vault-audit');
    await m.appendPolicyAuditEntry({ vaultId: VAULT_A, kind: 'opt-in' });
    await m.appendPolicyAuditEntry({ vaultId: VAULT_B, kind: 'opt-in' });
    expect((await m.listPolicyAuditEntries(VAULT_A)).length).toBe(1);
    expect((await m.listPolicyAuditEntries(VAULT_B)).length).toBe(1);
    await m.clearPolicyAuditEntries(VAULT_A);
    expect((await m.listPolicyAuditEntries(VAULT_A)).length).toBe(0);
    expect((await m.listPolicyAuditEntries(VAULT_B)).length).toBe(1);
  });

  it('handles all kind values without errors', async () => {
    const m = await import('./policy-vault-audit');
    const kinds = [
      'opt-in',
      'panic',
      'unfreeze',
      'set-daily-cap',
      'set-cool-down',
      'set-rescue-address',
      'add-actuator',
      'remove-actuator',
      'replenish-presign',
      'top-up-ika',
      'top-up-sui',
      'sign-cap-applied',
      'sign-aborted-over-cap',
      'sign-aborted-panicked',
      'sign-aborted-cool-down',
      'local-link-cleared',
    ] as const;
    for (const k of kinds) {
      await m.appendPolicyAuditEntry({ vaultId: VAULT_A, kind: k });
    }
    const got = await m.listPolicyAuditEntries(VAULT_A);
    expect(got).toHaveLength(kinds.length);
  });
});
