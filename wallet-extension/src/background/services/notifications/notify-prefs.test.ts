import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getNotifyPrefs,
  setNotifyPrefs,
  getNotifyCursors,
  setNotifyCursors,
  getCursorFor,
  setCursorFor,
  getPriceAlerts,
  addPriceAlert,
  removePriceAlert,
  markPriceAlertFired,
  rearmPriceAlert,
} from './notify-prefs';
import { DEFAULT_NOTIFY_PREFS, MAX_PRICE_ALERTS } from './types';

// in-memory chrome.storage.local stub - same pattern as alerts.test.ts
const storageMem: Record<string, unknown> = {};

beforeEach(() => {
  for (const k of Object.keys(storageMem)) delete storageMem[k];
  (globalThis as unknown as { chrome: unknown }).chrome = {
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
  };
  // stable uuid generation so tests don't need to match random values
  vi.spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-0000-0000-000000000001' as ReturnType<typeof crypto.randomUUID>);
});

describe('notify prefs', () => {
  it('returns defaults when storage is empty', async () => {
    const prefs = await getNotifyPrefs();
    expect(prefs).toEqual(DEFAULT_NOTIFY_PREFS);
  });

  it('merges partial overrides with defaults', async () => {
    storageMem['chromatika_notify_prefs_v1'] = { enabled: false };
    const prefs = await getNotifyPrefs();
    expect(prefs.enabled).toBe(false);
    expect(prefs.channels).toEqual(DEFAULT_NOTIFY_PREFS.channels);
    expect(prefs.muted).toBe(DEFAULT_NOTIFY_PREFS.muted);
  });

  it('round-trips a full prefs write', async () => {
    const updated = { ...DEFAULT_NOTIFY_PREFS, enabled: false, muted: true };
    await setNotifyPrefs(updated);
    const got = await getNotifyPrefs();
    expect(got).toEqual(updated);
  });
});

describe('activity cursors', () => {
  it('returns empty object when storage is empty', async () => {
    expect(await getNotifyCursors()).toEqual({});
  });

  it('getCursorFor returns null for unknown key', async () => {
    expect(await getCursorFor('sui:0xabc')).toBeNull();
  });

  it('setCursorFor persists and getCursorFor retrieves', async () => {
    const entry = { lastCursor: 'abc123', lastPollAtMs: 1_700_000_000_000 };
    await setCursorFor('sui:0xabc', entry);
    expect(await getCursorFor('sui:0xabc')).toEqual(entry);
  });

  it('setNotifyCursors + getNotifyCursors round-trips multiple keys', async () => {
    const cursors = {
      'sol:addr1': { lastCursor: 'sig-a', lastPollAtMs: 1_000 },
      'evm:addr2': { lastCursor: '0xblock', lastPollAtMs: 2_000 },
    };
    await setNotifyCursors(cursors);
    expect(await getNotifyCursors()).toEqual(cursors);
  });

  it('setCursorFor does not clobber other keys', async () => {
    await setCursorFor('sol:a', { lastCursor: 'v1', lastPollAtMs: 1_000 });
    await setCursorFor('sol:b', { lastCursor: 'v2', lastPollAtMs: 2_000 });
    expect(await getCursorFor('sol:a')).toEqual({ lastCursor: 'v1', lastPollAtMs: 1_000 });
    expect(await getCursorFor('sol:b')).toEqual({ lastCursor: 'v2', lastPollAtMs: 2_000 });
  });
});

describe('price alerts', () => {
  it('getPriceAlerts returns empty store when storage is empty', async () => {
    expect(await getPriceAlerts()).toEqual({ alerts: [] });
  });

  it('addPriceAlert adds an alert and getPriceAlerts retrieves it', async () => {
    const alert = await addPriceAlert('BTC', 'above', 100_000);
    expect(alert.symbol).toBe('BTC');
    expect(alert.direction).toBe('above');
    expect(alert.thresholdUsd).toBe(100_000);
    expect(alert.id).toBe('00000000-0000-0000-0000-000000000001');
    expect(alert.firedAtMs).toBeUndefined();

    const store = await getPriceAlerts();
    expect(store.alerts).toHaveLength(1);
    expect(store.alerts[0]).toEqual(alert);
  });

  it('addPriceAlert upcases the symbol', async () => {
    const alert = await addPriceAlert('eth', 'below', 2_000);
    expect(alert.symbol).toBe('ETH');
  });

  it('addPriceAlert throws when MAX_PRICE_ALERTS is reached', async () => {
    // fill up to the cap
    for (let i = 0; i < MAX_PRICE_ALERTS; i++) {
      // rotate the mock uuid so we don't conflict on uniqueness (storage just appends)
      vi.spyOn(crypto, 'randomUUID').mockReturnValue(`00000000-0000-0000-0000-${String(i).padStart(12, '0')}` as ReturnType<typeof crypto.randomUUID>);
      await addPriceAlert('BTC', 'above', i);
    }
    await expect(addPriceAlert('ETH', 'below', 1)).rejects.toThrow('max price alerts reached');
  });

  it('removePriceAlert removes by id', async () => {
    const a = await addPriceAlert('BTC', 'above', 100_000);
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-0000-0000-000000000002' as ReturnType<typeof crypto.randomUUID>);
    const b = await addPriceAlert('ETH', 'below', 2_000);

    await removePriceAlert(a.id);
    const store = await getPriceAlerts();
    expect(store.alerts).toHaveLength(1);
    expect(store.alerts[0]!.id).toBe(b.id);
  });

  it('removePriceAlert is a no-op for unknown id', async () => {
    await addPriceAlert('BTC', 'above', 100_000);
    await removePriceAlert('does-not-exist');
    expect((await getPriceAlerts()).alerts).toHaveLength(1);
  });

  it('markPriceAlertFired stamps firedAtMs', async () => {
    const before = Date.now();
    const alert = await addPriceAlert('BTC', 'above', 100_000);
    await markPriceAlertFired(alert.id);
    const store = await getPriceAlerts();
    const updated = store.alerts[0]!;
    expect(updated.firedAtMs).toBeGreaterThanOrEqual(before);
    expect(typeof updated.firedAtMs).toBe('number');
  });

  it('rearmPriceAlert removes firedAtMs', async () => {
    const alert = await addPriceAlert('BTC', 'above', 100_000);
    await markPriceAlertFired(alert.id);
    await rearmPriceAlert(alert.id);
    const store = await getPriceAlerts();
    expect(store.alerts[0]!.firedAtMs).toBeUndefined();
  });
});
