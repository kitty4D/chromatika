/**
 * ENC / SPL deposit path notes (Solana Encrypt only). on-chain builders land incrementally; see Encrypt instruction reference.
 */

import { assertEncryptSolanaIkaBase } from '@/background/encrypt/encrypt-guard';

export type SplEncDepositPathNotes = {
  userFundedV1: string;
  minimalAtaTopUp: string;
  instructionReferenceUrl: string;
};

export function getSplEncDepositPathNotes(): SplEncDepositPathNotes {
  assertEncryptSolanaIkaBase();
  return {
    userFundedV1:
      'v1 user-funded: acquire ENC on devnet yourself, ensure ATA exists, then attach create_deposit + execute_graph per Encrypt book examples.',
    minimalAtaTopUp:
      'minimal path target: create missing ATA, small ENC transfer-in, optional SOL top_up when the program pricing expects it (see create_deposit / top_up in the instruction reference).',
    instructionReferenceUrl: 'https://docs.encrypt.xyz/reference/instructions.html',
  };
}
