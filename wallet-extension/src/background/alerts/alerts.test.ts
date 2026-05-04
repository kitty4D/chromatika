/**
 * Tests for the safety-broadcast alerts surface.
 *
 * Strategy:
 *   - derive the deterministic dev publisher key in-memory (same HKDF seed as the CLI)
 *   - sign / verify sample alerts to exercise the canonical-bytes signing pipeline
 *   - exercise mergeNewAlerts dedupe + activeAlertsFromState filtering by stubbing chrome.storage
 *
 * No real network or chrome runtime is exercised; all of that is wrapped at higher layers
 * (alerts-fetch.ts uses fetch directly, tested by the build smoke; alerts-actions.ts touches
 * declarativeNetRequest + notifications which are e2e territory).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import * as ed25519 from '@noble/ed25519';
import { hashes as edHashes } from '@noble/ed25519';
import {
  type UnsignedAlertV1,
  type SignedAlertV1,
  canonicalAlertBytes,
  canonicalJsonStringify,
  effectiveExpiresAtMs,
  isExpired,
  unsignedView,
} from '@/background/alerts/alerts-types';
import { verifySignedAlert } from '@/background/alerts/alerts-verify';
import { PLACEHOLDER_DEV_PUBLISHER_PUBKEY_B64 } from '@/background/alerts/alerts-publishers';
import {
  mergeNewAlerts,
  activeAlertsFromState,
  dismissAlert,
  getAlertsState,
  clearAlertsForDev,
} from '@/background/alerts/alerts-store';

edHashes.sha512 = sha512;

// In-memory chrome.storage.local stub. Mirrors the pattern in wallet-exists.test.ts.
const storageMem: Record<string, unknown> = {};
const origChrome = globalThis.chrome;
beforeEach(() => {
  for (const k of Object.keys(storageMem)) delete storageMem[k];
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn((keys: string[], cb: (r: Record<string, unknown>) => void) => {
          const out: Record<string, unknown> = {};
          for (const k of keys) out[k] = storageMem[k];
          cb(out);
        }),
        set: vi.fn((kv: Record<string, unknown>, cb: () => void) => {
          for (const [k, v] of Object.entries(kv)) storageMem[k] = v;
          cb();
        }),
      },
    },
    runtime: {},
  });
});
afterEach(() => {
  if (origChrome !== undefined) {
    vi.stubGlobal('chrome', origChrome);
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function toB64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

async function getDevPriv(): Promise<Uint8Array> {
  const seed = new TextEncoder().encode('chromatika-dev-publisher-v0');
  const ikm = sha256(seed);
  return hkdf(sha256, ikm, new Uint8Array(0), new TextEncoder().encode('chromatika.dev-publisher.v0'), 32);
}

async function signWithDevKey(unsigned: UnsignedAlertV1): Promise<SignedAlertV1> {
  const priv = await getDevPriv();
  const msg = canonicalAlertBytes(unsigned);
  const sig = await ed25519.sign(msg, priv);
  return { ...unsigned, signatureB64: toB64(sig) };
}

function buildUnsigned(overrides: Partial<UnsignedAlertV1> = {}): UnsignedAlertV1 {
  const now = Date.now();
  return {
    v: 1,
    id: `t-${Math.random().toString(36).slice(2)}`,
    severity: 'warning',
    timestampMs: now,
    expiresAtMs: now + 60_000,
    affectedDomains: ['evil.example'],
    titleShort: 'test title',
    bodyLong: 'test body',
    publisherKeyB64: PLACEHOLDER_DEV_PUBLISHER_PUBKEY_B64,
    ...overrides,
  };
}

describe('canonicalJsonStringify', () => {
  it('sorts object keys alphabetically (top + nested)', () => {
    const a = canonicalJsonStringify({ b: 1, a: 2, c: { z: 1, y: 2, x: 3 } });
    expect(a).toBe('{"a":2,"b":1,"c":{"x":3,"y":2,"z":1}}');
  });

  it('drops undefined fields', () => {
    expect(canonicalJsonStringify({ a: 1, b: undefined, c: 3 })).toBe('{"a":1,"c":3}');
  });

  it('handles arrays without sorting their elements', () => {
    expect(canonicalJsonStringify({ a: [3, 1, 2] })).toBe('{"a":[3,1,2]}');
  });

  it('throws on bigint and non-finite numbers', () => {
    expect(() => canonicalJsonStringify({ a: 1n })).toThrow();
    expect(() => canonicalJsonStringify({ a: Number.POSITIVE_INFINITY })).toThrow();
  });
});

describe('verifySignedAlert', () => {
  it('verifies a valid alert signed by an allowlisted publisher', async () => {
    const signed = await signWithDevKey(buildUnsigned());
    const res = await verifySignedAlert(signed);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.alert.id).toBe(signed.id);
    }
  });

  it('rejects an alert signed by an unknown publisher', async () => {
    const otherPriv = ed25519.utils.randomSecretKey();
    const otherPub = await ed25519.getPublicKey(otherPriv);
    const unsigned = buildUnsigned({ publisherKeyB64: toB64(otherPub) });
    const sig = await ed25519.sign(canonicalAlertBytes(unsigned), otherPriv);
    const signed: SignedAlertV1 = { ...unsigned, signatureB64: toB64(sig) };
    const res = await verifySignedAlert(signed);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('unknown-publisher');
  });

  it('rejects a tampered body even when the original sig is intact', async () => {
    const signed = await signWithDevKey(buildUnsigned());
    const tampered: SignedAlertV1 = { ...signed, bodyLong: 'pwned' };
    const res = await verifySignedAlert(tampered);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('bad-signature');
  });

  it('rejects a corrupted signature', async () => {
    const signed = await signWithDevKey(buildUnsigned());
    const corrupted: SignedAlertV1 = {
      ...signed,
      signatureB64: toB64(new Uint8Array(64)), // 64 zero bytes - valid length, invalid content
    };
    const res = await verifySignedAlert(corrupted);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('bad-signature');
  });

  it('rejects timestamps in the far past or far future', async () => {
    const farFuture = await signWithDevKey(buildUnsigned({ timestampMs: Date.now() + 365 * 24 * 60 * 60 * 1000 }));
    const r1 = await verifySignedAlert(farFuture);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.reason).toBe('time-out-of-range');

    const farPast = await signWithDevKey(buildUnsigned({ timestampMs: 1 }));
    const r2 = await verifySignedAlert(farPast);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toBe('time-out-of-range');
  });

  it('rejects shape mismatches (missing fields, wrong types)', async () => {
    const r1 = await verifySignedAlert({ v: 1, id: 'x' });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.reason).toBe('invalid-shape');
  });
});

describe('alerts-store', () => {
  it('mergeNewAlerts dedupes by id', async () => {
    const now = Date.now();
    const a = await signWithDevKey(buildUnsigned({ id: 'a', timestampMs: now }));
    const a2 = await signWithDevKey(buildUnsigned({ id: 'a', timestampMs: now + 1 }));
    const b = await signWithDevKey(buildUnsigned({ id: 'b', timestampMs: now }));

    const first = await mergeNewAlerts([a]);
    expect(first.length).toBe(1);
    const second = await mergeNewAlerts([a2, b]); // a2 is dupe by id, b is new
    expect(second.length).toBe(1);
    expect(second[0]!.id).toBe('b');
  });

  it('activeAlertsFromState filters expired + dismissed and sorts by severity', async () => {
    await clearAlertsForDev();
    const now = Date.now();
    // expiresAtMs MUST be > timestampMs (otherwise the helper falls back to the 7-day default).
    // To make this alert legitimately expired we set both fields in the recent past.
    const expired = await signWithDevKey(
      buildUnsigned({
        id: 'expired',
        timestampMs: now - 60_000,
        expiresAtMs: now - 30_000,
        severity: 'critical',
      }),
    );
    const dismissed = await signWithDevKey(
      buildUnsigned({ id: 'dismissed', timestampMs: now, severity: 'warning' }),
    );
    const liveCritical = await signWithDevKey(
      buildUnsigned({ id: 'live-critical', timestampMs: now, severity: 'critical' }),
    );
    const liveInfo = await signWithDevKey(buildUnsigned({ id: 'live-info', timestampMs: now, severity: 'info' }));
    await mergeNewAlerts([expired, dismissed, liveCritical, liveInfo]);
    await dismissAlert('dismissed');

    const state = await getAlertsState();
    const active = activeAlertsFromState(state);
    expect(active.map((a) => a.id)).toEqual(['live-critical', 'live-info']);
  });
});

describe('expiry helpers', () => {
  it('effectiveExpiresAtMs falls back to default when missing or past timestamp', () => {
    expect(effectiveExpiresAtMs({ timestampMs: 1000, expiresAtMs: 999 })).toBeGreaterThan(1000);
    expect(effectiveExpiresAtMs({ timestampMs: 1000 })).toBe(1000 + 7 * 24 * 60 * 60 * 1000);
    expect(effectiveExpiresAtMs({ timestampMs: 1000, expiresAtMs: 5000 })).toBe(5000);
  });

  it('isExpired returns true for past expiries', async () => {
    const a = await signWithDevKey(buildUnsigned({ timestampMs: 1000, expiresAtMs: 2000 }));
    expect(isExpired(a, 3000)).toBe(true);
    expect(isExpired(a, 1500)).toBe(false);
  });
});

describe('unsignedView', () => {
  it('drops signatureB64 deterministically', async () => {
    const signed = await signWithDevKey(buildUnsigned());
    const unsigned = unsignedView(signed);
    expect((unsigned as { signatureB64?: string }).signatureB64).toBeUndefined();
    expect(unsigned.id).toBe(signed.id);
  });
});
