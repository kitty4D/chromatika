/**
 * tests for the MCP policy-gate pre-flight check. mocks session + storage + read so all
 * branches are exercised: no-link, no-package, panicked, over-cap, cool-down, under-cap.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// in-memory swappable mocks (same pattern as direct-ed25519-backend.test.ts).
let mockPackage: { packageId: string; setAtMs: number; label?: string } | null = null;
let mockLink: unknown | null = null;
let mockSnapshot: unknown | null = null;
let mockReadThrows = false;

vi.mock('@/background/session', () => ({
  getSession: () => ({
    activeVaultId: 'vault-test',
    suiClient: { core: { getObjects: () => Promise.resolve({ objects: [] }) } } as unknown,
  }),
}));

vi.mock('@/background/policy-vault/policy-vault-storage', async (orig) => {
  const actual = await orig<typeof import('@/background/policy-vault/policy-vault-storage')>();
  return {
    ...actual,
    getPolicyPackageConfig: () => Promise.resolve(mockPackage),
    getPolicyVaultLink: () => Promise.resolve(mockLink),
  };
});

vi.mock('@/background/policy-vault/policy-vault-read', () => ({
  readPolicyVaultSnapshot: () => {
    if (mockReadThrows) return Promise.reject(new Error('graphql blip'));
    return Promise.resolve(mockSnapshot);
  },
}));

const VALID_PKG = '0x' + 'a'.repeat(64);
const VALID_VAULT = '0x' + 'b'.repeat(64);

beforeEach(() => {
  mockPackage = null;
  mockLink = null;
  mockSnapshot = null;
  mockReadThrows = false;
});

afterEach(() => {
  vi.resetModules();
});

function snap(o: Partial<{
  panicked: boolean;
  panicAtMs: number;
  unfreezeDelayMs: number;
  unfreezeUnlocksAtMs: number;
  dailyCapMicros: string;
  spentTodayMicros: string;
  coolDownMs: number;
  lastSignAtMs: number;
  actuators: string[];
  hasRescueAddress: boolean;
  ikaBalance: string;
  suiBalance: string;
  presignsRemaining: number;
  epochDay: number;
}>) {
  return {
    panicked: false,
    panicAtMs: 0,
    unfreezeDelayMs: 0,
    unfreezeUnlocksAtMs: 0,
    dailyCapMicros: '50000000',
    spentTodayMicros: '5000000',
    coolDownMs: 0,
    lastSignAtMs: 0,
    actuators: [],
    hasRescueAddress: false,
    ikaBalance: '0',
    suiBalance: '0',
    presignsRemaining: 3,
    epochDay: 19676,
    ...o,
  };
}

describe('maybeSkipPopupForPolicy', () => {
  it('returns no-link when active vault has no policy link', async () => {
    mockPackage = { packageId: VALID_PKG, setAtMs: 0 };
    mockLink = null;
    const m = await import('./mcp-policy-gate');
    const r = await m.maybeSkipPopupForPolicy({ declaredValueMicros: 1_000_000n });
    expect(r.skipPopup).toBe(false);
    if (!r.skipPopup) expect(r.reason).toBe('no-link');
  });

  it('returns no-package when package config is missing', async () => {
    mockPackage = null;
    mockLink = { vaultObjectId: VALID_VAULT };
    const m = await import('./mcp-policy-gate');
    const r = await m.maybeSkipPopupForPolicy({ declaredValueMicros: 1_000_000n });
    expect(r.skipPopup).toBe(false);
    if (!r.skipPopup) expect(r.reason).toBe('no-package');
  });

  it('returns panicked when snapshot.panicked === true', async () => {
    mockPackage = { packageId: VALID_PKG, setAtMs: 0 };
    mockLink = { vaultObjectId: VALID_VAULT };
    mockSnapshot = snap({ panicked: true });
    const m = await import('./mcp-policy-gate');
    const r = await m.maybeSkipPopupForPolicy({ declaredValueMicros: 1_000_000n });
    expect(r.skipPopup).toBe(false);
    if (!r.skipPopup) expect(r.reason).toBe('panicked');
  });

  it('returns over-cap when declared value exceeds remaining cap', async () => {
    mockPackage = { packageId: VALID_PKG, setAtMs: 0 };
    mockLink = { vaultObjectId: VALID_VAULT };
    mockSnapshot = snap({ dailyCapMicros: '50000000', spentTodayMicros: '49000000' });
    // remaining = 1_000_000; declared = 2_000_000 -> over cap
    const m = await import('./mcp-policy-gate');
    const r = await m.maybeSkipPopupForPolicy({ declaredValueMicros: 2_000_000n });
    expect(r.skipPopup).toBe(false);
    if (!r.skipPopup) expect(r.reason).toBe('over-cap');
  });

  it('returns cool-down when within cool-down window', async () => {
    mockPackage = { packageId: VALID_PKG, setAtMs: 0 };
    mockLink = { vaultObjectId: VALID_VAULT };
    const now = Date.now();
    mockSnapshot = snap({
      coolDownMs: 60_000,
      lastSignAtMs: now - 10_000, // 10s ago, cool-down 60s, so 50s left
    });
    const m = await import('./mcp-policy-gate');
    const r = await m.maybeSkipPopupForPolicy({ declaredValueMicros: 1_000n });
    expect(r.skipPopup).toBe(false);
    if (!r.skipPopup) expect(r.reason).toBe('cool-down');
  });

  it('returns snapshot-failed when read throws', async () => {
    mockPackage = { packageId: VALID_PKG, setAtMs: 0 };
    mockLink = { vaultObjectId: VALID_VAULT };
    mockReadThrows = true;
    const m = await import('./mcp-policy-gate');
    const r = await m.maybeSkipPopupForPolicy({ declaredValueMicros: 1_000n });
    expect(r.skipPopup).toBe(false);
    if (!r.skipPopup) expect(r.reason).toBe('snapshot-failed');
  });

  it('returns snapshot-failed when read returns null', async () => {
    mockPackage = { packageId: VALID_PKG, setAtMs: 0 };
    mockLink = { vaultObjectId: VALID_VAULT };
    mockSnapshot = null;
    const m = await import('./mcp-policy-gate');
    const r = await m.maybeSkipPopupForPolicy({ declaredValueMicros: 1_000n });
    expect(r.skipPopup).toBe(false);
    if (!r.skipPopup) expect(r.reason).toBe('snapshot-failed');
  });

  it('skips popup when under cap + non-panicked + non-cool-down', async () => {
    mockPackage = { packageId: VALID_PKG, setAtMs: 0 };
    mockLink = { vaultObjectId: VALID_VAULT };
    mockSnapshot = snap({ dailyCapMicros: '50000000', spentTodayMicros: '5000000' });
    // remaining = 45_000_000; declared = 1_000_000 -> under cap
    const m = await import('./mcp-policy-gate');
    const r = await m.maybeSkipPopupForPolicy({ declaredValueMicros: 1_000_000n });
    expect(r.skipPopup).toBe(true);
    if (r.skipPopup) expect(r.remainingMicros).toBe(45_000_000n);
  });

  it('skips popup when cap = 0 (unbounded) + non-panicked', async () => {
    mockPackage = { packageId: VALID_PKG, setAtMs: 0 };
    mockLink = { vaultObjectId: VALID_VAULT };
    mockSnapshot = snap({ dailyCapMicros: '0', spentTodayMicros: '0' });
    const m = await import('./mcp-policy-gate');
    const r = await m.maybeSkipPopupForPolicy({ declaredValueMicros: 1_000_000_000n });
    expect(r.skipPopup).toBe(true);
  });

  it('with requireUnderCap=false (sign-only) ignores cap; only checks panic + cool-down', async () => {
    mockPackage = { packageId: VALID_PKG, setAtMs: 0 };
    mockLink = { vaultObjectId: VALID_VAULT };
    mockSnapshot = snap({ dailyCapMicros: '1000', spentTodayMicros: '500' });
    // declared 100_000 > remaining 500, but we say requireUnderCap: false
    const m = await import('./mcp-policy-gate');
    const r = await m.maybeSkipPopupForPolicy({
      declaredValueMicros: 100_000n,
      requireUnderCap: false,
    });
    expect(r.skipPopup).toBe(true);
  });

  it('cool-down past = under cap -> skip', async () => {
    mockPackage = { packageId: VALID_PKG, setAtMs: 0 };
    mockLink = { vaultObjectId: VALID_VAULT };
    mockSnapshot = snap({
      coolDownMs: 60_000,
      lastSignAtMs: Date.now() - 120_000, // 2min ago, cool-down 60s -> past
      dailyCapMicros: '50000000',
      spentTodayMicros: '5000000',
    });
    const m = await import('./mcp-policy-gate');
    const r = await m.maybeSkipPopupForPolicy({ declaredValueMicros: 1_000_000n });
    expect(r.skipPopup).toBe(true);
  });
});
