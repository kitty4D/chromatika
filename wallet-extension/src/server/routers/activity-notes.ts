/**
 * activity-notes tRPC router. user attaches an encrypted note ("paid alice for rent") to a tx
 * row in the activity feed. the note is encrypted via the active EncryptionBackend (encrypt.xyz
 * by default, self-recipient) and persisted alongside the signed-tx record.
 *
 * procedures:
 *   - encryptActivityNote: attach an encrypted note to an existing signed-tx record.
 *   - decryptActivityNote: reveal the note (requires vault unlock + dWallet ed25519 ReadCiphertext).
 *   - removeActivityNote: clear the encrypted note from a record.
 *   - getActivityNoteStatus: lightweight read, "is there a note here?" without triggering decrypt.
 *
 * notes can only be attached to txs that chromatika itself signed (so a record exists in the
 * tx-record store). the UI scopes the "+ note" affordance via `ActivityItem.signedByThisWallet`.
 *
 * pre-alpha disclaimer: encrypt.xyz pre-alpha ciphertexts may be plaintext on-chain. every UI
 * surface that uses this router MUST show a "encrypt.xyz pre-alpha - dev preview" badge per
 * CLAUDE.md identity-model rules. see `wallet-extension/docs/ENCRYPTION_BACKEND.md`.
 */

import { z } from 'zod';
import { publicProcedure } from '../trpc';
import { getSession } from '@/background/session';
import {
  getSignedTxByHash,
  updateSignedTxNote,
} from '@/background/services/tx-record';
import { getEncryptionBackend, decryptRefViaRegistry } from '@/background/encryption';
import { EncryptionBackendError } from '@/background/encryption/types';

const MAX_NOTE_UTF8_BYTES = 2048;

function requireActiveVaultId(): string {
  const s = getSession();
  if (!s?.activeVaultId) {
    throw new Error('Wallet locked - unlock to manage activity notes');
  }
  return s.activeVaultId;
}

export const activityNotesProcedures = {
  encryptActivityNote: publicProcedure
    .input(
      z.object({
        txHash: z.string().min(1),
        plaintext: z.string().min(1).max(MAX_NOTE_UTF8_BYTES),
      }),
    )
    .mutation(async ({ input }) => {
      const vaultId = requireActiveVaultId();
      const rec = await getSignedTxByHash(input.txHash, vaultId);
      if (!rec) {
        throw new Error(
          `no signed-tx record for ${input.txHash} in this vault. Notes can only be attached to txs chromatika signed (records are created automatically on broadcast).`,
        );
      }
      const plaintextBytes = new TextEncoder().encode(input.plaintext);
      if (plaintextBytes.length > MAX_NOTE_UTF8_BYTES) {
        throw new Error(`note utf-8 length ${plaintextBytes.length} exceeds cap ${MAX_NOTE_UTF8_BYTES}`);
      }
      const backend = getEncryptionBackend('self-recipient-default');
      const ref = await backend.encryptForRecipient(plaintextBytes, { kind: 'self' });
      await updateSignedTxNote(input.txHash, vaultId, ref);
      return {
        ok: true as const,
        backend: ref.backend,
        createdAtMs: ref.createdAtMs,
      };
    }),

  decryptActivityNote: publicProcedure
    .input(z.object({ txHash: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const vaultId = requireActiveVaultId();
      const rec = await getSignedTxByHash(input.txHash, vaultId);
      if (!rec) {
        throw new Error(`no signed-tx record for ${input.txHash} in this vault`);
      }
      if (!rec.encryptedNote) {
        return { plaintext: null as string | null, status: 'none' as const };
      }
      try {
        const plainBytes = await decryptRefViaRegistry(rec.encryptedNote);
        const plaintext = new TextDecoder().decode(plainBytes);
        return { plaintext, status: 'ok' as const };
      } catch (e) {
        if (e instanceof EncryptionBackendError) {
          // surface the structured error so the UI can render the right copy without string
          // matching: "wrong vault" -> switch-vault hint, "devnet wipe" -> re-encrypt prompt, etc.
          return {
            plaintext: null,
            status: 'error' as const,
            errorReason: e.reason,
            errorMessage: e.message,
          };
        }
        throw e;
      }
    }),

  removeActivityNote: publicProcedure
    .input(z.object({ txHash: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const vaultId = requireActiveVaultId();
      const rec = await getSignedTxByHash(input.txHash, vaultId);
      if (!rec) {
        // if the record is gone we have nothing to clear; treat as a no-op so the UI doesn't
        // spam errors after the user closed and reopened the modal mid-edit.
        return { ok: true as const, removed: false as const };
      }
      if (!rec.encryptedNote) {
        return { ok: true as const, removed: false as const };
      }
      await updateSignedTxNote(input.txHash, vaultId, undefined);
      return { ok: true as const, removed: true as const };
    }),

  getActivityNoteStatus: publicProcedure
    .input(z.object({ txHash: z.string().min(1) }))
    .query(async ({ input }) => {
      const vaultId = requireActiveVaultId();
      const rec = await getSignedTxByHash(input.txHash, vaultId);
      if (!rec) {
        return { hasRecord: false as const, hasNote: false as const };
      }
      return {
        hasRecord: true as const,
        hasNote: Boolean(rec.encryptedNote),
        backend: rec.encryptedNote?.backend ?? null,
        createdAtMs: rec.encryptedNote?.createdAtMs ?? null,
        origin: rec.origin,
        kind: rec.kind,
      };
    }),
};
