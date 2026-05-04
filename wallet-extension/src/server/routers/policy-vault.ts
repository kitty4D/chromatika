/**
 * tRPC procedures for the chromatika `PolicyVault` (on-chain spend caps + panic + rescue).
 *
 * surface map:
 *   read:  getPolicyVaultState, getPolicyPackageConfig
 *   write: setPolicyPackageId, clearPolicyPackageId
 *   opt-in:  optInToPolicyVault
 *   panic:   panicVault, unfreezeVault
 *   tune:    setDailyCap, setCoolDown, setRescueAddress
 *   staging: setPolicyStageCapRaises, setPolicyStageDelayMs,
 *            commitPendingPolicyCap, commitPendingPolicyStageOff
 *   actuators: addActuator, removeActuator
 *   ops:     replenishPresign, topUpIka, topUpSui
 *   local:   clearLocalLink   (does NOT revoke on-chain; local pointer only)
 *
 * mounted via `src/server/router.ts`. UI surface lives at
 * `src/ui/components/PolicyVaultPanel.tsx` (Settings -> Security).
 */

import { z } from 'zod';
import { publicProcedure } from '../trpc';
import {
  getPolicyPackageConfig,
  setPolicyPackageConfig,
  clearPolicyPackageConfig,
  type PolicyVaultLink,
  type PolicyVaultSnapshot,
} from '@/background/policy-vault/policy-vault-storage';
import {
  listPolicyAuditEntries,
  clearPolicyAuditEntries,
} from '@/background/policy-vault/policy-vault-audit';
import { getSession } from '@/background/session';
import {
  optInToPolicyVault,
  panicPolicyVault,
  unfreezePolicyVault,
  setPolicyDailyCap,
  setPolicyCoolDown,
  setPolicyRescueAddress,
  addPolicyActuator,
  removePolicyActuator,
  replenishPolicyPresign,
  topUpPolicyIka,
  topUpPolicySui,
  clearLocalPolicyVaultLink,
  loadPolicyVaultState,
  setPolicyStageCapRaises,
  setPolicyStageDelayMs,
  commitPendingPolicyCap,
  commitPendingPolicyStageOff,
} from '@/background/policy-vault/policy-vault-actions';

// helpers: JSON-safe serialization of bigint-bearing snapshots.
function serializeLink(link: PolicyVaultLink | null): PolicyVaultLink | null {
  return link;
}
function serializeSnapshot(snapshot: PolicyVaultSnapshot | null): PolicyVaultSnapshot | null {
  return snapshot;
}

const SuiAddressSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'must be 0x-prefixed 32-byte hex');
const PackageIdSchema = SuiAddressSchema;
const BigIntStringSchema = z.string().regex(/^\d+$/, 'must be a non-negative integer string');

export const policyVaultProcedures = {
  /** active vault's policy state: link + freshly-read on-chain snapshot. */
  getPolicyVaultState: publicProcedure.query(async () => {
    const { link, snapshot } = await loadPolicyVaultState();
    const cfg = await getPolicyPackageConfig();
    return {
      packageConfig: cfg,
      link: serializeLink(link),
      snapshot: serializeSnapshot(snapshot),
    };
  }),

  /** read the configured Sui package id (set after the chromatika_policy Move package is deployed). */
  getPolicyPackageConfig: publicProcedure.query(async () => {
    const cfg = await getPolicyPackageConfig();
    return { config: cfg };
  }),

  /** set the Sui package id pointing to the deployed `chromatika_policy` package. */
  setPolicyPackageId: publicProcedure
    .input(z.object({ packageId: PackageIdSchema, label: z.string().max(80).optional() }))
    .mutation(async ({ input }) => {
      await setPolicyPackageConfig({
        packageId: input.packageId,
        setAtMs: Date.now(),
        label: input.label,
      });
      return { ok: true as const };
    }),

  /** forget the package id (e.g. switching to a different deployment). */
  clearPolicyPackageId: publicProcedure.mutation(async () => {
    await clearPolicyPackageConfig();
    return { ok: true as const };
  }),

  /**
   * opt in: wraps the active vault's SECP256K1 dWallet cap into a shared `PolicyVault`.
   * returns the link record + Sui tx digest.
   *
   * note: post-opt-in, the dWallet cap is owned by the shared object; chromatika's existing
   * direct-sign path WILL NOT WORK for this dWallet anymore. v1 wires the EVM/BTC send
   * paths to dispatch through `sign_with_policy` automatically; v0 leaves direct signing
   * intact for users who haven't opted in. opt-in today is a one-way gate per dWallet.
   */
  optInToPolicyVault: publicProcedure
    .input(
      z.object({
        dwalletId: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
        dailyCapMicros: BigIntStringSchema,
        coolDownMs: BigIntStringSchema,
        unfreezeDelayMs: BigIntStringSchema,
        rescueAddress: z.string().max(200).optional(),
        /**
         * delay (ms) used by the cap-increase staged delay opt-in safety. default 24h.
         * the toggle (`stageCapRaises`) ships OFF; the user opts in via `setPolicyStageCapRaises`.
         */
        stageDelayMs: BigIntStringSchema.optional(),
        initialIkaMist: BigIntStringSchema,
        initialSuiMist: BigIntStringSchema,
      }),
    )
    .mutation(async ({ input }) => {
      const rescueAddressBytes =
        input.rescueAddress && input.rescueAddress.length > 0
          ? new TextEncoder().encode(input.rescueAddress)
          : null;
      const res = await optInToPolicyVault({
        dwalletId: input.dwalletId,
        dailyCapMicros: BigInt(input.dailyCapMicros),
        coolDownMs: BigInt(input.coolDownMs),
        unfreezeDelayMs: BigInt(input.unfreezeDelayMs),
        rescueAddressBytes,
        stageDelayMs: input.stageDelayMs ? BigInt(input.stageDelayMs) : undefined,
        initialIkaMist: BigInt(input.initialIkaMist),
        initialSuiMist: BigInt(input.initialSuiMist),
      });
      return { link: serializeLink(res.link), digest: res.digest };
    }),

  /** panic: flips the on-chain flag. idempotent. */
  panicVault: publicProcedure.mutation(async () => {
    return await panicPolicyVault();
  }),

  /** unfreeze: clears the panic flag. aborts on-chain if delay still active. */
  unfreezeVault: publicProcedure.mutation(async () => {
    return await unfreezePolicyVault();
  }),

  setPolicyDailyCap: publicProcedure
    .input(z.object({ newCapMicros: BigIntStringSchema }))
    .mutation(async ({ input }) => {
      return await setPolicyDailyCap(BigInt(input.newCapMicros));
    }),

  /**
   * toggle the cap-increase staged delay opt-in. turning ON is immediate; turning OFF is
   * staged (symmetric protection, a compromised chromatika can't trivially disable the
   * safety net before the user notices).
   */
  setPolicyStageCapRaises: publicProcedure
    .input(z.object({ next: z.boolean() }))
    .mutation(async ({ input }) => {
      return await setPolicyStageCapRaises(input.next);
    }),

  /**
   * update the stage delay duration (ms). increases are immediate; decreases are staged
   * when staging is currently ON.
   */
  setPolicyStageDelayMs: publicProcedure
    .input(z.object({ newDelayMs: BigIntStringSchema }))
    .mutation(async ({ input }) => {
      return await setPolicyStageDelayMs(BigInt(input.newDelayMs));
    }),

  /** force-commit a pending cap raise once the delay has elapsed. */
  commitPendingPolicyCap: publicProcedure.mutation(async () => {
    return await commitPendingPolicyCap();
  }),

  /** force-commit a pending stage-off once the delay has elapsed. */
  commitPendingPolicyStageOff: publicProcedure.mutation(async () => {
    return await commitPendingPolicyStageOff();
  }),

  setPolicyCoolDown: publicProcedure
    .input(z.object({ newCoolDownMs: BigIntStringSchema }))
    .mutation(async ({ input }) => {
      return await setPolicyCoolDown(BigInt(input.newCoolDownMs));
    }),

  setPolicyRescueAddress: publicProcedure
    .input(z.object({ rescueAddress: z.string().max(200).optional() }))
    .mutation(async ({ input }) => {
      const bytes =
        input.rescueAddress && input.rescueAddress.length > 0
          ? new TextEncoder().encode(input.rescueAddress)
          : null;
      return await setPolicyRescueAddress(bytes);
    }),

  addPolicyActuator: publicProcedure
    .input(z.object({ newActuator: SuiAddressSchema }))
    .mutation(async ({ input }) => {
      return await addPolicyActuator(input.newActuator);
    }),

  removePolicyActuator: publicProcedure
    .input(z.object({ target: SuiAddressSchema }))
    .mutation(async ({ input }) => {
      return await removePolicyActuator(input.target);
    }),

  /** add a presign to the vault's pool. costs IKA + SUI fees from the vault's balance. */
  replenishPolicyPresign: publicProcedure.mutation(async () => {
    return await replenishPolicyPresign();
  }),

  topUpPolicyIka: publicProcedure
    .input(z.object({ amountMist: BigIntStringSchema }))
    .mutation(async ({ input }) => {
      return await topUpPolicyIka(BigInt(input.amountMist));
    }),

  topUpPolicySui: publicProcedure
    .input(z.object({ amountMist: BigIntStringSchema }))
    .mutation(async ({ input }) => {
      return await topUpPolicySui(BigInt(input.amountMist));
    }),

  /** clears the local link. on-chain object remains; this is local-only forget. */
  clearLocalPolicyVaultLink: publicProcedure.mutation(async () => {
    await clearLocalPolicyVaultLink();
    return { ok: true as const };
  }),

  /**
   * read the local audit log of policy decisions. capped at 200 most recent entries; the
   * Sui chain's emitted events remain queryable forever via Suiscan.
   */
  getPolicyAuditEntries: publicProcedure
    .input(z.object({ limit: z.number().int().positive().max(200).optional() }).optional())
    .query(async ({ input }) => {
      const s = getSession();
      if (!s?.activeVaultId) return { entries: [] };
      const entries = await listPolicyAuditEntries(s.activeVaultId, input?.limit);
      return { entries };
    }),

  /** wipe the local audit log for the active vault. */
  clearPolicyAuditEntries: publicProcedure.mutation(async () => {
    const s = getSession();
    if (!s?.activeVaultId) return { ok: true as const };
    await clearPolicyAuditEntries(s.activeVaultId);
    return { ok: true as const };
  }),
};
