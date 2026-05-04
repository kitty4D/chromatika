/**
 * polling orchestrator. wires the fetch + verify + store + actions loop to chrome.alarms.
 *
 * schedule:
 *   - chrome.runtime.onInstalled / onStartup → immediate poll (cold start) so users see active
 *     alerts within seconds of install / browser launch
 *   - chrome.alarms `chromatika-alerts-poll` every 5 min after that
 *   - tRPC `triggerAlertPoll` → manual refresh from settings UI
 *
 * cold-SW safety: poll handlers always tolerate a missing alarm (recreate it) and stale
 * background scope (re-import lazily). works the same way the existing phishing + presign
 * alarms in `index.ts` do.
 */

import { fetchAndVerifyFeed } from '@/background/alerts/alerts-fetch';
import {
  getAlertsState,
  mergeNewAlerts,
  resolveFeedUrl,
  setLastPollOutcome,
} from '@/background/alerts/alerts-store';
import { runNewAlertActions } from '@/background/alerts/alerts-actions';

export const ALERTS_POLL_ALARM = 'chromatika-alerts-poll';
export const ALERTS_POLL_PERIOD_MIN = 5;

/**
 * single poll cycle. fetches the feed, verifies alerts, merges new ones, fires actions for the
 * new ones. records lastPolledAtMs + lastPollError. never throws - the caller is the alarm
 * dispatcher; we don't want a hostile feed to bubble up there.
 *
 * returns the new-alerts batch so callers (e.g. `triggerAlertPoll`) can echo it back to the UI
 * for an immediate banner refresh.
 */
export async function runAlertsPoll(): Promise<{
  newAlerts: number;
  drops: number;
  error: string | null;
}> {
  const state = await getAlertsState();
  if (state.settings.optedOut) {
    await setLastPollOutcome({ atMs: Date.now(), error: 'opted out' });
    return { newAlerts: 0, drops: 0, error: 'opted out' };
  }
  const feedUrl = resolveFeedUrl(state);
  try {
    const { verified, drops } = await fetchAndVerifyFeed(feedUrl);
    const newAlerts = await mergeNewAlerts(verified);
    if (newAlerts.length > 0) {
      // run actions sequentially so notification ordering is stable; each is internally async.
      for (const a of newAlerts) {
        await runNewAlertActions(a, state.settings.muted);
      }
    }
    await setLastPollOutcome({ atMs: Date.now(), error: null });
    return { newAlerts: newAlerts.length, drops: drops.length, error: null };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.warn('[chromatika alerts] poll failed:', error);
    await setLastPollOutcome({ atMs: Date.now(), error });
    return { newAlerts: 0, drops: 0, error };
  }
}

/** idempotent setup of the recurring poll alarm. safe to call from onInstalled / onStartup. */
export function ensureAlertsPollAlarm(): void {
  chrome.alarms.get(ALERTS_POLL_ALARM, (existing) => {
    if (!existing) {
      chrome.alarms.create(ALERTS_POLL_ALARM, { periodInMinutes: ALERTS_POLL_PERIOD_MIN });
    }
  });
}
