/**
 * x402 payment receipts.
 *
 * local activity log of every payment the wallet has signed (or attempted to sign). bounded to
 * the 200 most recent entries so storage stays small. keyed by an opaque id at create time;
 * later updates (settlement digest, error reason, user feedback) replace the entry in-place.
 *
 * receipts double as the spend-tracking source for `x402-caps.wouldExceedCaps`: the signer
 * sums today's settled receipts per host and globally before opening the approval popup.
 *
 * **private receipts** (toggle: `chromatika_x402_private_receipts_v1`): when enabled, the
 * sensitive triple `{ resourceUrl, sellerAddress, signatureHex }` is encrypted via the
 * EncryptXyzBackend (self-recipient envelope) before the receipt is appended. plain fields
 * (host, amount, status, tx hash) stay visible so daily caps still enforce. decryption is
 * one-shot via `decryptX402Receipt`, chromatika never persists the plain values back to
 * storage after decryption.
 */

import type { EncryptedRef } from '@/background/encryption/types';
import { todayLocalDayKey, type DailySpendSnapshot } from './x402-caps';
import { STORAGE_KEYS } from '@/background/storage';

const KEY = STORAGE_KEYS.X402_RECEIPTS_V1;
const PRIVATE_FLAG_KEY = STORAGE_KEYS.X402_PRIVATE_RECEIPTS_V1;
const RETENTION_KEY = STORAGE_KEYS.X402_RECEIPTS_RETENTION_V1;
const VERSION = 1 as const;

const MAX_RETAINED = 200;

/**
 * default retention window in days. receipts older than this are pruned on every append + on
 * every read. `null` ("forever") keeps the legacy behavior: receipts age out only via the
 * 200-row FIFO cap. default `30` days balances audit-trail usefulness vs storage hygiene.
 */
const DEFAULT_RETENTION_DAYS = 30;
export type X402RetentionDays = 1 | 7 | 30 | 90 | 'forever';
const VALID_RETENTION: readonly X402RetentionDays[] = [1, 7, 30, 90, 'forever'];

export type X402ReceiptStatus = 'pending' | 'settled' | 'failed' | 'rejected';
export type X402ResponseQuality = 'good' | 'bad' | null;

export type X402Receipt = {
  id: string;
  enqueuedAtMs: number;
  settledAtMs: number | null;
  /** lowercased host of the resource URL, for cap bucketing + UI display. */
  sellerHost: string;
  /** recipient wallet (from PaymentRequirements.payTo). empty when receipt is private-encrypted. */
  sellerAddress: string;
  /** original resource URL the agent / user paid for. empty when receipt is private-encrypted. */
  resourceUrl: string;
  /** CAIP-2 network id. v1 is always solana mainnet/devnet. */
  network: string;
  /** SPL mint address (USDC mainnet/devnet). */
  asset: string;
  /** amount in the asset's smallest unit. */
  amountAtomic: string;
  /** best-effort USD amount captured at receipt time (price waterfall hit at sign time). */
  amountUsdEstimate: number | null;
  /** hex of the off-chain Ed25519 signature submitted in PAYMENT-SIGNATURE. empty when private-encrypted. */
  signatureHex: string | null;
  /** on-chain settlement digest from PAYMENT-RESPONSE.transaction. */
  settlementTxHash: string | null;
  status: X402ReceiptStatus;
  errorReason: string | null;
  /** user feedback after consuming the response, drives future allowlists. */
  responseQuality: X402ResponseQuality;
  /**
   * set when the receipt was created with `chromatika_x402_private_receipts_v1` enabled. holds
   * an `EncryptionBackend`-encrypted blob of `{ resourceUrl, sellerAddress, signatureHex }`.
   * decrypt via `decryptX402Receipt(id)` to reveal, chromatika never persists the plain values
   * back to storage.
   */
  privateBlob?: EncryptedRef | null;
};

/** plain payload encrypted into `privateBlob` when private receipts are enabled. */
export interface X402ReceiptPrivatePayload {
  resourceUrl: string;
  sellerAddress: string;
  signatureHex: string | null;
}

type X402ReceiptsV1 = {
  v: typeof VERSION;
  receipts: X402Receipt[];
};

const DEFAULTS: X402ReceiptsV1 = { v: VERSION, receipts: [] };

async function getRaw(): Promise<X402ReceiptsV1> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get([KEY], (r) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      const stored = r[KEY] as X402ReceiptsV1 | undefined;
      if (!stored || stored.v !== VERSION) {
        resolve({ ...DEFAULTS, receipts: [] });
        return;
      }
      resolve(stored);
    });
  });
}

async function setRaw(next: X402ReceiptsV1): Promise<void> {
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

// ---------------------------------------------------------------------------
// Retention (chromatika_x402_receipts_retention_v1)
// ---------------------------------------------------------------------------

export async function getX402RetentionDays(): Promise<X402RetentionDays> {
  return new Promise((resolve) => {
    chrome.storage.local.get([RETENTION_KEY], (r) => {
      const v = r[RETENTION_KEY];
      if (v === 'forever') return resolve('forever');
      if (typeof v === 'number' && (VALID_RETENTION as readonly (number | string)[]).includes(v)) {
        return resolve(v as X402RetentionDays);
      }
      resolve(DEFAULT_RETENTION_DAYS);
    });
  });
}

export async function setX402RetentionDays(value: X402RetentionDays): Promise<void> {
  if (!(VALID_RETENTION as readonly (number | string)[]).includes(value)) {
    throw new Error(`invalid retention value: ${String(value)}`);
  }
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [RETENTION_KEY]: value }, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

/** drop receipts older than the retention window. mutates + persists when changes apply. */
async function applyRetentionToRaw(raw: X402ReceiptsV1, nowMs: number = Date.now()): Promise<X402ReceiptsV1> {
  const retention = await getX402RetentionDays();
  if (retention === 'forever') return raw;
  const cutoff = nowMs - retention * 86_400_000;
  const kept = raw.receipts.filter((r) => r.enqueuedAtMs >= cutoff);
  if (kept.length === raw.receipts.length) return raw;
  const next: X402ReceiptsV1 = { v: VERSION, receipts: kept };
  await setRaw(next);
  return next;
}

/** wipe every receipt unconditionally. used by the user-facing "clear all" button. */
export async function clearAllX402Receipts(): Promise<{ removed: number }> {
  const raw = await getRaw();
  const removed = raw.receipts.length;
  await setRaw({ v: VERSION, receipts: [] });
  return { removed };
}

export async function listReceipts(opts?: { limit?: number }): Promise<X402Receipt[]> {
  const initial = await getRaw();
  // apply retention on every read so stale entries can't leak via cap-summing or the UI.
  const raw = await applyRetentionToRaw(initial);
  const limit = opts?.limit ?? raw.receipts.length;
  return raw.receipts.slice(0, Math.max(0, limit));
}

export async function appendReceipt(receipt: X402Receipt): Promise<void> {
  const enabled = await isX402PrivateReceiptsEnabled();
  let toStore: X402Receipt = receipt;
  if (enabled && !receipt.privateBlob) {
    // encrypt the sensitive triple before persisting; blank the plain copies on the receipt itself.
    try {
      const { encryptXyzBackend } = await import('@/background/encryption');
      const payload: X402ReceiptPrivatePayload = {
        resourceUrl: receipt.resourceUrl,
        sellerAddress: receipt.sellerAddress,
        signatureHex: receipt.signatureHex,
      };
      const plain = new TextEncoder().encode(JSON.stringify(payload));
      const ref = await encryptXyzBackend.encryptForRecipient(plain, { kind: 'self' });
      toStore = {
        ...receipt,
        resourceUrl: '',
        sellerAddress: '',
        signatureHex: null,
        privateBlob: ref,
      };
    } catch (e) {
      // encryption failed (e.g. encrypt.xyz devnet outage, vault locked, wrong base chain).
      // fall back to storing plaintext + log a warning. UX expectation: the toggle quietly
      // degrades rather than blocking the payment flow. the next-stable encryption attempt
      // will re-cover. (alternative: refuse to append, blocking the actual payment, bad UX.)
      console.warn('[x402-receipts] private encryption failed, storing plain receipt:', e);
    }
  }
  const initial = await getRaw();
  const raw = await applyRetentionToRaw(initial);
  const next: X402ReceiptsV1 = {
    v: VERSION,
    receipts: [toStore, ...raw.receipts].slice(0, MAX_RETAINED),
  };
  await setRaw(next);
}

// ---------------------------------------------------------------------------
// Private receipts toggle (chromatika_x402_private_receipts_v1)
// ---------------------------------------------------------------------------

export async function isX402PrivateReceiptsEnabled(): Promise<boolean> {
  return new Promise((resolve) => {
    chrome.storage.local.get([PRIVATE_FLAG_KEY], (r) => {
      resolve(r[PRIVATE_FLAG_KEY] === true);
    });
  });
}

export async function setX402PrivateReceiptsEnabled(enabled: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [PRIVATE_FLAG_KEY]: enabled }, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

/**
 * decrypt a private-receipt blob. one-shot: the plain values are returned to the caller and
 * NEVER persisted back. caller (the tRPC procedure) renders them in-memory; if the user closes
 * the modal the values are gone again until the next decrypt.
 */
export async function decryptX402ReceiptPrivate(id: string): Promise<X402ReceiptPrivatePayload | null> {
  const raw = await getRaw();
  const r = raw.receipts.find((x) => x.id === id);
  if (!r || !r.privateBlob) return null;
  const { decryptRefViaRegistry } = await import('@/background/encryption');
  const plain = await decryptRefViaRegistry(r.privateBlob);
  const json = new TextDecoder().decode(plain);
  return JSON.parse(json) as X402ReceiptPrivatePayload;
}

export async function updateReceipt(id: string, patch: Partial<X402Receipt>): Promise<X402Receipt | null> {
  const raw = await getRaw();
  const idx = raw.receipts.findIndex((r) => r.id === id);
  if (idx < 0) return null;
  const merged: X402Receipt = { ...raw.receipts[idx], ...patch, id };
  const next: X402ReceiptsV1 = {
    v: VERSION,
    receipts: [...raw.receipts.slice(0, idx), merged, ...raw.receipts.slice(idx + 1)],
  };
  await setRaw(next);
  return merged;
}

export async function setReceiptQuality(id: string, quality: X402ResponseQuality): Promise<X402Receipt | null> {
  return updateReceipt(id, { responseQuality: quality });
}

/**
 * compute today's spend snapshot from receipts. only successful settlements count toward caps;
 * pending / failed / rejected receipts don't (the user shouldn't be blocked by their own
 * earlier failures).
 *
 * USD amount uses the captured `amountUsdEstimate` when available; entries without an estimate
 * are skipped (signer should always populate it: missing estimate = price waterfall failed at
 * sign time, treat as zero).
 */
export async function computeTodaysSpend(now: Date = new Date()): Promise<DailySpendSnapshot> {
  const raw = await getRaw();
  const today = todayLocalDayKey(now);
  const out: DailySpendSnapshot = { totalUsd: 0, perHostUsd: {} };
  for (const r of raw.receipts) {
    if (r.status !== 'settled' && r.status !== 'pending') continue;
    if (r.amountUsdEstimate == null) continue;
    const dayKey = todayLocalDayKey(new Date(r.enqueuedAtMs));
    if (dayKey !== today) continue;
    out.totalUsd += r.amountUsdEstimate;
    const host = r.sellerHost.trim().toLowerCase();
    out.perHostUsd[host] = (out.perHostUsd[host] ?? 0) + r.amountUsdEstimate;
  }
  return out;
}

export function newReceiptId(): string {
  // 6 random bytes is plenty: receipts are local-only and ids are short-lived (capped retention).
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return `x402-${Date.now()}-${hex}`;
}
