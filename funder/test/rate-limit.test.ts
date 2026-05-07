/**
 * unit tests for the rate-limit Durable Object. exercises the three rejection reasons
 * (already_funded, daily_cap, lifetime_cap) and the admin clear path.
 *
 * we use the `cloudflare:test` runtime helpers so the DO runs against real workerd storage.
 */

import { describe, expect, it } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { RateLimitDurableObject, utcDayKey } from '../src/rate-limit';

type TestEnv = { RATE_LIMIT: DurableObjectNamespace<RateLimitDurableObject> };

function freshStub(): DurableObjectStub<RateLimitDurableObject> {
  // unique id per test so storage starts clean.
  const id = (env as unknown as TestEnv).RATE_LIMIT.idFromName(
    `test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  return (env as unknown as TestEnv).RATE_LIMIT.get(id);
}

const ADDR_A = '0x' + 'a'.repeat(64);
const ADDR_B = '0x' + 'b'.repeat(64);

describe('utcDayKey', () => {
  it('formats a known epoch as a UTC YYYY-MM-DD prefixed string', () => {
    // 2026-05-05T12:34:56Z
    const t = Date.UTC(2026, 4, 5, 12, 34, 56);
    expect(utcDayKey(t)).toBe('day:2026-05-05');
  });
});

describe('tryAcquire', () => {
  it('returns ok=true on the first call for an unseen address', async () => {
    const stub = freshStub();
    const r = await stub.tryAcquire({ address: ADDR_A, dailyCap: 5, lifetimeCap: null });
    expect(r.ok).toBe(true);
  });

  it('returns already_funded after recordFunding for the same address', async () => {
    const stub = freshStub();
    await stub.recordFunding({ address: ADDR_A });
    const r = await stub.tryAcquire({ address: ADDR_A, dailyCap: 100, lifetimeCap: null });
    expect(r).toMatchObject({ ok: false, reason: 'already_funded' });
  });

  it('treats addresses case-insensitively (normalized to lowercase)', async () => {
    const stub = freshStub();
    await stub.recordFunding({ address: ADDR_A });
    const upper = ADDR_A.toUpperCase();
    const r = await stub.tryAcquire({ address: upper, dailyCap: 100, lifetimeCap: null });
    expect(r).toMatchObject({ ok: false, reason: 'already_funded' });
  });

  it('returns daily_cap when today is full', async () => {
    const stub = freshStub();
    // simulate hitting the cap by calling recordFunding for unique addresses.
    for (let i = 0; i < 3; i++) {
      const addr = '0x' + i.toString(16).padStart(64, '0');
      await stub.recordFunding({ address: addr });
    }
    const r = await stub.tryAcquire({ address: ADDR_B, dailyCap: 3, lifetimeCap: null });
    expect(r).toMatchObject({ ok: false, reason: 'daily_cap', dailyCap: 3, dayCount: 3 });
  });

  it('returns lifetime_cap when the cumulative count is at the cap', async () => {
    const stub = freshStub();
    for (let i = 0; i < 4; i++) {
      const addr = '0x' + (i + 100).toString(16).padStart(64, '0');
      await stub.recordFunding({ address: addr });
    }
    const r = await stub.tryAcquire({ address: ADDR_B, dailyCap: 100, lifetimeCap: 4 });
    expect(r).toMatchObject({ ok: false, reason: 'lifetime_cap', lifetimeCap: 4, lifetimeCount: 4 });
  });

  it('lifetimeCap=null skips lifetime check entirely', async () => {
    const stub = freshStub();
    for (let i = 0; i < 50; i++) {
      const addr = '0x' + (i + 1000).toString(16).padStart(64, '0');
      await stub.recordFunding({ address: addr });
    }
    const r = await stub.tryAcquire({ address: ADDR_B, dailyCap: 100, lifetimeCap: null });
    expect(r.ok).toBe(true);
  });

  it('checks already_funded before daily_cap', async () => {
    // a cap-exhausted day should still report already_funded for an address we previously funded,
    // so the user gets the most accurate reason and clear-then-retry semantics work.
    const stub = freshStub();
    await stub.recordFunding({ address: ADDR_A });
    for (let i = 0; i < 5; i++) {
      const addr = '0x' + (i + 200).toString(16).padStart(64, '0');
      await stub.recordFunding({ address: addr });
    }
    const r = await stub.tryAcquire({ address: ADDR_A, dailyCap: 5, lifetimeCap: null });
    expect(r).toMatchObject({ ok: false, reason: 'already_funded' });
  });
});

describe('clearAddress', () => {
  it('clears a previously-funded address and returns cleared:true', async () => {
    const stub = freshStub();
    await stub.recordFunding({ address: ADDR_A });
    const r1 = await stub.clearAddress(ADDR_A);
    expect(r1).toEqual({ cleared: true });

    // post-clear the address can acquire again
    const r2 = await stub.tryAcquire({ address: ADDR_A, dailyCap: 100, lifetimeCap: null });
    expect(r2.ok).toBe(true);
  });

  it('returns cleared:false for an address that was never funded', async () => {
    const stub = freshStub();
    const r = await stub.clearAddress(ADDR_B);
    expect(r).toEqual({ cleared: false });
  });
});

describe('stats', () => {
  it('returns running totals for the current day + lifetime', async () => {
    const stub = freshStub();
    // exercise the DO via runInDurableObject so we can read the storage shape directly.
    await stub.recordFunding({ address: ADDR_A });
    await stub.recordFunding({ address: ADDR_B });
    const s = await stub.stats();
    expect(s.lifetimeCount).toBe(2);
    expect(s.today.dayCount).toBe(2);
    expect(s.today.dayKey).toMatch(/^day:\d{4}-\d{2}-\d{2}$/);

    // sanity check: the actual DO storage rows match what stats reports.
    const id = (env as unknown as TestEnv).RATE_LIMIT.idFromName('storage-introspect');
    const introspectStub = (env as unknown as TestEnv).RATE_LIMIT.get(id);
    await introspectStub.recordFunding({ address: ADDR_A });
    await runInDurableObject(introspectStub, async (instance, ctx) => {
      const lifetime = await ctx.storage.get<number>('lifetime');
      expect(lifetime).toBe(1);
      // ensure the addr row is keyed by lowercase canonical form.
      const addrRow = await ctx.storage.get<number>(`addr:${ADDR_A.toLowerCase()}`);
      expect(typeof addrRow).toBe('number');
    });
  });
});
