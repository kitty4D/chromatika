import { z } from 'zod';
import { publicProcedure } from '../trpc';
import {
  getX402Caps,
  setDefaultPerCounterpartyCap,
  setGlobalCap,
  setPerCounterpartyCap,
} from '@/background/x402/x402-caps';
import {
  clearAllX402Receipts,
  computeTodaysSpend,
  decryptX402ReceiptPrivate,
  getX402RetentionDays,
  isX402PrivateReceiptsEnabled,
  listReceipts,
  setReceiptQuality,
  setX402PrivateReceiptsEnabled,
  setX402RetentionDays,
} from '@/background/x402/x402-receipts';
import {
  dispatchX402PaymentRequired,
  recordX402Settlement,
} from '@/background/x402/x402-dispatch';
import {
  getPendingX402Meta,
  rejectPendingX402,
  resolvePendingX402,
} from '@/background/x402/x402-pending-queue';
import { buildAndSignX402Solana } from '@/background/x402/x402-solana-signer';
import { buildAndSignX402SolanaViaWalletConnect } from '@/background/x402/x402-walletconnect-signer';
import { getSession } from '@/background/session';

/**
 * x402 tRPC surface (foundation slice). read-side procedures + cap mutations only.
 * `quoteAndSign`, `approveAndSign`, and the 402 interception path land in subsequent slices
 * once the signer + facilitator wiring is in place.
 *
 * win 2 from the brainstorm plan. Solana-only + USDC-only + `exact` scheme for v1.
 */

export const x402Procedures = {
  x402GetCaps: publicProcedure.query(async () => {
    const caps = await getX402Caps();
    const spendToday = await computeTodaysSpend();
    return { caps, spendToday };
  }),

  x402SetPerCounterpartyCap: publicProcedure
    .input(
      z.object({
        host: z.string().trim().min(1).max(253),
        capUsd: z.number().nonnegative().nullable(),
      }),
    )
    .mutation(({ input }) => setPerCounterpartyCap(input.host, input.capUsd)),

  x402SetGlobalCap: publicProcedure
    .input(z.object({ capUsd: z.number().nonnegative().nullable() }))
    .mutation(({ input }) => setGlobalCap(input.capUsd)),

  x402SetDefaultCap: publicProcedure
    .input(z.object({ capUsd: z.number().nonnegative() }))
    .mutation(({ input }) => setDefaultPerCounterpartyCap(input.capUsd)),

  x402ListReceipts: publicProcedure
    .input(z.object({ limit: z.number().int().min(1).max(200).optional() }).optional())
    .query(({ input }) => listReceipts({ limit: input?.limit })),

  x402SetReceiptQuality: publicProcedure
    .input(
      z.object({
        id: z.string().min(1),
        quality: z.enum(['good', 'bad']).nullable(),
      }),
    )
    .mutation(({ input }) => setReceiptQuality(input.id, input.quality)),

  // ---- private receipts (chromatika_x402_private_receipts_v1) ----

  /** read the private-receipts toggle state. */
  getX402PrivateReceiptsState: publicProcedure.query(async () => {
    const enabled = await isX402PrivateReceiptsEnabled();
    return { enabled };
  }),

  /** persist the private-receipts toggle. new receipts encrypt; existing rows stay as-recorded. */
  setX402PrivateReceipts: publicProcedure
    .input(z.object({ enabled: z.boolean() }))
    .mutation(async ({ input }) => {
      await setX402PrivateReceiptsEnabled(input.enabled);
      return { ok: true as const, enabled: input.enabled };
    }),

  /**
   * decrypt one private-encrypted receipt. one-shot, the plain values are returned and never
   * persisted back to chrome.storage. caller (UI) renders in-memory + re-locks on close.
   */
  decryptX402Receipt: publicProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const plain = await decryptX402ReceiptPrivate(input.id);
      if (!plain) {
        return { found: false as const };
      }
      return {
        found: true as const,
        resourceUrl: plain.resourceUrl,
        sellerAddress: plain.sellerAddress,
        signatureHex: plain.signatureHex,
      };
    }),

  // ---- retention ----

  /** read current retention window. default 30 days. */
  getX402Retention: publicProcedure.query(async () => {
    const days = await getX402RetentionDays();
    return { days };
  }),

  /** set retention window. existing receipts older than the new window are pruned on next list/append. */
  setX402Retention: publicProcedure
    .input(
      z.object({
        days: z.union([z.literal(1), z.literal(7), z.literal(30), z.literal(90), z.literal('forever')]),
      }),
    )
    .mutation(async ({ input }) => {
      await setX402RetentionDays(input.days);
      // touch listReceipts so the prune runs immediately rather than waiting for the next caller.
      await listReceipts({ limit: 1 });
      return { ok: true as const, days: input.days };
    }),

  /** drop every receipt unconditionally. user-driven hygiene action. */
  clearAllX402Receipts: publicProcedure.mutation(async () => {
    return clearAllX402Receipts();
  }),

  // dispatcher entry point. caller (eventually inject.ts via the dapp bridge) hands the
  // base64 PAYMENT-REQUIRED header value + caller hint; this kicks the popup and resolves
  // with the signed PAYMENT-SIGNATURE header value once the user approves. tRPC mutation
  // because the side effect (popup, signature, receipt write) is non-idempotent.
  x402QuoteAndSign: publicProcedure
    .input(
      z.object({
        paymentRequiredHeaderB64: z.string().min(1),
        callerHint: z.string().max(256).optional(),
      }),
    )
    .mutation(({ input }) =>
      dispatchX402PaymentRequired({
        paymentRequiredHeaderB64: input.paymentRequiredHeaderB64,
        callerHint: input.callerHint,
      }),
    ),

  x402RecordSettlement: publicProcedure
    .input(
      z.object({
        receiptId: z.string().min(1),
        paymentResponseHeaderB64: z.string().min(1),
      }),
    )
    .mutation(({ input }) =>
      recordX402Settlement({
        receiptId: input.receiptId,
        paymentResponseHeaderB64: input.paymentResponseHeaderB64,
      }),
    ),

  // popup-mediated procedures - the X402ApprovalScreen (URL param `x402approve=<id>`) calls these.

  getPendingX402Request: publicProcedure
    .input(z.object({ id: z.string().min(1) }))
    .query(({ input }) => {
      const meta = getPendingX402Meta(input.id);
      if (!meta) throw new Error(`No pending x402 request: ${input.id}`);
      return meta;
    }),

  approvePendingX402: publicProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const meta = getPendingX402Meta(input.id);
      if (!meta) throw new Error(`No pending x402 request: ${input.id}`);
      try {
        // dispatch on the active session: a WalletConnect-paired phone wallet (Seeker /
        // Phantom / Solflare) signs directly via WC relay; ika MPC is bypassed. when no WC
        // is paired, fall back to the dWallet ika MPC path.
        const session = getSession();
        const useWc = session?.solanaWcAccount != null;
        const signed = useWc
          ? await buildAndSignX402SolanaViaWalletConnect({ requirements: meta.requirements })
          : await buildAndSignX402Solana({ requirements: meta.requirements });
        resolvePendingX402(input.id, {
          headerValue: signed.headerValue,
          sourceAta: signed.sourceAta,
          destAta: signed.destAta,
          memoText: signed.memoText,
          receiptId: meta.receiptId,
        });
        return {
          ok: true as const,
          headerValue: signed.headerValue,
          sourceAta: signed.sourceAta,
          destAta: signed.destAta,
          memoText: signed.memoText,
          signerPath: useWc ? ('walletconnect' as const) : ('ika' as const),
        };
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        try {
          rejectPendingX402(input.id, reason);
        } catch {
          /* already removed */
        }
        throw e;
      }
    }),

  rejectPendingX402: publicProcedure
    .input(z.object({ id: z.string().min(1), reason: z.string().default('user_canceled') }))
    .mutation(({ input }) => {
      try {
        rejectPendingX402(input.id, input.reason);
      } catch {
        // already resolved/rejected/expired - swallow so the popup can close cleanly.
      }
      return { ok: true as const };
    }),
};
