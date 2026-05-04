import { z } from 'zod';
import { publicProcedure } from '../trpc';
import { trpcAddressParam } from '../trpc-input-schemas';
import { getPrice, getPrices } from '@/background/services/price';
import {
  getAptosNfts,
  getBtcOrdinals,
  getEvmNfts,
  getSolanaNfts,
  getSuiNfts,
} from '@/background/services/nft';
import { getKioskData, getOwnedKiosks } from '@/background/services/sui-kiosk';
import { getMediaSafetyMode } from '@/background/services/media-safety';

export const assetsProcedures = {
  getPrice: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(({ input }) => getPrice(input.symbol)),

  getPrices: publicProcedure
    .input(z.object({ symbols: z.array(z.string()) }))
    .query(({ input }) => getPrices(input.symbols)),

  getNftApiHints: publicProcedure.query(() => ({
    alchemyConfigured: Boolean(import.meta.env.VITE_ALCHEMY_KEY),
    heliusConfigured: Boolean(import.meta.env.VITE_HELIUS_KEY),
  })),

  getSuiNfts: publicProcedure
    .input(z.object({ address: trpcAddressParam }))
    .query(async ({ input }) => {
      const mode = await getMediaSafetyMode();
      return getSuiNfts(input.address, mode);
    }),

  getBtcOrdinals: publicProcedure
    .input(z.object({ address: trpcAddressParam }))
    .query(async ({ input }) => {
      const mode = await getMediaSafetyMode();
      return getBtcOrdinals(input.address, mode);
    }),

  getEvmNfts: publicProcedure
    .input(z.object({ address: trpcAddressParam, chainId: z.number() }))
    .query(async ({ input }) => {
      const mode = await getMediaSafetyMode();
      return getEvmNfts(input.address, input.chainId, mode);
    }),

  getSolanaNfts: publicProcedure
    .input(z.object({ address: trpcAddressParam }))
    .query(async ({ input }) => {
      const mode = await getMediaSafetyMode();
      return getSolanaNfts(input.address, mode);
    }),

  getAptosNfts: publicProcedure
    .input(z.object({ address: trpcAddressParam }))
    .query(async ({ input }) => {
      const mode = await getMediaSafetyMode();
      return getAptosNfts(input.address, mode);
    }),

  getOwnedKiosks: publicProcedure
    .input(z.object({ address: trpcAddressParam }))
    .query(({ input }) => getOwnedKiosks(input.address)),

  getKioskData: publicProcedure
    .input(z.object({ kioskId: z.string() }))
    .query(({ input }) => getKioskData(input.kioskId)),
};
