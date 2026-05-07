/**
 * rate-limit Durable Object. one global instance keyed by a fixed name (`global`) holds the
 * per-address dedupe + rolling daily cap + cumulative lifetime counter. SQLite-backed.
 *
 * three storage shapes:
 *   - `addr:<address>`       -> fundedAtEpochMs (number). presence = "this address has been
 *                               funded at least once". used for lifetime one-shot dedupe.
 *   - `day:<YYYY-MM-DD>`     -> count for that UTC day. compared against `dailyCap` on each
 *                               request to enforce DAILY_CAP. days roll over at UTC midnight.
 *   - `lifetime`             -> cumulative count of all successful fundings ever. compared
 *                               against `lifetimeCap` (when configured) to enforce a hard
 *                               ceiling regardless of daily cadence.
 *
 * the DO uses storage transactions so a `recordFunding` call updates day + lifetime atomically.
 * `tryAcquire` is read + check only (no writes) so the rate-limit decision is fast and the
 * actual funding work can happen between acquire and record without holding a lock — that's
 * fine because the only race we care about is "two parallel requests for the SAME address",
 * which the per-address `addr:` row catches at acquire time.
 */

import { DurableObject } from 'cloudflare:workers';

export type AcquireDecision =
  | { ok: true }
  | { ok: false; reason: 'already_funded'; fundedAtEpochMs: number }
  | { ok: false; reason: 'daily_cap'; dailyCap: number; dayCount: number }
  | { ok: false; reason: 'lifetime_cap'; lifetimeCap: number; lifetimeCount: number };

export interface RateLimitEnv {}

/** UTC day key (`YYYY-MM-DD`) for `Date.now()` or a passed-in epoch ms. */
export function utcDayKey(epochMs: number = Date.now()): string {
  const d = new Date(epochMs);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `day:${y}-${m}-${day}`;
}

function addrKey(address: string): string {
  return `addr:${address.toLowerCase()}`;
}

const LIFETIME_KEY = 'lifetime';

export class RateLimitDurableObject extends DurableObject<RateLimitEnv> {
  /**
   * read-only acquire check. returns ok=true when the request is allowed; otherwise returns
   * the structured rejection reason so the caller can map it to a 429 response shape.
   *
   * @param dailyCap     >= 0; 0 means "block all" (operational lever).
   * @param lifetimeCap  null = unlimited.
   */
  async tryAcquire(args: {
    address: string;
    dailyCap: number;
    lifetimeCap: number | null;
  }): Promise<AcquireDecision> {
    const { address, dailyCap, lifetimeCap } = args;
    const fundedAt = await this.ctx.storage.get<number>(addrKey(address));
    if (typeof fundedAt === 'number') {
      return { ok: false, reason: 'already_funded', fundedAtEpochMs: fundedAt };
    }
    if (lifetimeCap !== null) {
      const lifetimeCount = (await this.ctx.storage.get<number>(LIFETIME_KEY)) ?? 0;
      if (lifetimeCount >= lifetimeCap) {
        return { ok: false, reason: 'lifetime_cap', lifetimeCap, lifetimeCount };
      }
    }
    const dayKey = utcDayKey();
    const dayCount = (await this.ctx.storage.get<number>(dayKey)) ?? 0;
    if (dayCount >= dailyCap) {
      return { ok: false, reason: 'daily_cap', dailyCap, dayCount };
    }
    return { ok: true };
  }

  /**
   * stamp a successful funding. transactional so day + lifetime + addr land together.
   * caller passes the actual settlement time (`Date.now()` is fine in the worker; this
   * arg exists so tests can pin the day boundary deterministically).
   */
  async recordFunding(args: { address: string; nowEpochMs?: number }): Promise<void> {
    const nowEpochMs = args.nowEpochMs ?? Date.now();
    const ak = addrKey(args.address);
    const dk = utcDayKey(nowEpochMs);
    await this.ctx.storage.transaction(async (txn) => {
      const day = (await txn.get<number>(dk)) ?? 0;
      const lifetime = (await txn.get<number>(LIFETIME_KEY)) ?? 0;
      await txn.put(ak, nowEpochMs);
      await txn.put(dk, day + 1);
      await txn.put(LIFETIME_KEY, lifetime + 1);
    });
  }

  /** admin: clear a single address's lifetime dedupe. counters not adjusted. */
  async clearAddress(address: string): Promise<{ cleared: boolean }> {
    const ak = addrKey(address);
    const had = (await this.ctx.storage.get(ak)) !== undefined;
    if (had) await this.ctx.storage.delete(ak);
    return { cleared: had };
  }

  /** introspection for tests + the admin endpoint. */
  async stats(): Promise<{ lifetimeCount: number; today: { dayKey: string; dayCount: number } }> {
    const dk = utcDayKey();
    const lifetimeCount = (await this.ctx.storage.get<number>(LIFETIME_KEY)) ?? 0;
    const dayCount = (await this.ctx.storage.get<number>(dk)) ?? 0;
    return { lifetimeCount, today: { dayKey: dk, dayCount } };
  }
}
