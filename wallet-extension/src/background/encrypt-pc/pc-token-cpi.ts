/**
 * the 9-account suffix appended to every PC-Token instruction that runs an FHE op
 * (InitializeAccount, Transfer, Wrap, UnwrapBurn, UnwrapDecrypt). order is positional and
 * matters - the program reads them by index.
 *
 * mirrors `_shared/encrypt-setup.ts:encryptCpiAccounts(...)` in the upstream encrypt-pre-alpha
 * repo. see `wallet-extension/docs/PC_TOKEN_SPIKE.md` section 3.0 for the full table.
 */

import { type AccountMeta, PublicKey, SystemProgram } from '@solana/web3.js';
import {
  getPcTokenProgramId,
  isPcTokenConfigured,
} from '@/background/encrypt-pc/pc-token-program';
import { ENCRYPT_SOLANA_PROGRAM_ID } from '@/background/encrypt/encrypt-constants';
import {
  derivePcTokenCpiAuthority,
  deriveEncryptConfigPda,
  deriveEncryptDepositPda,
  deriveEncryptEventAuthorityPda,
  deriveEncryptNetworkKeyPda,
} from '@/background/encrypt-pc/pc-token-pda';
import { PcTokenError } from '@/background/encrypt-pc/pc-token-types';

export interface EncryptCpiSuffix {
  /** ordered metas to append after the per-ix accounts. */
  metas: AccountMeta[];
  /**
   * the 8-byte LE bump bundle the per-ix data layout often references (e.g. `[disc=1, accountBump, cpiBump]`).
   * returned alongside so callers don't have to re-derive.
   */
  cpiAuthorityBump: number;
}

/**
 * build the 9-account CPI suffix.
 *
 * @param payer the user signing the transaction. almost always the active dWallet ed25519 address.
 * @param networkKey32 the 32-byte Encrypt network public key. in v0 we resolve this once via the
 *   existing `resolveNetworkEncryptionPublicKey` helper from `encrypt-lab-service.ts` and pass it
 *   in - same value for every PC-Token call in a given session.
 * @param overrides per-ix tweaks. UnwrapDecrypt flips `configPda` to non-writable.
 */
export function buildEncryptCpiSuffix(
  payer: PublicKey,
  networkKey32: Uint8Array,
  overrides?: { configPdaWritable?: boolean },
): EncryptCpiSuffix {
  if (!isPcTokenConfigured()) {
    throw new PcTokenError(
      'not-configured',
      'cannot build CPI suffix until the PC-Token program ID is configured',
    );
  }
  const encryptProgram = new PublicKey(ENCRYPT_SOLANA_PROGRAM_ID);
  const callerProgram = getPcTokenProgramId();

  const { pda: configPda } = deriveEncryptConfigPda();
  const { pda: depositPda } = deriveEncryptDepositPda(payer);
  const { pda: cpiAuthority, bump: cpiAuthorityBump } = derivePcTokenCpiAuthority();
  const { pda: networkKeyPda } = deriveEncryptNetworkKeyPda(networkKey32);
  const { pda: eventAuthority } = deriveEncryptEventAuthorityPda();

  const configWritable = overrides?.configPdaWritable ?? true;

  const metas: AccountMeta[] = [
    { pubkey: encryptProgram, isSigner: false, isWritable: false },
    { pubkey: configPda, isSigner: false, isWritable: configWritable },
    { pubkey: depositPda, isSigner: false, isWritable: true },
    { pubkey: cpiAuthority, isSigner: false, isWritable: false },
    { pubkey: callerProgram, isSigner: false, isWritable: false },
    { pubkey: networkKeyPda, isSigner: false, isWritable: false },
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: eventAuthority, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];

  return { metas, cpiAuthorityBump };
}
