/**
 * tRPC procedures for the per-vault ika fee model + fee-payer account management.
 *
 * read-only:
 *   - `getIkaFeeSettings(vaultId)`: current mode + tunables.
 *   - `ikaFeePayerStatus(vaultId)`: combined: mode, address, balance, threshold, refill amount.
 *
 * mutations:
 *   - `setIkaFeeSettings(vaultId, partial)`: partial update; mode flips do NOT auto-drain.
 *     the caller (settings UI) is expected to prompt the user about residual balance before
 *     flipping `in_extension -> seeker_direct`, then call drain themselves.
 *   - `topUpIkaFeePayer(vaultId, lamportsStr)`: explicit user-initiated top-up; opens the
 *     hardware sign popup so the Seeker signs the transfer. caller-controlled amount.
 *   - `drainIkaFeePayerToSeeker(vaultId, lamportsStr?)`: drain the in-extension keypair back
 *     to the Seeker. signed locally with the keypair (no phone prompt). default = full balance
 *     minus the rent-exempt buffer.
 *   - `drainAbandonedFeePayer(vaultId)`: drain a residual keypair from a vault whose mode is
 *     `seeker_direct` (so the keypair isn't loaded into the session, but still lives in the
 *     encrypted blob). reads the keypair from the vault record directly.
 *
 * lamports are wire-encoded as decimal strings to dodge JSON's bigint limitation.
 */

import { z } from 'zod';
import { publicProcedure } from '../trpc';
import { getSession } from '@/background/session';
import {
  defaultIkaFeeSettings,
  getIkaFeeSettings,
  updateIkaFeeSettings,
  type IkaFeeSettings,
} from '@/background/ika/fee-settings';
import {
  drainFeePayerToSeeker,
  ikaFeePayerBalanceLamports,
  ikaFeePayerBalanceLamportsForAddress,
  readFeePayerAddressForVault,
  readFeePayerSecretKeyB64ForVault,
  topUpFeePayerFromSeeker,
} from '@/background/ika/ensure-fee-payer-funded';

function settingsToWire(s: IkaFeeSettings): {
  mode: IkaFeeSettings['mode'];
  autoRefill: boolean;
  refillLamports: string;
  thresholdLamports: string;
} {
  return {
    mode: s.mode,
    autoRefill: s.autoRefill,
    refillLamports: s.refillLamports.toString(),
    thresholdLamports: s.thresholdLamports.toString(),
  };
}

function requireUnlockedSession(): NonNullable<ReturnType<typeof getSession>> {
  const s = getSession();
  if (!s) throw new Error('Wallet locked');
  return s;
}

export const ikaFeesProcedures = {
  /** per-vault settings (mode + tunables). defaults applied if no row exists yet. */
  getIkaFeeSettings: publicProcedure
    .input(z.object({ vaultId: z.string().min(1) }))
    .query(async ({ input }) => settingsToWire(await getIkaFeeSettings(input.vaultId))),

  /**
   * combined status used by the settings panel + the discreet "manage" link in vault details.
   * returns:
   *  - `mode`: current ika fee mode for this vault.
   *  - `feePayerAddress`: in-extension keypair address (from session if loaded, otherwise read
   *    from the encrypted vault, covers `seeker_direct` vaults that still have a residual
   *    keypair from a prior `in_extension` lifetime).
   *  - `feePayerBalanceLamports`: current SOL balance of that address; `null` if no keypair.
   *  - `seekerAddress`: the user's phone-paired Solana address (chain key).
   *  - `thresholdLamports` + `refillLamports` + `autoRefill`: the user's configured tunables.
   */
  ikaFeePayerStatus: publicProcedure
    .input(z.object({ vaultId: z.string().min(1) }))
    .query(async ({ input }) => {
      const s = requireUnlockedSession();
      const settings = await getIkaFeeSettings(input.vaultId);
      const seekerAddress =
        s.solanaWcAccount?.address ?? s.solanaMwaAccount?.address ?? null;

      // active session prefers in-memory keypair (only set when mode is in_extension); for
      // seeker_direct vaults that still have a residual keypair, we fall back to reading the
      // encrypted blob so the settings panel can surface the residual balance.
      let feePayerAddress: string | null = null;
      if (input.vaultId === s.activeVaultId && s.solanaFeePayer) {
        feePayerAddress = s.solanaFeePayer.publicKey.toBase58();
      } else {
        feePayerAddress = await readFeePayerAddressForVault(s, input.vaultId);
      }

      let feePayerBalanceLamports: string | null = null;
      if (feePayerAddress) {
        const lamports = await ikaFeePayerBalanceLamportsForAddress(s, feePayerAddress);
        feePayerBalanceLamports = lamports.toString();
      }

      return {
        ...settingsToWire(settings),
        seekerAddress,
        feePayerAddress,
        feePayerBalanceLamports,
      };
    }),

  /**
   * partial update. mode-flip does NOT auto-drain, the UI is responsible for prompting the
   * user about residual funds before flipping `in_extension -> seeker_direct`, then calling
   * `drainIkaFeePayerToSeeker` if the user opted to drain.
   */
  setIkaFeeSettings: publicProcedure
    .input(
      z.object({
        vaultId: z.string().min(1),
        mode: z.enum(['in_extension', 'seeker_direct']).optional(),
        autoRefill: z.boolean().optional(),
        refillLamports: z.string().optional(),
        thresholdLamports: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const patch: Partial<IkaFeeSettings> = {};
      if (input.mode !== undefined) patch.mode = input.mode;
      if (input.autoRefill !== undefined) patch.autoRefill = input.autoRefill;
      if (input.refillLamports !== undefined) {
        try {
          patch.refillLamports = BigInt(input.refillLamports);
        } catch {
          throw new Error('refillLamports must be a non-negative integer string');
        }
        if (patch.refillLamports < 0n) {
          throw new Error('refillLamports must not be negative');
        }
      }
      if (input.thresholdLamports !== undefined) {
        try {
          patch.thresholdLamports = BigInt(input.thresholdLamports);
        } catch {
          throw new Error('thresholdLamports must be a non-negative integer string');
        }
        if (patch.thresholdLamports < 0n) {
          throw new Error('thresholdLamports must not be negative');
        }
      }
      const next = await updateIkaFeeSettings(input.vaultId, patch);
      return settingsToWire(next);
    }),

  /**
   * manual top-up. the user types an amount; we enqueue a hardware sign so the phone wallet
   * authorizes a Seeker -> fee-payer transfer for that amount. returns the on-chain tx
   * signature when confirmed.
   */
  topUpIkaFeePayer: publicProcedure
    .input(
      z.object({
        /** reserved for future multi-vault scope; current implementation operates on the active session. */
        vaultId: z.string().min(1),
        lamports: z.string().min(1),
      }),
    )
    .mutation(async ({ input }) => {
      const s = requireUnlockedSession();
      if (s.activeVaultId !== input.vaultId) {
        throw new Error('Top-up must run against the active vault, switch vaults first');
      }
      let amount: bigint;
      try {
        amount = BigInt(input.lamports);
      } catch {
        throw new Error('lamports must be a positive integer string');
      }
      if (amount <= 0n) throw new Error('lamports must be positive');
      return topUpFeePayerFromSeeker(s, amount);
    }),

  /**
   * drain the in-extension fee-payer keypair back to the user's Seeker address. used when:
   *  - user flips `in_extension -> seeker_direct` and wants to recover funds.
   *  - user wants to top down the fee account (e.g. they over-funded).
   *  - user is decommissioning a vault.
   *
   * default amount: full balance minus a small rent + fee buffer. caller can pass an explicit
   * `lamports` to drain only part.
   */
  drainIkaFeePayerToSeeker: publicProcedure
    .input(
      z.object({
        vaultId: z.string().min(1),
        lamports: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const s = requireUnlockedSession();
      if (s.activeVaultId !== input.vaultId) {
        throw new Error('Drain must run against the active vault, switch vaults first');
      }
      let lamports: bigint | undefined;
      if (input.lamports !== undefined) {
        try {
          lamports = BigInt(input.lamports);
        } catch {
          throw new Error('lamports must be a positive integer string');
        }
        if (lamports <= 0n) throw new Error('lamports must be positive');
      }
      const out = await drainFeePayerToSeeker(s, lamports !== undefined ? { lamports } : undefined);
      return { txSignature: out.txSignature, lamportsSent: out.lamportsSent.toString() };
    }),

  /**
   * drain a residual keypair from a `seeker_direct` vault. the session won't have loaded the
   * keypair (because the mode is seeker_direct), but the encrypted blob still has it. we read
   * the keypair bytes here and run the same drain primitive.
   *
   * returns 0-tx-signature if the residual address has no balance.
   */
  drainAbandonedFeePayer: publicProcedure
    .input(z.object({ vaultId: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const s = requireUnlockedSession();
      if (s.activeVaultId !== input.vaultId) {
        throw new Error('Drain must run against the active vault, switch vaults first');
      }
      const b64 = await readFeePayerSecretKeyB64ForVault(s, input.vaultId);
      if (!b64) {
        throw new Error('No residual fee-payer keypair on this vault');
      }
      const out = await drainFeePayerToSeeker(s, { feePayerSecretKeyB64: b64 });
      return { txSignature: out.txSignature, lamportsSent: out.lamportsSent.toString() };
    }),

  /**
   * convenience: returns the fee-payer balance for the active session's vault. used by the
   * main vault-detail view to render the discreet "ika fees" status badge ("auto-refill on,
   * 0.0094 SOL").
   */
  activeIkaFeePayerBalance: publicProcedure.query(async () => {
    const s = requireUnlockedSession();
    if (s.activeVaultBaseChain !== 'solana') return null;
    const lamports = await ikaFeePayerBalanceLamports(s);
    if (lamports === null) return null;
    return { lamports: lamports.toString() };
  }),

  /**
   * default tunables exposed to the UI so it can render placeholder amounts without
   * hardcoding lamport values in two places.
   */
  ikaFeeDefaults: publicProcedure.query(() => settingsToWire(defaultIkaFeeSettings())),
};
