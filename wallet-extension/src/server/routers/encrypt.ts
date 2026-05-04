import { z } from 'zod';
import { publicProcedure } from '../trpc';
import { assertEncryptSolanaIkaBase } from '@/background/encrypt/encrypt-guard';
import {
  clearDwalletLabelCiphertext,
  createDwalletLabelCiphertext,
  encryptDepositImplementationHint,
  encryptLabCreateInputDemo,
  encryptLabCreateInputDemoBatch,
  encryptLabReadCiphertextDemo,
  getDwalletEncryptedLabelOnChainStatus,
  getDwalletEncryptedLabelStatus,
  getEncryptedLabelAutoRebuildEnabled,
  rebuildDwalletLabelAfterDevnetWipe,
  revealDwalletLabelCiphertext,
  setEncryptedLabelAutoRebuildEnabled,
} from '@/background/encrypt/encrypt-lab-service';
import { getSplEncDepositPathNotes } from '@/background/encrypt/encrypt-spl-deposit-stub';
import {
  getEncryptPcSwapPhase4Stub,
  getEncryptPcTokenPhase3Stub,
} from '@/background/encrypt/encrypt-pc-phase-stub';

export const encryptProcedures = {
  encryptLabCreateInput: publicProcedure
    .input(
      z.object({
        plainU64: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        networkEncryptionPublicKeyHex: z.string().trim().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      assertEncryptSolanaIkaBase();
      return encryptLabCreateInputDemo(input);
    }),

  encryptLabCreateInputBatch: publicProcedure
    .input(
      z.object({
        plainU64s: z.array(z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)).min(1).max(16),
        networkEncryptionPublicKeyHex: z.string().trim().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      assertEncryptSolanaIkaBase();
      return encryptLabCreateInputDemoBatch({
        plainU64Values: input.plainU64s,
        networkEncryptionPublicKeyHex: input.networkEncryptionPublicKeyHex,
      });
    }),

  encryptLabDepositHint: publicProcedure.query(() => encryptDepositImplementationHint()),

  encryptSplEncDepositPath: publicProcedure.query(() => getSplEncDepositPathNotes()),

  encryptPcTokenPhase3: publicProcedure.query(() => getEncryptPcTokenPhase3Stub()),

  encryptPcSwapPhase4: publicProcedure.query(() => getEncryptPcSwapPhase4Stub()),

  encryptLabReadCiphertext: publicProcedure
    .input(
      z.object({
        ciphertextIdentifierHex: z.string().trim().min(2),
        epochDecimal: z.string().trim().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      assertEncryptSolanaIkaBase();
      let epoch = 0n;
      if (input.epochDecimal?.length) {
        try {
          epoch = BigInt(input.epochDecimal);
        } catch {
          throw new Error('epoch must be a decimal integer string');
        }
      }
      return encryptLabReadCiphertextDemo({
        ciphertextIdentifierHex: input.ciphertextIdentifierHex,
        epoch,
      });
    }),

  // win 1: labels-via-encrypt. lab-grade pre-alpha; cipher-text bytes can be plaintext on-chain.
  // utf-8 cap is 16 bytes (one EUint128 ciphertext) for v1; chunked labels land later.

  // non-throwing read; returns `enabledForSession: false` on sui-base vaults so UI can hide.
  getDwalletLabelStatus: publicProcedure
    .input(z.object({ curve: z.enum(['SECP256K1', 'ED25519']) }))
    .query(({ input }) => getDwalletEncryptedLabelStatus({ curve: input.curve })),

  // one-shot read of the on-chain ciphertext account status (offset 99 = status byte).
  // throws on non-solana-base vaults; UI guards on getDwalletLabelStatus.enabledForSession first.
  getDwalletLabelOnChainStatus: publicProcedure
    .input(z.object({ curve: z.enum(['SECP256K1', 'ED25519']) }))
    .query(({ input }) => getDwalletEncryptedLabelOnChainStatus({ curve: input.curve })),

  encryptDwalletLabel: publicProcedure
    .input(
      z.object({
        curve: z.enum(['SECP256K1', 'ED25519']),
        label: z.string().min(1).max(64),
        networkEncryptionPublicKeyHex: z.string().trim().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      // delegated assertEncryptSolanaIkaBase happens inside the helper too, but we run it here
      // before any utf-8 work so non-solana-base vaults fail fast with a clean error.
      assertEncryptSolanaIkaBase();
      return createDwalletLabelCiphertext({
        curve: input.curve,
        label: input.label,
        networkEncryptionPublicKeyHex: input.networkEncryptionPublicKeyHex,
      });
    }),

  revealDwalletLabel: publicProcedure
    .input(z.object({ curve: z.enum(['SECP256K1', 'ED25519']) }))
    .mutation(async ({ input }) => {
      assertEncryptSolanaIkaBase();
      return revealDwalletLabelCiphertext({ curve: input.curve });
    }),

  clearDwalletLabel: publicProcedure
    .input(z.object({ curve: z.enum(['SECP256K1', 'ED25519']) }))
    .mutation(async ({ input }) => {
      assertEncryptSolanaIkaBase();
      await clearDwalletLabelCiphertext({ curve: input.curve });
      return { ok: true as const };
    }),

  /**
   * read the user's opt-in for the encrypt-label auto-rebuild flow. when ON, future label
   * encrypts cache the plaintext locally so a devnet-wipe-triggered rebuild can re-encrypt
   * without prompting. returns false by default (opt-in).
   */
  getEncryptedLabelAutoRebuildEnabled: publicProcedure.query(() =>
    getEncryptedLabelAutoRebuildEnabled().then((enabled) => ({ enabled })),
  ),

  setEncryptedLabelAutoRebuildEnabled: publicProcedure
    .input(z.object({ enabled: z.boolean() }))
    .mutation(async ({ input }) => {
      await setEncryptedLabelAutoRebuildEnabled(input.enabled);
      return { ok: true as const };
    }),

  /**
   * re-encrypt a label after a devnet wipe using the locally-cached plaintext (only
   * available when the user had auto-rebuild ON when they originally encrypted). throws
   * when no plaintext is cached, UI tells the user to clear + re-encrypt manually.
   */
  rebuildDwalletLabelAfterDevnetWipe: publicProcedure
    .input(z.object({ curve: z.enum(['SECP256K1', 'ED25519']) }))
    .mutation(async ({ input }) => {
      assertEncryptSolanaIkaBase();
      return rebuildDwalletLabelAfterDevnetWipe({ curve: input.curve });
    }),
};
