/**
 * recently-sent-to ledger for the Send tab dropdown. populated as a side effect of `sendUnified`
 * (the new tab-rooted Send mutation); legacy dapp-driven sends do not write here on purpose,
 * since dapp recipients are typically contracts the user doesn't want re-surfacing.
 *
 * stored in chrome.storage.local (public info, same trust boundary as the address book). capped
 * at 50 entries per chain, FIFO. dedupes by (chain, address).
 */

import { STORAGE_KEYS } from '@/background/storage';
import type { AddressBookChain } from './address-book';

const STORAGE_KEY = STORAGE_KEYS.RECENT_RECIPIENTS_V1;
const MAX_PER_CHAIN = 50;

export type RecentRecipient = {
  address: string;
  chain: AddressBookChain;
  lastSentAtMs: number;
};

type Store = { entries: RecentRecipient[] };

async function loadStore(): Promise<Store> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get([STORAGE_KEY], (r) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      const raw = r[STORAGE_KEY] as Store | undefined;
      resolve(raw && Array.isArray(raw.entries) ? raw : { entries: [] });
    });
  });
}

async function saveStore(store: Store): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [STORAGE_KEY]: store }, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

/** dedupe key. EVM is case-insensitive; everything else preserves case. */
function eqAddress(a: string, b: string, chain: AddressBookChain): boolean {
  if (chain === 'evm') return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

/**
 * record a recipient. always best-effort; failures bubble through but the caller is expected
 * to fire-and-forget (the user has already broadcast their tx, persistence isn't critical).
 */
export async function recordRecentRecipient(
  address: string,
  chain: AddressBookChain,
): Promise<void> {
  const trimmed = address.trim();
  if (!trimmed) return;
  const now = Date.now();
  const store = await loadStore();
  // remove any existing entry for this (chain, address) so the new one floats to the top.
  store.entries = store.entries.filter((e) => !(e.chain === chain && eqAddress(e.address, trimmed, chain)));
  store.entries.unshift({ address: trimmed, chain, lastSentAtMs: now });
  // enforce per-chain cap.
  const trimmedEntries: RecentRecipient[] = [];
  const seenPerChain: Record<string, number> = {};
  for (const e of store.entries) {
    const c = (seenPerChain[e.chain] ?? 0) + 1;
    if (c > MAX_PER_CHAIN) continue;
    seenPerChain[e.chain] = c;
    trimmedEntries.push(e);
  }
  store.entries = trimmedEntries;
  await saveStore(store);
}

/**
 * list recent recipients, sorted most-recent-first. optional `chain` filter; `limit` clamps the
 * returned count (default 10).
 */
export async function listRecentRecipients(
  opts: { chain?: AddressBookChain; limit?: number } = {},
): Promise<RecentRecipient[]> {
  const store = await loadStore();
  const limit = opts.limit ?? 10;
  let rows = [...store.entries].sort((a, b) => b.lastSentAtMs - a.lastSentAtMs);
  if (opts.chain) rows = rows.filter((r) => r.chain === opts.chain);
  return rows.slice(0, limit);
}
