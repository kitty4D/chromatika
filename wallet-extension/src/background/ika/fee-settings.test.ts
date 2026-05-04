import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_REFILL_LAMPORTS,
  DEFAULT_THRESHOLD_LAMPORTS,
  clearIkaFeeSettings,
  defaultIkaFeeSettings,
  getIkaFeeSettings,
  setIkaFeeSettings,
  updateIkaFeeSettings,
} from '@/background/ika/fee-settings';

const store: Record<string, unknown> = {};

function installChromeStorageMock() {
  const g = globalThis as unknown as {
    chrome: {
      storage: {
        local: {
          get: (keys: string | string[], cb: (r: Record<string, unknown>) => void) => void;
          set: (items: Record<string, unknown>, cb?: () => void) => void;
          remove: (keys: string | string[], cb?: () => void) => void;
        };
      };
      runtime: { lastError?: { message: string } };
    };
  };
  g.chrome = {
    storage: {
      local: {
        get(keys, cb) {
          const ks = Array.isArray(keys) ? keys : [keys];
          const r: Record<string, unknown> = {};
          for (const k of ks) {
            if (k in store) r[k] = store[k];
          }
          cb(r);
        },
        set(items, cb) {
          Object.assign(store, items);
          cb?.();
        },
        remove(keys, cb) {
          const ks = Array.isArray(keys) ? keys : [keys];
          for (const k of ks) delete store[k];
          cb?.();
        },
      },
    },
    runtime: { lastError: undefined },
  };
}

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  installChromeStorageMock();
});

describe('IkaFeeSettings', () => {
  it('returns sensible defaults for a never-configured vault', async () => {
    const s = await getIkaFeeSettings('fresh-vault');
    expect(s.mode).toBe('in_extension');
    expect(s.autoRefill).toBe(true);
    expect(s.refillLamports).toBe(DEFAULT_REFILL_LAMPORTS);
    expect(s.thresholdLamports).toBe(DEFAULT_THRESHOLD_LAMPORTS);
  });

  it('round-trips bigint lamport amounts via storage (no precision loss)', async () => {
    const huge = 999_999_999_999_999n;
    await setIkaFeeSettings('round-trip-vault', {
      mode: 'in_extension',
      autoRefill: false,
      refillLamports: huge,
      thresholdLamports: 12345n,
    });
    const r = await getIkaFeeSettings('round-trip-vault');
    expect(r.refillLamports).toBe(huge);
    expect(r.thresholdLamports).toBe(12345n);
    expect(r.autoRefill).toBe(false);
  });

  it('updateIkaFeeSettings: partial patch leaves untouched fields alone', async () => {
    await setIkaFeeSettings('partial-vault', defaultIkaFeeSettings());
    const next = await updateIkaFeeSettings('partial-vault', { mode: 'seeker_direct' });
    expect(next.mode).toBe('seeker_direct');
    expect(next.autoRefill).toBe(true); // unchanged
    expect(next.refillLamports).toBe(DEFAULT_REFILL_LAMPORTS); // unchanged
    expect(next.thresholdLamports).toBe(DEFAULT_THRESHOLD_LAMPORTS); // unchanged
  });

  it('clearIkaFeeSettings removes the row so subsequent reads fall back to defaults', async () => {
    await setIkaFeeSettings('removable-vault', {
      mode: 'seeker_direct',
      autoRefill: false,
      refillLamports: 5_000_000n,
      thresholdLamports: 1_000_000n,
    });
    await clearIkaFeeSettings('removable-vault');
    const after = await getIkaFeeSettings('removable-vault');
    // defaults again, not the previously-set seeker_direct values.
    expect(after.mode).toBe('in_extension');
    expect(after.autoRefill).toBe(true);
  });

  it('vaults are isolated - setting one does not affect another', async () => {
    await setIkaFeeSettings('vault-a', { ...defaultIkaFeeSettings(), mode: 'seeker_direct' });
    await setIkaFeeSettings('vault-b', { ...defaultIkaFeeSettings(), mode: 'in_extension' });
    const a = await getIkaFeeSettings('vault-a');
    const b = await getIkaFeeSettings('vault-b');
    expect(a.mode).toBe('seeker_direct');
    expect(b.mode).toBe('in_extension');
  });

  it('defends against malformed lamport strings stored from a buggy older write', async () => {
    // simulate corruption: the persisted field is a string that cannot parse as bigint.
    store['chromatika_ika_fee_settings_v1_corrupt-vault'] = {
      mode: 'in_extension',
      autoRefill: true,
      refillLamports: 'not-a-number',
      thresholdLamports: '1000000',
    };
    const r = await getIkaFeeSettings('corrupt-vault');
    expect(r.refillLamports).toBe(DEFAULT_REFILL_LAMPORTS); // fell back to default
    expect(r.thresholdLamports).toBe(1_000_000n); // valid one parsed through
  });

  it('rejects negative lamport values and falls back to defaults', async () => {
    store['chromatika_ika_fee_settings_v1_neg-vault'] = {
      mode: 'in_extension',
      autoRefill: true,
      refillLamports: '-1',
      thresholdLamports: '-5',
    };
    const r = await getIkaFeeSettings('neg-vault');
    expect(r.refillLamports).toBe(DEFAULT_REFILL_LAMPORTS);
    expect(r.thresholdLamports).toBe(DEFAULT_THRESHOLD_LAMPORTS);
  });
});
