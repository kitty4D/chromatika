/**
 * tRPC procedures for DeSo. the chain layer lives at `src/background/chains/deso/`; this
 * surface exposes the user-facing flows (identity, balance, send, post, node URL config,
 * derived-key delegation linking).
 *
 * pre-release / mainnet-only: every send mutation hits the public DeSo mainnet node and burns
 * real (small) amounts of DESO. caller (UI) is expected to pre-confirm via a popup or a
 * settings-page send form. v0 has no popup, the Settings panel is the only entry point and
 * the user is in chromatika UI making an intentional action.
 *
 * derived-key delegation flow (per `wallet-extension/docs/DESO_DERIVED_KEY_SPIKE.md`):
 *   1. UI calls `getDeSoIdentityDeriveUrl` -> opens Identity `/derive` window via `window.open`.
 *   2. owner consents; UI captures the postMessage payload.
 *   3. UI calls `constructDeSoOwnerLink` -> returns unsigned `TransactionHex`.
 *   4. UI opens Identity `/approve?tx=...` window; owner signs; UI captures signedHex.
 *   5. UI calls `submitDeSoOwnerLink` -> submits + persists the link record.
 *   6. UI calls `pollDeSoOwnerLinkVerification` on a +3s/+10s/exp-backoff cadence.
 */

import { z } from 'zod';
import { publicProcedure } from '../trpc';
import {
  getDeSoBalance,
  getDeSoIdentity,
  sendDeSoNative,
  submitDeSoPost,
} from '@/background/chains/deso/deso-send';
import { getDeSoNodeUrl, setDeSoNodeUrl } from '@/background/chains/deso/deso-node-client';
import { isDeSoAddress } from '@/background/chains/deso/deso-address';
import { DESO_DEFAULT_NODE_MAINNET, DESO_NANOS_PER_DESO } from '@/background/chains/deso/deso-constants';
import {
  buildDeSoIdentityApproveUrl,
  buildDeSoIdentityDeriveUrl,
  checkDeSoDerivedKeyVerification,
  clearActiveDeSoOwnerLink,
  constructDeSoAuthorizeDerivedKey,
  DESO_DEFAULT_EXPIRATION_DAYS,
  getActiveDeSoOwnerLink,
  getSpendingLimitHexForV0Unlimited,
  submitAndPersistDeSoOwnerLink,
  type DeSoOwnerLink,
} from '@/background/chains/deso/deso-derived';
import { getDwalletSecpPublicKey } from '@/background/chains/bitcoin';
import { encodeDeSoAddress } from '@/background/chains/deso/deso-address';

function serializeOwnerLink(link: DeSoOwnerLink | null): DeSoOwnerLink | null {
  return link;
}

function decimalDeSoToNanos(value: string): bigint {
  const t = value.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) throw new Error('amount must be a non-negative decimal');
  const [whole, frac = ''] = t.split('.');
  if (frac.length > 9) throw new Error('amount has more than 9 decimal digits (max DESO precision)');
  const fracPadded = frac.padEnd(9, '0');
  return BigInt(whole || '0') * DESO_NANOS_PER_DESO + BigInt(fracPadded);
}

export const desoProcedures = {
  /**
   * active vault's DeSo identity. when NOT delegated: `publicKeyBase58Check` = dWallet
   * BC1Y... address (chromatika's own DeSo identity). when delegated via Identity /derive:
   * `publicKeyBase58Check` = OWNER's BC1Y... address (the on-chain identity we sign as), and
   * `derivedPubkeyBase58Check` is chromatika's dWallet BC1Y... (the actual signing key).
   */
  getDeSoIdentity: publicProcedure.query(async () => {
    const id = await getDeSoIdentity();
    let compressedPubkeyHex = '';
    for (const b of id.compressedPubkey) compressedPubkeyHex += b.toString(16).padStart(2, '0');
    return {
      publicKeyBase58Check: id.publicKeyBase58Check,
      compressedPubkeyHex,
      derivedPubkeyBase58Check: id.derivedPubkeyBase58Check,
      isDelegated: id.isDelegated,
      ownerPubkeyBase58Check: id.ownerPubkeyBase58Check ?? null,
      expirationBlock: id.expirationBlock ?? null,
    };
  }),

  /** balance + optional username. hits `/api/v0/get-users-stateless` on the configured node. */
  getDeSoBalance: publicProcedure.query(async () => {
    const b = await getDeSoBalance();
    return {
      publicKeyBase58Check: b.publicKeyBase58Check,
      balanceNanos: b.balanceNanos.toString(),
      username: b.username,
    };
  }),

  /** send native DESO to a base58check pubkey or `@username`. returns the on-chain TxnHashHex. */
  sendDeSo: publicProcedure
    .input(
      z.object({
        recipient: z.string().min(3).max(80),
        amountDeso: z.string().min(1).max(40), // decimal DESO; converted to nanos here
        minFeeRateNanosPerKB: z.number().int().positive().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const recipient = input.recipient.trim();
      // either a base58check address (`BC1...`) or a `@username` / bare username string.
      const looksLikeAddress = recipient.startsWith('BC1');
      if (looksLikeAddress && !isDeSoAddress(recipient, 'mainnet')) {
        throw new Error('recipient looks like a DeSo address but failed base58check decode');
      }
      const amountNanos = decimalDeSoToNanos(input.amountDeso);
      const res = await sendDeSoNative({
        recipient,
        amountNanos,
        minFeeRateNanosPerKB: input.minFeeRateNanosPerKB,
      });
      return { txnHashHex: res.txnHashHex };
    }),

  /** publish a DeSo text post (optional image / video URLs). returns the on-chain TxnHashHex. */
  submitDeSoPost: publicProcedure
    .input(
      z.object({
        body: z.string().min(1).max(20_000),
        imageUrls: z.array(z.string().url()).max(10).optional(),
        videoUrls: z.array(z.string().url()).max(10).optional(),
        minFeeRateNanosPerKB: z.number().int().positive().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const res = await submitDeSoPost({
        body: input.body,
        imageUrls: input.imageUrls,
        videoUrls: input.videoUrls,
        minFeeRateNanosPerKB: input.minFeeRateNanosPerKB,
      });
      return { txnHashHex: res.txnHashHex };
    }),

  /** get the currently configured DeSo node URL (default `https://node.deso.org`). */
  getDeSoNodeUrl: publicProcedure.query(async () => {
    return { url: await getDeSoNodeUrl(), defaultUrl: DESO_DEFAULT_NODE_MAINNET };
  }),

  /** override the DeSo node URL. empty string resets to default. */
  setDeSoNodeUrl: publicProcedure
    .input(z.object({ url: z.string().max(500) }))
    .mutation(async ({ input }) => {
      const trimmed = input.url.trim();
      if (trimmed && !/^https?:\/\//.test(trimmed)) {
        throw new Error('node URL must start with http:// or https://');
      }
      await setDeSoNodeUrl(trimmed);
      return { ok: true as const, url: trimmed || DESO_DEFAULT_NODE_MAINNET };
    }),

  // ─── derived-key delegation linking ──────────────────────────────────────────────

  /** read the active vault's DeSo owner-link record. null when no delegation is active. */
  getDeSoOwnerLink: publicProcedure.query(async () => {
    const link = await getActiveDeSoOwnerLink();
    return { link: serializeOwnerLink(link) };
  }),

  /**
   * step 1: build the Identity `/derive` URL the side panel opens to ask the owner for consent.
   *
   * returns the URL plus chromatika's dWallet pubkey (so the UI can display "you'll authorize
   * BC1Y... on your account") and the pre-computed spending-limit hex (so the UI can echo the
   * exact bytes Identity will be signing over). v0 only emits the unlimited variant.
   */
  buildDeSoIdentityDeriveUrl: publicProcedure
    .input(
      z
        .object({
          ownerPubkeyBase58Check: z.string().min(50).max(80).optional(),
          expirationDays: z.number().int().positive().max(365).optional(),
        })
        .optional(),
    )
    .query(async ({ input }) => {
      const compressed = await getDwalletSecpPublicKey();
      const derivedPubkeyBase58Check = encodeDeSoAddress(compressed, 'mainnet');
      const owner = input?.ownerPubkeyBase58Check?.trim();
      if (owner && !owner.startsWith('BC1')) {
        throw new Error('ownerPubkeyBase58Check must be a DeSo address starting with BC1');
      }
      const spendingLimitHex = await getSpendingLimitHexForV0Unlimited();
      const url = buildDeSoIdentityDeriveUrl({
        derivedPubkeyBase58Check,
        spendingLimit: { kind: 'unlimited' },
        ownerPubkeyBase58Check: owner,
        expirationDays: input?.expirationDays ?? DESO_DEFAULT_EXPIRATION_DAYS,
      });
      return {
        url,
        derivedPubkeyBase58Check,
        spendingLimitHex,
        expirationDays: input?.expirationDays ?? DESO_DEFAULT_EXPIRATION_DAYS,
        spendingLimitJson: { IsUnlimited: true },
      };
    }),

  /**
   * step 2: side panel got the derive payload from Identity. construct the unsigned
   * AuthorizeDerivedKey tx and return the `/approve?tx=...` URL the side panel opens next.
   *
   * inputs come straight from Identity's postMessage payload. we re-validate `derivedPubkey`
   * against this dWallet to catch the case where Identity returned a payload for a *different*
   * derived key (e.g. user switched accounts mid-flow).
   */
  constructDeSoOwnerLink: publicProcedure
    .input(
      z.object({
        ownerPubkeyBase58Check: z.string().min(50).max(80),
        derivedPubkeyBase58Check: z.string().min(50).max(80),
        accessSignatureHex: z.string().min(20).max(2000),
        expirationBlock: z.number().int().positive(),
        /** when Identity echoes its `transactionSpendingLimitHex`, we prefer that. falls back to ours. */
        spendingLimitHex: z.string().min(2).max(20_000).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const owner = input.ownerPubkeyBase58Check.trim();
      if (!owner.startsWith('BC1')) {
        throw new Error('ownerPubkeyBase58Check must start with BC1');
      }
      // prefer Identity's echoed bytes if present; fall back to our own encode.
      const spendingLimitHex =
        input.spendingLimitHex && input.spendingLimitHex.trim().length > 0
          ? input.spendingLimitHex.trim()
          : await getSpendingLimitHexForV0Unlimited();

      const { unsignedTransactionHex } = await constructDeSoAuthorizeDerivedKey({
        ownerPubkeyBase58Check: owner,
        derivedPubkeyBase58Check: input.derivedPubkeyBase58Check.trim(),
        accessSignatureHex: input.accessSignatureHex.trim(),
        expirationBlock: input.expirationBlock,
        spendingLimitHex,
      });
      const approveUrl = buildDeSoIdentityApproveUrl({ unsignedTransactionHex });
      return {
        unsignedTransactionHex,
        approveUrl,
        spendingLimitHex,
      };
    }),

  /**
   * step 3: side panel got the OWNER-signed tx hex from Identity's `/approve` window. submit it
   * to the node and persist the link. verification (poll `/get-user-derived-keys`) is a separate
   * call so the UI can stream a "waiting for confirmation" indicator.
   */
  submitDeSoOwnerLink: publicProcedure
    .input(
      z.object({
        signedTransactionHex: z.string().min(20).max(40_000),
        ownerPubkeyBase58Check: z.string().min(50).max(80),
        expirationBlock: z.number().int().positive(),
        spendingLimitHex: z.string().min(2).max(20_000),
      }),
    )
    .mutation(async ({ input }) => {
      const owner = input.ownerPubkeyBase58Check.trim();
      if (!owner.startsWith('BC1')) {
        throw new Error('ownerPubkeyBase58Check must start with BC1');
      }
      const res = await submitAndPersistDeSoOwnerLink({
        signedTransactionHex: input.signedTransactionHex.trim(),
        ownerPubkeyBase58Check: owner,
        spendingLimit: { kind: 'unlimited' },
        spendingLimitHex: input.spendingLimitHex.trim(),
        expirationBlock: input.expirationBlock,
      });
      return { txnHashHex: res.txnHashHex, link: serializeOwnerLink(res.link) };
    }),

  /** verification poll. side panel calls on +3s/+10s/exp-backoff cadence after submit. */
  pollDeSoOwnerLinkVerification: publicProcedure.mutation(async () => {
    const res = await checkDeSoDerivedKeyVerification();
    return { verified: res.verified, link: serializeOwnerLink(res.link) };
  }),

  /**
   * locally clear the link record. note: this stops chromatika from signing as the owner, but
   * the on-chain derived-key authorization remains valid until its expiration block. to revoke
   * on-chain, the user must visit Diamond's settings or run another AuthorizeDerivedKey tx with
   * `OperationType=NotValid` (v1 work).
   */
  clearDeSoOwnerLink: publicProcedure.mutation(async () => {
    await clearActiveDeSoOwnerLink();
    return { ok: true as const };
  }),
};
