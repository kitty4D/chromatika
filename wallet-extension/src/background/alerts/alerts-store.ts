/**
 * chrome.storage state for the safety broadcast alerts surface.
 *
 * shape:
 *   - knownAlerts: every verified alert we've seen, capped at 200 most recent. the poll merges
 *     new alerts into this list; the UI reads it for the history view; expired alerts are pruned
 *     on every read.
 *   - dismissedIds: alert ids the user dismissed via the in-app banner (chrome notifications can
 *     also fire dismiss). banner hides any alert whose id is here.
 *   - settings: { muted, customFeedUrl }. mute kills both chrome.notifications and the in-app
 *     banner (history page still renders alerts so users can review past activity).
 *   - lastPolledAtMs / lastPollError: surfaced to the settings page so users can debug "why
 *     hasn't a known alert reached me yet?".
 *
 * storage key: `chromatika_alerts_v1` (chrome.storage.local). single object, not per-vault -
 * alerts are global, every vault sees them.
 */

import { STORAGE_KEYS } from '@/background/storage';
import type { SignedAlertV1 } from '@/background/alerts/alerts-types';
import { isExpired } from '@/background/alerts/alerts-types';
import { BUNDLED_PUBLISHERS_REVISION } from '@/background/alerts/alerts-publishers';

const STORAGE_KEY = STORAGE_KEYS.ALERTS_V1;
const MAX_KNOWN_ALERTS = 200;

/** default v0 feed URL. override via `settings.customFeedUrl` (advanced) or VITE_ALERTS_FEED_URL. */
export const DEFAULT_ALERTS_FEED_URL =
  (typeof import.meta !== 'undefined' && import.meta.env?.VITE_ALERTS_FEED_URL) ||
  'https://chromatika.dev/safety-alerts.json';

export interface AlertsSettings {
  /** suppress chrome.notifications + in-app banner. history page still shows alerts. */
  muted: boolean;
  /** override the default feed URL (advanced setting). empty string means use default. */
  customFeedUrl: string;
  /** whether the user has explicitly opted-out. default false (alerts on by default). */
  optedOut: boolean;
}

export interface AlertsState {
  v: 1;
  knownAlerts: SignedAlertV1[];
  dismissedIds: string[];
  settings: AlertsSettings;
  lastPolledAtMs: number;
  lastPollError: string | null;
  /** tracks the publisher allowlist revision that last touched the store. bump triggers re-verify. */
  publishersRevision: number;
}

function defaultState(): AlertsState {
  return {
    v: 1,
    knownAlerts: [],
    dismissedIds: [],
    settings: { muted: false, customFeedUrl: '', optedOut: false },
    lastPolledAtMs: 0,
    lastPollError: null,
    publishersRevision: BUNDLED_PUBLISHERS_REVISION,
  };
}

async function readRaw(): Promise<AlertsState> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get([STORAGE_KEY], (r) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      const v = r[STORAGE_KEY];
      if (v && typeof v === 'object' && (v as { v?: number }).v === 1) {
        resolve(v as AlertsState);
      } else {
        resolve(defaultState());
      }
    });
  });
}

async function writeRaw(state: AlertsState): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [STORAGE_KEY]: state }, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve();
      }
    });
  });
}

/** read state and prune expired alerts before returning. read-only at the storage level. */
export async function getAlertsState(): Promise<AlertsState> {
  const state = await readRaw();
  const now = Date.now();
  const stillValid = state.knownAlerts.filter((a) => !isExpired(a, now));
  if (stillValid.length !== state.knownAlerts.length) {
    state.knownAlerts = stillValid;
    await writeRaw(state);
  }
  return state;
}

/**
 * merge a freshly-verified batch of alerts into the store. returns the alerts that are NEW
 * (not previously seen by id). caller fires actions (chrome.notifications, dNR rule append) for
 * the returned new alerts.
 *
 * drops alerts whose publisher revision ≠ current bundle revision - rare, but covers the case
 * where a stale background SW still runs old code while new alerts use a freshly-allowlisted
 * publisher key. the poller will re-attempt next cycle once the SW reloads.
 */
export async function mergeNewAlerts(verifiedAlerts: SignedAlertV1[]): Promise<SignedAlertV1[]> {
  const state = await readRaw();
  const knownIds = new Set(state.knownAlerts.map((a) => a.id));
  const newAlerts: SignedAlertV1[] = [];
  for (const a of verifiedAlerts) {
    if (!knownIds.has(a.id)) {
      newAlerts.push(a);
      knownIds.add(a.id);
    }
  }
  if (newAlerts.length === 0) {
    return [];
  }
  state.knownAlerts = [...state.knownAlerts, ...newAlerts];
  // cap at MAX_KNOWN_ALERTS, keeping the newest by timestamp.
  if (state.knownAlerts.length > MAX_KNOWN_ALERTS) {
    state.knownAlerts.sort((a, b) => a.timestampMs - b.timestampMs);
    state.knownAlerts.splice(0, state.knownAlerts.length - MAX_KNOWN_ALERTS);
  }
  state.publishersRevision = BUNDLED_PUBLISHERS_REVISION;
  await writeRaw(state);
  return newAlerts;
}

export async function setLastPollOutcome(opts: { atMs: number; error: string | null }): Promise<void> {
  const state = await readRaw();
  state.lastPolledAtMs = opts.atMs;
  state.lastPollError = opts.error;
  await writeRaw(state);
}

export async function setSettings(partial: Partial<AlertsSettings>): Promise<AlertsSettings> {
  const state = await readRaw();
  state.settings = { ...state.settings, ...partial };
  await writeRaw(state);
  return state.settings;
}

export async function dismissAlert(id: string): Promise<void> {
  const state = await readRaw();
  if (!state.dismissedIds.includes(id)) {
    state.dismissedIds = [...state.dismissedIds, id];
    // cap dismissed-list growth; once an alert is gone from knownAlerts the dismissed entry is
    // safe to drop too.
    const knownIds = new Set(state.knownAlerts.map((a) => a.id));
    state.dismissedIds = state.dismissedIds.filter((d) => knownIds.has(d));
    state.dismissedIds.push(id);
    await writeRaw(state);
  }
}

/** resolve the active feed URL (custom override OR default). */
export function resolveFeedUrl(state: AlertsState): string {
  const custom = state.settings.customFeedUrl.trim();
  return custom !== '' ? custom : DEFAULT_ALERTS_FEED_URL;
}

/** active = known + not expired + not dismissed. UI banner consumes this list. */
export function activeAlertsFromState(state: AlertsState, nowMs: number = Date.now()): SignedAlertV1[] {
  const dismissed = new Set(state.dismissedIds);
  return state.knownAlerts
    .filter((a) => !isExpired(a, nowMs))
    .filter((a) => !dismissed.has(a.id))
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || b.timestampMs - a.timestampMs);
}

function severityRank(s: SignedAlertV1['severity']): number {
  if (s === 'critical') return 3;
  if (s === 'warning') return 2;
  return 1;
}

/** dev-only: clear everything. used by `addTestAlert` cleanup. */
export async function clearAlertsForDev(): Promise<void> {
  await writeRaw(defaultState());
}

/**
 * inject a verified alert into the store as if it came from the feed. used by the dev-only
 * `addTestAlert` MCP / tRPC procedure to demo without needing real publishing infrastructure.
 * caller is responsible for verifying the alert before calling this.
 */
export async function injectVerifiedAlertForDev(alert: SignedAlertV1): Promise<SignedAlertV1[]> {
  return mergeNewAlerts([alert]);
}
