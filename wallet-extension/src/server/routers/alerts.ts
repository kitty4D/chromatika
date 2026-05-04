/**
 * tRPC procedures for the safety broadcast alerts surface.
 *
 *   - listAlerts: every active (non-expired, non-dismissed) alert. banner + history page.
 *   - listKnownAlerts: every known alert including expired/dismissed. settings page history.
 *   - dismissAlert: mark an alert id as dismissed (banner hides, history page tags it).
 *   - getAlertSettings / setAlertSettings: { muted, customFeedUrl, optedOut }.
 *   - triggerAlertPoll: manual refresh from the settings page.
 *   - injectDevAlert: dev-only, sign + inject a test alert with the bundled placeholder
 *     publisher key. used by the demo button so we can show the flow without real publishing
 *     infrastructure.
 *
 * no auth needed, alerts are public, and there's no user-secret-touching path here.
 */

import { z } from 'zod';
import { publicProcedure } from '../trpc';
import {
  getAlertsState,
  activeAlertsFromState,
  setSettings,
  dismissAlert,
  injectVerifiedAlertForDev,
  resolveFeedUrl,
} from '@/background/alerts/alerts-store';
import { runAlertsPoll } from '@/background/alerts/alerts-poller';
import { runNewAlertActions } from '@/background/alerts/alerts-actions';
import {
  type SignedAlertV1,
  type UnsignedAlertV1,
  canonicalAlertBytes,
} from '@/background/alerts/alerts-types';
import { verifySignedAlert } from '@/background/alerts/alerts-verify';
import { BUNDLED_PUBLISHERS } from '@/background/alerts/alerts-publishers';

export const alertsProcedures = {
  listAlerts: publicProcedure.query(async () => {
    const state = await getAlertsState();
    return {
      active: activeAlertsFromState(state),
      muted: state.settings.muted,
      optedOut: state.settings.optedOut,
      lastPolledAtMs: state.lastPolledAtMs,
      lastPollError: state.lastPollError,
      feedUrl: resolveFeedUrl(state),
    };
  }),

  listKnownAlerts: publicProcedure.query(async () => {
    const state = await getAlertsState();
    const dismissedSet = new Set(state.dismissedIds);
    return {
      alerts: state.knownAlerts
        .map((a) => ({ ...a, dismissed: dismissedSet.has(a.id) }))
        .sort((a, b) => b.timestampMs - a.timestampMs),
      publishers: BUNDLED_PUBLISHERS.map((p) => ({ pubkeyB64: p.pubkeyB64, label: p.label })),
    };
  }),

  dismissAlert: publicProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ input }) => {
      await dismissAlert(input.id);
      return { ok: true as const };
    }),

  getAlertSettings: publicProcedure.query(async () => {
    const state = await getAlertsState();
    return state.settings;
  }),

  setAlertSettings: publicProcedure
    .input(
      z.object({
        muted: z.boolean().optional(),
        customFeedUrl: z.string().max(500).optional(),
        optedOut: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      return setSettings(input);
    }),

  triggerAlertPoll: publicProcedure.mutation(async () => {
    return runAlertsPoll();
  }),

  /**
   * dev-only: inject a fully-formed signed alert. caller (the wallet UI demo button or a test)
   * provides the signed envelope; we still run it through `verifySignedAlert` so a malformed
   * dev alert can't bypass the real verification path. useful for local demos when we don't
   * want to depend on an external feed being reachable.
   */
  injectSignedAlertForDev: publicProcedure
    .input(z.object({ signedAlertJson: z.string().min(2).max(20_000) }))
    .mutation(async ({ input }) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(input.signedAlertJson);
      } catch (e) {
        throw new Error(`signed alert is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
      }
      const verifyRes = await verifySignedAlert(parsed);
      if (!verifyRes.ok) {
        throw new Error(`alert verification failed: [${verifyRes.reason}] ${verifyRes.detail}`);
      }
      const newAlerts = await injectVerifiedAlertForDev(verifyRes.alert);
      const state = await getAlertsState();
      for (const a of newAlerts) {
        await runNewAlertActions(a, state.settings.muted);
      }
      return { newAlerts: newAlerts.length, alertId: verifyRes.alert.id };
    }),

  /**
   * helper for the publishing CLI (and the dev "preview your alert" UI): take an unsigned
   * envelope + a base64 ed25519 privkey, return the canonical bytes that should be signed.
   * the actual signing happens on the publisher side (offline / hardware), not here. we never
   * accept a privkey over tRPC.
   */
  computeAlertSigningBytesB64: publicProcedure
    .input(
      z.object({
        unsignedAlertJson: z.string().min(2).max(20_000),
      }),
    )
    .query(({ input }) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(input.unsignedAlertJson);
      } catch (e) {
        throw new Error(`unsigned alert is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
      }
      // we don't fully validate shape here, that happens at sig-verify time. we just produce
      // the canonical bytes for whatever the caller passed in.
      const bytes = canonicalAlertBytes(parsed as UnsignedAlertV1);
      return { canonicalBytesB64: btoa(String.fromCharCode(...bytes)) };
    }),
};

// keep the public type so the publishing CLI can import the canonical-bytes helper signature.
export type { SignedAlertV1, UnsignedAlertV1 };
