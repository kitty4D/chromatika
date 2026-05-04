/**
 * x402 daily spending caps.
 *
 * two layers, both in USD:
 *   - per-counterparty cap (keyed on lowercase seller host)
 *   - global cap across all sellers
 *
 * the signer (next slice) consults `wouldExceedCaps` synchronously before opening the approval
 * popup. if a payment would breach a cap, the request is rejected pre-signature: the user
 * never sees the popup. this matches the agent-budget control pattern from
 * `skills/x402-everything/references/agent-and-mcp-patterns.md`.
 *
 * spend tracking lives in `x402-receipts.ts` and is summed by host + day at check time. we
 * compute "today" as the user's local-timezone calendar day so e.g. crossing midnight resets
 * the daily window the way humans expect.
 */

import { STORAGE_KEYS } from '@/background/storage';

const KEY = STORAGE_KEYS.X402_CAPS_V1;
const VERSION = 1 as const;

const DEFAULT_PER_COUNTERPARTY_CAP_USD = 5;
const DEFAULT_GLOBAL_CAP_USD: number | null = 25;

export type X402CapsV1 = {
  v: typeof VERSION;
  perCounterpartyDailyCapUsd: Record<string, number>;
  globalDailyCapUsd: number | null;
  /** applied when a new seller has no per-host entry. */
  defaultPerCounterpartyDailyCapUsd: number;
};

const DEFAULTS: X402CapsV1 = {
  v: VERSION,
  perCounterpartyDailyCapUsd: {},
  globalDailyCapUsd: DEFAULT_GLOBAL_CAP_USD,
  defaultPerCounterpartyDailyCapUsd: DEFAULT_PER_COUNTERPARTY_CAP_USD,
};

export async function getX402Caps(): Promise<X402CapsV1> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get([KEY], (r) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      const stored = r[KEY] as X402CapsV1 | undefined;
      if (!stored || stored.v !== VERSION) {
        resolve({ ...DEFAULTS, perCounterpartyDailyCapUsd: { ...DEFAULTS.perCounterpartyDailyCapUsd } });
        return;
      }
      resolve(stored);
    });
  });
}

async function setX402Caps(next: X402CapsV1): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [KEY]: next }, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

/** set / clear a per-host cap. pass `null` to remove the entry (falls back to default). */
export async function setPerCounterpartyCap(host: string, capUsd: number | null): Promise<X402CapsV1> {
  const normalized = host.trim().toLowerCase();
  if (normalized.length === 0) throw new Error('host is required');
  const current = await getX402Caps();
  const next: X402CapsV1 = {
    ...current,
    v: VERSION,
    perCounterpartyDailyCapUsd: { ...current.perCounterpartyDailyCapUsd },
  };
  if (capUsd == null) {
    delete next.perCounterpartyDailyCapUsd[normalized];
  } else {
    if (!Number.isFinite(capUsd) || capUsd < 0) {
      throw new Error(`capUsd must be a non-negative number; got ${capUsd}`);
    }
    next.perCounterpartyDailyCapUsd[normalized] = capUsd;
  }
  await setX402Caps(next);
  return next;
}

export async function setGlobalCap(capUsd: number | null): Promise<X402CapsV1> {
  if (capUsd != null && (!Number.isFinite(capUsd) || capUsd < 0)) {
    throw new Error(`capUsd must be a non-negative number or null; got ${capUsd}`);
  }
  const current = await getX402Caps();
  const next: X402CapsV1 = { ...current, v: VERSION, globalDailyCapUsd: capUsd };
  await setX402Caps(next);
  return next;
}

export async function setDefaultPerCounterpartyCap(capUsd: number): Promise<X402CapsV1> {
  if (!Number.isFinite(capUsd) || capUsd < 0) {
    throw new Error(`capUsd must be a non-negative number; got ${capUsd}`);
  }
  const current = await getX402Caps();
  const next: X402CapsV1 = { ...current, v: VERSION, defaultPerCounterpartyDailyCapUsd: capUsd };
  await setX402Caps(next);
  return next;
}

export function effectivePerCounterpartyCap(caps: X402CapsV1, host: string): number {
  const normalized = host.trim().toLowerCase();
  return caps.perCounterpartyDailyCapUsd[normalized] ?? caps.defaultPerCounterpartyDailyCapUsd;
}

/**
 * local-timezone calendar-day key (YYYY-MM-DD). used to bucket spend for daily caps so
 * crossing midnight resets the window in a human-intuitive way.
 */
export function todayLocalDayKey(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** snapshot used by the synchronous wouldExceedCaps check. */
export type DailySpendSnapshot = {
  /** USD spent today across all sellers. */
  totalUsd: number;
  /** USD spent today per seller host. */
  perHostUsd: Record<string, number>;
};

/** pure check used by the signer + approval popup. spend snapshot is computed from receipts
 * upstream; this just compares against the configured caps. */
export function wouldExceedCaps(args: {
  caps: X402CapsV1;
  spendToday: DailySpendSnapshot;
  paymentUsd: number;
  sellerHost: string;
}): { ok: true } | { ok: false; reason: string } {
  const { caps, spendToday, paymentUsd, sellerHost } = args;
  if (!Number.isFinite(paymentUsd) || paymentUsd < 0) {
    return { ok: false, reason: 'payment amount must be a non-negative number' };
  }
  const host = sellerHost.trim().toLowerCase();
  const perHostCap = effectivePerCounterpartyCap(caps, host);
  const perHostSoFar = spendToday.perHostUsd[host] ?? 0;
  if (perHostSoFar + paymentUsd > perHostCap) {
    return {
      ok: false,
      reason: `per-counterparty daily cap exceeded: ${host} ($${(perHostSoFar + paymentUsd).toFixed(4)} > $${perHostCap.toFixed(2)})`,
    };
  }
  if (caps.globalDailyCapUsd != null) {
    if (spendToday.totalUsd + paymentUsd > caps.globalDailyCapUsd) {
      return {
        ok: false,
        reason: `global daily cap exceeded ($${(spendToday.totalUsd + paymentUsd).toFixed(4)} > $${caps.globalDailyCapUsd.toFixed(2)})`,
      };
    }
  }
  return { ok: true };
}
