/**
 * tRPC procedures for the notifications surface:
 *   - getNotifyPrefs / setNotifyPrefs: read + write user notification prefs
 *   - getPriceAlerts / addPriceAlert / removePriceAlert / rearmPriceAlert: price alert CRUD
 *
 * flat-spread pattern, no nested sub-router.
 */

import { z } from 'zod';
import { publicProcedure } from '../trpc';
import {
  getNotifyPrefs,
  setNotifyPrefs,
  getPriceAlerts,
  addPriceAlert,
  removePriceAlert,
  rearmPriceAlert,
} from '@/background/services/notifications/notify-prefs';

export const notificationProcedures = {
  getNotifyPrefs: publicProcedure.query(async () => {
    return getNotifyPrefs();
  }),

  setNotifyPrefs: publicProcedure
    .input(
      z.object({
        enabled: z.boolean().optional(),
        channels: z
          .object({
            incomingTx: z.boolean().optional(),
            sendConfirmation: z.boolean().optional(),
            priceAlerts: z.boolean().optional(),
            ikaEvents: z.boolean().optional(),
          })
          .optional(),
        muted: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const current = await getNotifyPrefs();
      const next = {
        ...current,
        ...input,
        channels: { ...current.channels, ...input.channels },
      };
      await setNotifyPrefs(next);
      return next;
    }),

  getPriceAlerts: publicProcedure.query(async () => {
    return getPriceAlerts();
  }),

  addPriceAlert: publicProcedure
    .input(
      z.object({
        symbol: z.string().min(1).max(10),
        direction: z.enum(['above', 'below']),
        thresholdUsd: z.number().positive(),
      }),
    )
    .mutation(async ({ input }) => {
      return addPriceAlert(input.symbol, input.direction, input.thresholdUsd);
    }),

  removePriceAlert: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      await removePriceAlert(input.id);
      return { ok: true as const };
    }),

  rearmPriceAlert: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      await rearmPriceAlert(input.id);
      return { ok: true as const };
    }),
};
