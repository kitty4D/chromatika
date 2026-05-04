import { z } from 'zod';
import { publicProcedure } from '../trpc';
import {
  addHardwareAccount,
  getHardwareAccounts,
  removeHardwareAccount,
} from '@/background/hardware/accounts';
import {
  getPendingHardwareSignMeta,
  rejectPendingHardwareSign,
  resolvePendingHardwareSign,
} from '@/background/hardware/pending-queue';

export const hwProcedures = {
  getHardwareAccounts: publicProcedure.query(() => getHardwareAccounts()),

  addHardwareAccount: publicProcedure
    .input(
      z.object({
        vendor: z.enum(['ledger', 'trezor', 'mwa', 'walletconnect']),
        chain: z.enum(['evm', 'bitcoin', 'solana', 'sui']),
        derivationPath: z.string(),
        address: z.string().min(1),
        ed25519PublicKeyB64: z.string().optional(),
      }),
    )
    .mutation(({ input }) => addHardwareAccount(input)),

  removeHardwareAccount: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ input }) => removeHardwareAccount(input.id)),

  /** called from the hardware-sign popup to retrieve what needs signing */
  getHardwareSignRequest: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(({ input }) => {
      const meta = getPendingHardwareSignMeta(input.id);
      if (!meta) throw new Error(`No pending hardware sign: ${input.id}`);
      return meta;
    }),

  /** called by popup after user confirms on device */
  resolveHardwareSign: publicProcedure
    .input(z.object({ id: z.string(), signature: z.string() }))
    .mutation(({ input }) => {
      resolvePendingHardwareSign(input.id, input.signature);
      return { ok: true as const };
    }),

  /** called by popup when user rejects or device errors */
  rejectHardwareSign: publicProcedure
    .input(z.object({ id: z.string(), reason: z.string() }))
    .mutation(({ input }) => {
      rejectPendingHardwareSign(input.id, input.reason);
      return { ok: true as const };
    }),
};
