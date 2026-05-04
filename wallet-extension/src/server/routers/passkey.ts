import { z } from 'zod';
import { publicProcedure } from '../trpc';
import {
  enqueuePasskeyRegister,
  enqueuePasskeySign,
  enqueuePasskeyRecover,
  getPendingPasskeyRegisterMeta,
  getPendingPasskeySignMeta,
  getPendingPasskeyRecoverMeta,
  rejectPendingPasskeyRegister,
  rejectPendingPasskeySign,
  rejectPendingPasskeyRecover,
  resolvePendingPasskeyRegister,
  resolvePendingPasskeySign,
  resolvePendingPasskeyRecover,
} from '@/background/passkey/passkey-pending-queue';
import {
  addPasskeyVault,
  createPasskeyVault,
} from '@/background/wallet-service';
import { chromatikaPrfSaltB64 } from '@/background/passkey/passkey-derive';

/**
 * tRPC surface for the popup-mediated webauthn flow. all endpoints follow the same shape as
 * `hw.ts` (`get*Request` / `resolve*` / `reject*`) so the popup-side bridge looks symmetric.
 *
 * orchestration helpers (`runPasskeyOnboarding`, `runPasskeyAddVault`) wrap enqueue + create
 * so the wallet ui can issue a single mutation to drive the whole "open popup, register, persist"
 * dance instead of choreographing it from react state.
 */
export const passkeyProcedures = {
  /** popup-side: fetch what the register popup should do (rpId / rpName / userName / prfSalt). */
  getPasskeyRegisterRequest: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(({ input }) => {
      const meta = getPendingPasskeyRegisterMeta(input.id);
      if (!meta) throw new Error(`No pending passkey register: ${input.id}`);
      return meta;
    }),

  /** popup-side: fetch what the sign popup should do (vaultId / credentialId / challenge). */
  getPasskeySignRequest: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(({ input }) => {
      const meta = getPendingPasskeySignMeta(input.id);
      if (!meta) throw new Error(`No pending passkey sign: ${input.id}`);
      return meta;
    }),

  /** popup-side: fetch what the recover popup should do (rpId / probe messages / prfSalt). */
  getPasskeyRecoverRequest: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(({ input }) => {
      const meta = getPendingPasskeyRecoverMeta(input.id);
      if (!meta) throw new Error(`No pending passkey recover: ${input.id}`);
      return meta;
    }),

  /** popup-side: post register artifacts back. unblocks the orchestrator promise in background. */
  resolvePasskeyRegister: publicProcedure
    .input(
      z.object({
        id: z.string(),
        credentialIdB64Url: z.string().min(1),
        publicKeyCompressedB64: z.string().min(1),
        prfSecretB64: z.string().min(1),
        rpId: z.string().min(1),
      }),
    )
    .mutation(({ input }) => {
      resolvePendingPasskeyRegister(input.id, {
        credentialIdB64Url: input.credentialIdB64Url,
        publicKeyCompressedB64: input.publicKeyCompressedB64,
        prfSecretB64: input.prfSecretB64,
        rpId: input.rpId,
      });
      return { ok: true as const };
    }),

  resolvePasskeySign: publicProcedure
    .input(
      z.object({
        id: z.string(),
        serializedSignatureB64: z.string().min(1),
        prfSecretB64: z.string().optional(),
      }),
    )
    .mutation(({ input }) => {
      resolvePendingPasskeySign(input.id, {
        serializedSignatureB64: input.serializedSignatureB64,
        prfSecretB64: input.prfSecretB64,
      });
      return { ok: true as const };
    }),

  resolvePasskeyRecover: publicProcedure
    .input(
      z.object({
        id: z.string(),
        credentialIdB64Url: z.string().min(1),
        publicKeyCompressedB64: z.string().min(1),
        prfSecretB64: z.string().min(1),
        rpId: z.string().min(1),
      }),
    )
    .mutation(({ input }) => {
      resolvePendingPasskeyRecover(input.id, {
        credentialIdB64Url: input.credentialIdB64Url,
        publicKeyCompressedB64: input.publicKeyCompressedB64,
        prfSecretB64: input.prfSecretB64,
        rpId: input.rpId,
      });
      return { ok: true as const };
    }),

  rejectPasskeyRegister: publicProcedure
    .input(z.object({ id: z.string(), reason: z.string() }))
    .mutation(({ input }) => {
      rejectPendingPasskeyRegister(input.id, input.reason);
      return { ok: true as const };
    }),

  rejectPasskeySign: publicProcedure
    .input(z.object({ id: z.string(), reason: z.string() }))
    .mutation(({ input }) => {
      rejectPendingPasskeySign(input.id, input.reason);
      return { ok: true as const };
    }),

  rejectPasskeyRecover: publicProcedure
    .input(z.object({ id: z.string(), reason: z.string() }))
    .mutation(({ input }) => {
      rejectPendingPasskeyRecover(input.id, input.reason);
      return { ok: true as const };
    }),

  /**
   * orchestrate: park a register request → open popup → wait for popup to resolve → call
   * `createPasskeyVault` with the password + collected artifacts. the wallet-setup ui issues a
   * single mutation and gets back the same `{ vaultId, suiAddress }` shape as the other
   * `createVault*` flows.
   *
   * `password` is required: chromatika's vault blob is still argon2id+aes-gcm encrypted under
   * the user's password (passkey provides the deterministic ika seed; the local blob still
   * needs an unlock secret in this slice). passkey-only unlock (no password) is a follow-up.
   */
  runPasskeyOnboarding: publicProcedure
    .input(
      z.object({
        // password optional, passkey-only bootstrap is the v1 happy path, password is a
        // belt-and-suspenders fallback envelope if the user wants one.
        password: z.string().min(8).optional(),
        rpId: z.string().min(1),
        rpName: z.string().min(1).optional(),
        userName: z.string().min(1).optional(),
        userDisplayName: z.string().min(1).optional(),
        label: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      // pre-flight: if a wallet blob already exists AND is locked AND the caller didn't pass a
      // password, fail BEFORE opening the webauthn popup, otherwise the user would tap face id
      // and then get a confusing "wallet exists" error after.
      const { walletExists, getLockState } = await import('@/background/wallet-service');
      if (await walletExists()) {
        const locked = !getLockState().unlocked;
        if (locked && !input.password) {
          throw new Error(
            'A chromatika wallet already exists on this device and is locked. Unlock it first '
            + '(password / passkey / waap / seeker, whichever method it has) and then add this passkey '
            + 'as a new vault from settings; or clear extension storage to start fresh with passkey-only.',
          );
        }
      }
      const prfSaltB64 = chromatikaPrfSaltB64();
      const artifacts = await enqueuePasskeyRegister({
        rpId: input.rpId,
        rpName: input.rpName ?? 'Chromatika',
        userName: input.userName ?? 'chromatika',
        userDisplayName: input.userDisplayName ?? 'Chromatika dWallet Vault',
        prfSaltB64,
      });
      const out = await createPasskeyVault(input.password, {
        credentialIdB64Url: artifacts.credentialIdB64Url,
        publicKeyCompressedB64: artifacts.publicKeyCompressedB64,
        prfSecretB64: artifacts.prfSecretB64,
        prfSaltB64,
        rpId: artifacts.rpId,
        label: input.label,
      });
      return out;
    }),

  /**
   * sibling-vault add path. password optional iff the wallet is currently unlocked (the in-session
   * credential decrypts the existing blob).
   */
  runPasskeyAddVault: publicProcedure
    .input(
      z.object({
        password: z.string().min(8).optional(),
        rpId: z.string().min(1),
        rpName: z.string().min(1).optional(),
        userName: z.string().min(1).optional(),
        userDisplayName: z.string().min(1).optional(),
        label: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const prfSaltB64 = chromatikaPrfSaltB64();
      const artifacts = await enqueuePasskeyRegister({
        rpId: input.rpId,
        rpName: input.rpName ?? 'Chromatika',
        userName: input.userName ?? 'chromatika',
        userDisplayName: input.userDisplayName ?? 'Chromatika dWallet Vault',
        prfSaltB64,
      });
      const out = await addPasskeyVault(input.password, {
        credentialIdB64Url: artifacts.credentialIdB64Url,
        publicKeyCompressedB64: artifacts.publicKeyCompressedB64,
        prfSecretB64: artifacts.prfSecretB64,
        prfSaltB64,
        rpId: artifacts.rpId,
        label: input.label,
      });
      return out;
    }),

  /** also expose the helpers so the popup can use them without round-tripping through `runPasskeyOnboarding`. */
  enqueuePasskeySign: publicProcedure
    .input(
      z.object({
        vaultId: z.string().min(1),
        credentialIdB64Url: z.string().min(1),
        rpId: z.string().min(1),
        publicKeyCompressedB64: z.string().min(1),
        challengeB64: z.string().min(1),
        kind: z.enum(['tx', 'personal', 'raw']),
        prfSaltB64: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const out = await enqueuePasskeySign({
        vaultId: input.vaultId,
        credentialIdB64Url: input.credentialIdB64Url,
        rpId: input.rpId,
        publicKeyCompressedB64: input.publicKeyCompressedB64,
        challengeB64: input.challengeB64,
        kind: input.kind,
        prfSaltB64: input.prfSaltB64,
      });
      return out;
    }),

  enqueuePasskeyRecover: publicProcedure
    .input(
      z.object({
        rpId: z.string().min(1),
        probeAB64: z.string().min(1),
        probeBB64: z.string().min(1),
        prfSaltB64: z.string().min(1),
      }),
    )
    .mutation(async ({ input }) => {
      const out = await enqueuePasskeyRecover({
        rpId: input.rpId,
        probeAB64: input.probeAB64,
        probeBB64: input.probeBB64,
        prfSaltB64: input.prfSaltB64,
      });
      return out;
    }),
};
