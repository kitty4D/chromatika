/**
 * tRPC procedures for the analytics / error-tracking consent surface.
 *
 *   - getAnalyticsConsent: returns { errorTracking: boolean } from chrome.storage.local.
 *   - setAnalyticsConsent: persists consent + toggles Sentry on/off in the background SW.
 *
 * no auth needed, consent is user-visible settings, no secrets touched here.
 */

import { z } from 'zod';
import { publicProcedure } from '../trpc';
import { getAnalyticsConsent } from '@/background/analytics/consent';
import { toggleErrorTracking } from '@/background/analytics/sentry';

export const analyticsProcedures = {
  getAnalyticsConsent: publicProcedure.query(async () => {
    return getAnalyticsConsent();
  }),

  setAnalyticsConsent: publicProcedure
    .input(z.object({ errorTracking: z.boolean() }))
    .mutation(async ({ input }) => {
      await toggleErrorTracking(input.errorTracking);
      return { ok: true as const };
    }),
};
