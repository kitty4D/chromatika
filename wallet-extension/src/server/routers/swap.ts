import { z } from 'zod';
import { publicProcedure } from '../trpc';
import {
  confirmAndExecuteSwap,
  getPhaseBSpikeStatus,
  getPhaseBStatus,
  requestSwapQuote,
} from '@/background/funding/phase-b-spike';

export const swapProcedures = {
  phaseBFundingSpike: publicProcedure.query(() => getPhaseBSpikeStatus()),

  /** phase B: full swap readiness with balance info */
  swapStatus: publicProcedure.query(() => getPhaseBStatus()),

  /** phase B: get a quote for SUI -> IKA swap */
  swapQuote: publicProcedure
    .input(
      z.object({
        amountInMist: z.string().optional(),
        slippageBps: z.number().min(10).max(500).default(100),
      }),
    )
    .query(({ input }) => requestSwapQuote(input.amountInMist, input.slippageBps)),

  /** phase B: execute a previously-fetched swap quote (full quote required so SW restarts do not drop cache) */
  executeSwap: publicProcedure
    .input(
      z
        .object({
          quoteId: z.string(),
          quote: z.object({
            id: z.string(),
            fromCoinType: z.string(),
            toCoinType: z.string(),
            amountInBaseUnits: z.string(),
            expectedOutBaseUnits: z.string(),
            minOutBaseUnits: z.string(),
            slippageBps: z.number(),
            priceImpactPct: z.string(),
            txBytesB64: z.string(),
            fetchedAtEpochMs: z.number(),
            routeSummary: z.string(),
          }),
        })
        .refine((d) => d.quoteId === d.quote.id, {
          message: 'quote id mismatch',
          path: ['quoteId'],
        }),
    )
    .mutation(({ input }) => confirmAndExecuteSwap(input.quoteId, input.quote)),
};
