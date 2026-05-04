/**
 * fetch + verify the safety-alerts feed. pure-async, no side effects beyond network.
 * the poller (`alerts-poller.ts`) wraps this with chrome.alarms + state persistence + actions.
 *
 * resilience:
 *   - 25s timeout via AbortSignal (matches Esplora / Blockscout fetches in `activity.ts`)
 *   - HTTP non-2xx → reject with status; the caller logs it as the lastPollError
 *   - JSON parse failure → reject
 *   - each alert in the array is independently verified; bad alerts are dropped with a warning
 *     but the rest of the batch is kept (a single corrupted alert shouldn't poison the whole feed)
 */

import { z } from 'zod';
import { verifySignedAlert } from '@/background/alerts/alerts-verify';
import type { SignedAlertV1 } from '@/background/alerts/alerts-types';

const FETCH_TIMEOUT_MS = 25_000;

const feedShape = z.object({
  v: z.literal(1),
  generatedAtMs: z.number().int().nonnegative(),
  alerts: z.array(z.unknown()).max(500),
});

export interface FetchAlertsResult {
  /** all alerts that verified cleanly. */
  verified: SignedAlertV1[];
  /** per-alert verify errors; useful for surfacing in the settings page when nothing comes through. */
  drops: Array<{ index: number; reason: string; detail: string }>;
  /** server-side feed timestamp. UI shows "feed last updated N ago". */
  generatedAtMs: number;
}

export async function fetchAndVerifyFeed(feedUrl: string): Promise<FetchAlertsResult> {
  let res: Response;
  try {
    res = await fetch(feedUrl, {
      method: 'GET',
      cache: 'no-cache',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: 'application/json' },
    });
  } catch (e) {
    throw new Error(`alerts feed fetch failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) {
    throw new Error(`alerts feed returned ${res.status} ${res.statusText}`);
  }
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch (e) {
    throw new Error(`alerts feed JSON parse failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  const shapeRes = feedShape.safeParse(parsed);
  if (!shapeRes.success) {
    throw new Error(`alerts feed shape mismatch: ${shapeRes.error.message}`);
  }

  const verified: SignedAlertV1[] = [];
  const drops: Array<{ index: number; reason: string; detail: string }> = [];
  for (let i = 0; i < shapeRes.data.alerts.length; i++) {
    const v = await verifySignedAlert(shapeRes.data.alerts[i]);
    if (v.ok) {
      verified.push(v.alert);
    } else {
      drops.push({ index: i, reason: v.reason, detail: v.detail });
      console.warn(`[chromatika alerts] dropped alert ${i}: ${v.reason} - ${v.detail}`);
    }
  }
  return { verified, drops, generatedAtMs: shapeRes.data.generatedAtMs };
}
