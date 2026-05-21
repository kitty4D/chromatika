/**
 * storage helpers for the notifications surface:
 *   - user prefs (NotifyPrefs)
 *   - activity polling cursors (NotifyCursors / CursorEntry)
 *   - price alert rules (PriceAlertStore / PriceAlert)
 *
 * all writes go to chrome.storage.local so they survive SW restarts.
 * readers merge with typed defaults so partial / missing rows are safe.
 */

import { STORAGE_KEYS } from '@/background/storage/keys';
import {
  type NotifyPrefs,
  type NotifyCursors,
  type CursorEntry,
  type PriceAlertStore,
  type PriceAlert,
  type PriceAlertDirection,
  DEFAULT_NOTIFY_PREFS,
  MAX_PRICE_ALERTS,
} from './types';

// --- internal helpers ---

function storageGet<T>(key: string, defaults: T): Promise<T> {
  return new Promise((resolve) => {
    chrome.storage.local.get([key], (r) => {
      resolve({ ...defaults, ...(r[key] as Partial<T> ?? {}) });
    });
  });
}

function storageSet<T>(key: string, value: T): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [key]: value }, () => resolve());
  });
}

// --- notify prefs ---

export function getNotifyPrefs(): Promise<NotifyPrefs> {
  return storageGet<NotifyPrefs>(STORAGE_KEYS.NOTIFY_PREFS_V1, DEFAULT_NOTIFY_PREFS);
}

export function setNotifyPrefs(prefs: NotifyPrefs): Promise<void> {
  return storageSet(STORAGE_KEYS.NOTIFY_PREFS_V1, prefs);
}

// --- activity cursors ---

export function getNotifyCursors(): Promise<NotifyCursors> {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEYS.NOTIFY_CURSORS_V1], (r) => {
      resolve((r[STORAGE_KEYS.NOTIFY_CURSORS_V1] as NotifyCursors) ?? {});
    });
  });
}

export function setNotifyCursors(cursors: NotifyCursors): Promise<void> {
  return storageSet(STORAGE_KEYS.NOTIFY_CURSORS_V1, cursors);
}

export async function getCursorFor(key: string): Promise<CursorEntry | null> {
  const cursors = await getNotifyCursors();
  return cursors[key] ?? null;
}

export async function setCursorFor(key: string, entry: CursorEntry): Promise<void> {
  const cursors = await getNotifyCursors();
  cursors[key] = entry;
  return setNotifyCursors(cursors);
}

// --- price alerts ---

export function getPriceAlerts(): Promise<PriceAlertStore> {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEYS.PRICE_ALERTS_V1], (r) => {
      const stored = r[STORAGE_KEYS.PRICE_ALERTS_V1] as PriceAlertStore | undefined;
      resolve(stored ?? { alerts: [] });
    });
  });
}

async function savePriceAlerts(store: PriceAlertStore): Promise<void> {
  return storageSet(STORAGE_KEYS.PRICE_ALERTS_V1, store);
}

export async function addPriceAlert(
  symbol: string,
  direction: PriceAlertDirection,
  thresholdUsd: number,
): Promise<PriceAlert> {
  const store = await getPriceAlerts();
  if (store.alerts.length >= MAX_PRICE_ALERTS) {
    throw new Error(`max price alerts reached (${MAX_PRICE_ALERTS})`);
  }
  const alert: PriceAlert = {
    id: crypto.randomUUID(),
    symbol: symbol.toUpperCase(),
    direction,
    thresholdUsd,
    createdAtMs: Date.now(),
  };
  store.alerts.push(alert);
  await savePriceAlerts(store);
  return alert;
}

export async function removePriceAlert(id: string): Promise<void> {
  const store = await getPriceAlerts();
  store.alerts = store.alerts.filter((a) => a.id !== id);
  return savePriceAlerts(store);
}

export async function markPriceAlertFired(id: string): Promise<void> {
  const store = await getPriceAlerts();
  const alert = store.alerts.find((a) => a.id === id);
  if (alert) {
    alert.firedAtMs = Date.now();
    await savePriceAlerts(store);
  }
}

export async function rearmPriceAlert(id: string): Promise<void> {
  const store = await getPriceAlerts();
  const alert = store.alerts.find((a) => a.id === id);
  if (alert) {
    delete alert.firedAtMs;
    await savePriceAlerts(store);
  }
}
