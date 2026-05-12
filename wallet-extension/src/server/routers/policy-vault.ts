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
import {
  isPolicyVaultPromptGloballyDismissed,
  setPolicyVaultPromptGloballyDismissed,
} from '@/background/policy-vault-prompt';
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
  loadAllPolicyVaultStates,
  setPolicyStageCapRaises,
  setPolicyStageDelayMs,
  commitPendingPolicyCap,
  commitPendingPolicyStageOff,
  requestPolicyUnwrap,
  cancelPolicyUnwrap,
  claimPolicyUnwrap,
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
  /** active vault's policy state: link + freshly-read on-chain snapshot.
   *
   * Policy Vault is Sui-only: the Solana Anchor program at
   * `solana/chromatika-policy/` is pre-alpha scaffolding (CPI bodies stub to no-ops
   * pending ika Solana Alpha-1), so we short-circuit here for Solana-base vaults and
   * let the UI render the "not available on this base chain" branch instead of
   * loading state that we cannot meaningfully act on. `activeVaultBaseChain` lets
   * the panel + banner pick the right copy without a second roundtrip.
   */
  getPolicyVaultState: publicProcedure.query(async () => {
    const s = getSession();
    const activeVaultBaseChain: 'sui' | 'solana' = s?.activeVaultBaseChain ?? 'sui';
    if (activeVaultBaseChain === 'solana') {
      return {
        packageConfig: null,
        links: [] as Array<{ link: PolicyVaultLink; snapshot: PolicyVaultSnapshot | null }>,
        activeVaultBaseChain,
      };
    }
    const links = await loadAllPolicyVaultStates();
    const cfg = await getPolicyPackageConfig();
    return {
      packageConfig: cfg,
      links: links.map(({ link, snapshot }) => ({
        link: serializeLink(link) ?? link,
        snapshot: serializeSnapshot(snapshot),
      })),
      activeVaultBaseChain,
    };
  }),

  /** read the configured Sui package id (set after the chromatika_policy Move package is deployed). */
  getPolicyPackageConfig: publicProcedure.query(async () => {
    const cfg = await getPolicyPackageConfig();
    return { config: cfg };
  }),

  /** Read the global "don't ask me again" flag for the post-dWallet-creation Policy Vault
   *  prompt (`PostCreatePolicyVaultPrompt`). When true, the modal does not surface after
   *  any new dWallet creation on any vault. Toggle via `setPolicyVaultPromptGloballyDismissed`
   *  or Settings -> Safety -> "Prompts I've dismissed". */
  getPolicyVaultPromptState: publicProcedure.query(async () => ({
    globallyDismissed: await isPolicyVaultPromptGloballyDismissed(),
  })),

  /** Set the global "don't ask me again" flag for the post-dWallet-creation Policy Vault prompt. */
  setPolicyVaultPromptGloballyDismissed: publicProcedure
    .input(z.object({ dismissed: z.boolean() }))
    .mutation(async ({ input }) => {
      await setPolicyVaultPromptGloballyDismissed(input.dismissed);
      return { ok: true as const };
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
        /** Which curve dWallet to wrap. Defaults to SECP256K1 for back-compat with the
         *  Settings panel opt-in form, which always wrapped the SECP slot. The
         *  PostCreatePolicyVaultPrompt passes the curve of the dWallet just created. */
        curve: z.enum(['SECP256K1', 'ED25519']).optional(),
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
        curve: input.curve,
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

  /** panic: flips the on-chain flag for a specific wrapped dwallet. idempotent. */
  panicVault: publicProcedure
    .input(z.object({ dwalletId: SuiAddressSchema }))
    .mutation(async ({ input }) => {
      return await panicPolicyVault(input.dwalletId);
    }),

  /** unfreeze: clears the panic flag for a specific dwallet. aborts on-chain if delay still active. */
  unfreezeVault: publicProcedure
    .input(z.object({ dwalletId: SuiAddressSchema }))
    .mutation(async ({ input }) => {
      return await unfreezePolicyVault(input.dwalletId);
    }),

  setPolicyDailyCap: publicProcedure
    .input(z.object({ dwalletId: SuiAddressSchema, newCapMicros: BigIntStringSchema }))
    .mutation(async ({ input }) => {
      return await setPolicyDailyCap(input.dwalletId, BigInt(input.newCapMicros));
    }),

  /**
   * toggle the cap-increase staged delay opt-in. turning ON is immediate; turning OFF is
   * staged (symmetric protection, a compromised chromatika can't trivially disable the
   * safety net before the user notices).
   */
  setPolicyStageCapRaises: publicProcedure
    .input(z.object({ dwalletId: SuiAddressSchema, next: z.boolean() }))
    .mutation(async ({ input }) => {
      return await setPolicyStageCapRaises(input.dwalletId, input.next);
    }),

  /**
   * update the stage delay duration (ms). increases are immediate; decreases are staged
   * when staging is currently ON.
   */
  setPolicyStageDelayMs: publicProcedure
    .input(z.object({ dwalletId: SuiAddressSchema, newDelayMs: BigIntStringSchema }))
    .mutation(async ({ input }) => {
      return await setPolicyStageDelayMs(input.dwalletId, BigInt(input.newDelayMs));
    }),

  /** force-commit a pending cap raise once the delay has elapsed. */
  commitPendingPolicyCap: publicProcedure
    .input(z.object({ dwalletId: SuiAddressSchema }))
    .mutation(async ({ input }) => {
      return await commitPendingPolicyCap(input.dwalletId);
    }),

  /** force-commit a pending stage-off once the delay has elapsed. */
  commitPendingPolicyStageOff: publicProcedure
    .input(z.object({ dwalletId: SuiAddressSchema }))
    .mutation(async ({ input }) => {
      return await commitPendingPolicyStageOff(input.dwalletId);
    }),

  setPolicyCoolDown: publicProcedure
    .input(z.object({ dwalletId: SuiAddressSchema, newCoolDownMs: BigIntStringSchema }))
    .mutation(async ({ input }) => {
      return await setPolicyCoolDown(input.dwalletId, BigInt(input.newCoolDownMs));
    }),

  setPolicyRescueAddress: publicProcedure
    .input(
      z.object({
        dwalletId: SuiAddressSchema,
        rescueAddress: z.string().max(200).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const bytes =
        input.rescueAddress && input.rescueAddress.length > 0
          ? new TextEncoder().encode(input.rescueAddress)
          : null;
      return await setPolicyRescueAddress(input.dwalletId, bytes);
    }),

  addPolicyActuator: publicProcedure
    .input(z.object({ dwalletId: SuiAddressSchema, newActuator: SuiAddressSchema }))
    .mutation(async ({ input }) => {
      return await addPolicyActuator(input.dwalletId, input.newActuator);
    }),

  removePolicyActuator: publicProcedure
    .input(z.object({ dwalletId: SuiAddressSchema, target: SuiAddressSchema }))
    .mutation(async ({ input }) => {
      return await removePolicyActuator(input.dwalletId, input.target);
    }),

  /** add a presign to the vault's pool. costs IKA + SUI fees from the vault's balance. */
  replenishPolicyPresign: publicProcedure
    .input(z.object({ dwalletId: SuiAddressSchema }))
    .mutation(async ({ input }) => {
      return await replenishPolicyPresign(input.dwalletId);
    }),

  topUpPolicyIka: publicProcedure
    .input(z.object({ dwalletId: SuiAddressSchema, amountMist: BigIntStringSchema }))
    .mutation(async ({ input }) => {
      return await topUpPolicyIka(input.dwalletId, BigInt(input.amountMist));
    }),

  topUpPolicySui: publicProcedure
    .input(z.object({ dwalletId: SuiAddressSchema, amountMist: BigIntStringSchema }))
    .mutation(async ({ input }) => {
      return await topUpPolicySui(input.dwalletId, BigInt(input.amountMist));
    }),

  /** clears the local link for a specific dwallet. on-chain object remains; local-only forget. */
  clearLocalPolicyVaultLink: publicProcedure
    .input(z.object({ dwalletId: SuiAddressSchema }))
    .mutation(async ({ input }) => {
      await clearLocalPolicyVaultLink(input.dwalletId);
      return { ok: true as const };
    }),

  /**
   * Two-step exit: request an unwrap for a specific dwallet. Opens the staged delay window.
   * After `stage_delay_ms` elapses, `claimPolicyUnwrap` consumes the on-chain vault and
   * returns the DWalletCap to the user. During the wait, any actuator can call `panicVault`
   * to block the claim.
   *
   * Returns `claimableAtMs` so the UI can render a live countdown.
   */
  requestPolicyUnwrap: publicProcedure
    .input(z.object({ dwalletId: SuiAddressSchema }))
    .mutation(async ({ input }) => {
      return await requestPolicyUnwrap(input.dwalletId);
    }),

  /** Two-step exit: cancel a pending unwrap. Safe even while panicked. */
  cancelPolicyUnwrap: publicProcedure
    .input(z.object({ dwalletId: SuiAddressSchema }))
    .mutation(async ({ input }) => {
      return await cancelPolicyUnwrap(input.dwalletId);
    }),

  /**
   * Two-step exit: claim the unwrap once the staged delay has elapsed. Consumes the
   * on-chain `PolicyVault`, returns the `DWalletCap` + leftover IKA/SUI balances and
   * presigns to the fee-payer address, clears the local link. Aborts on chain if the
   * delay has not elapsed or the vault is panicked.
   */
  claimPolicyUnwrap: publicProcedure
    .input(z.object({ dwalletId: SuiAddressSchema }))
    .mutation(async ({ input }) => {
      return await claimPolicyUnwrap(input.dwalletId);
    }),

  /**
   * read the local audit log of policy decisions for a specific dwallet. capped at 200 most
   * recent entries; the Sui chain's emitted events remain queryable forever via Suiscan.
   */
  getPolicyAuditEntries: publicProcedure
    .input(
      z.object({
        dwalletId: SuiAddressSchema,
        limit: z.number().int().positive().max(200).optional(),
      }),
    )
    .query(async ({ input }) => {
      const s = getSession();
      if (!s?.activeVaultId) return { entries: [] };
      const entries = await listPolicyAuditEntries(s.activeVaultId, input.dwalletId, input.limit);
      return { entries };
    }),

  /** wipe the local audit log for a specific dwallet. */
  clearPolicyAuditEntries: publicProcedure
    .input(z.object({ dwalletId: SuiAddressSchema }))
    .mutation(async ({ input }) => {
      const s = getSession();
      if (!s?.activeVaultId) return { ok: true as const };
      await clearPolicyAuditEntries(s.activeVaultId, input.dwalletId);
      return { ok: true as const };
    }),
};
