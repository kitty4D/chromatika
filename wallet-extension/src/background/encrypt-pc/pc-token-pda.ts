/**
 * PDA derivations for PC-Token + the Encrypt-program PDAs that get appended in the CPI bundle.
 * mirrors `_shared/encrypt-setup.ts` and the upstream pinocchio program seeds verbatim.
 *
 * pure functions. no chrome / network / session dependencies - testable as plain TS.
 */

import { PublicKey } from '@solana/web3.js';
import {
  ENCRYPT_PROGRAM_SEEDS,
  PC_TOKEN_SEEDS,
  getPcTokenProgramId,
  isPcTokenConfigured,
} from '@/background/encrypt-pc/pc-token-program';
import { PcTokenError } from '@/background/encrypt-pc/pc-token-types';
import { ENCRYPT_SOLANA_PROGRAM_ID } from '@/background/encrypt/encrypt-constants';

function resolvePcTokenProgramId(override?: PublicKey): PublicKey {
  if (override) return override;
  if (!isPcTokenConfigured()) {
    throw new PcTokenError(
      'not-configured',
      'No PC-Token market is configured. Add one in Settings → PC-Token markets after self-deploying the pinocchio variant. See wallet-extension/docs/PC_TOKEN.md.',
    );
  }
  return getPcTokenProgramId();
}

function encryptProgramId(): PublicKey {
  return new PublicKey(ENCRYPT_SOLANA_PROGRAM_ID);
}

/** PC-Token pcMint PDA: `["pc_mint", mintAuthority]`. */
export function derivePcMintPda(mintAuthority: PublicKey, programIdOverride?: PublicKey): { pda: PublicKey; bump: number } {
  const [pda, bump] = PublicKey.findProgramAddressSync(
    [new TextEncoder().encode(PC_TOKEN_SEEDS.mint), mintAuthority.toBytes()],
    resolvePcTokenProgramId(programIdOverride),
  );
  return { pda, bump };
}

/** PC-Token vault PDA: `["pc_vault", pcMint]`. */
export function derivePcVaultPda(pcMint: PublicKey, programIdOverride?: PublicKey): { pda: PublicKey; bump: number } {
  const [pda, bump] = PublicKey.findProgramAddressSync(
    [new TextEncoder().encode(PC_TOKEN_SEEDS.vault), pcMint.toBytes()],
    resolvePcTokenProgramId(programIdOverride),
  );
  return { pda, bump };
}

/**
 * PC-Token TokenAccount PDA: `["pc_account", mint, owner]`.
 *
 * **important**: seed order is **mint first, owner second**. the earlier draft of the chromatika
 * plan got this backwards; fixed here per the spike's reading of the upstream pinocchio source.
 */
export function derivePcAccountPda(
  mint: PublicKey,
  owner: PublicKey,
  programIdOverride?: PublicKey,
): { pda: PublicKey; bump: number } {
  const [pda, bump] = PublicKey.findProgramAddressSync(
    [new TextEncoder().encode(PC_TOKEN_SEEDS.account), mint.toBytes(), owner.toBytes()],
    resolvePcTokenProgramId(programIdOverride),
  );
  return { pda, bump };
}

/** PC-Token receipt PDA: `["pc_receipt", burnedCt]`. */
export function derivePcReceiptPda(burnedCt: PublicKey, programIdOverride?: PublicKey): { pda: PublicKey; bump: number } {
  const [pda, bump] = PublicKey.findProgramAddressSync(
    [new TextEncoder().encode(PC_TOKEN_SEEDS.receipt), burnedCt.toBytes()],
    resolvePcTokenProgramId(programIdOverride),
  );
  return { pda, bump };
}

/** PC-Token program's CPI authority PDA: `["__encrypt_cpi_authority"]`. */
export function derivePcTokenCpiAuthority(programIdOverride?: PublicKey): { pda: PublicKey; bump: number } {
  const [pda, bump] = PublicKey.findProgramAddressSync(
    [new TextEncoder().encode(PC_TOKEN_SEEDS.cpiAuthority)],
    resolvePcTokenProgramId(programIdOverride),
  );
  return { pda, bump };
}

/** Encrypt config PDA: `["encrypt_config"]`. lives on the Encrypt program. */
export function deriveEncryptConfigPda(): { pda: PublicKey; bump: number } {
  const [pda, bump] = PublicKey.findProgramAddressSync(
    [new TextEncoder().encode(ENCRYPT_PROGRAM_SEEDS.config)],
    encryptProgramId(),
  );
  return { pda, bump };
}

/** Encrypt deposit PDA: `["encrypt_deposit", payer]`. per-payer ENC deposit account. */
export function deriveEncryptDepositPda(payer: PublicKey): { pda: PublicKey; bump: number } {
  const [pda, bump] = PublicKey.findProgramAddressSync(
    [new TextEncoder().encode(ENCRYPT_PROGRAM_SEEDS.deposit), payer.toBytes()],
    encryptProgramId(),
  );
  return { pda, bump };
}

/** Encrypt network-key PDA: `["network_encryption_key", networkKey32]`. */
export function deriveEncryptNetworkKeyPda(networkKey32: Uint8Array): {
  pda: PublicKey;
  bump: number;
} {
  if (networkKey32.length !== 32) {
    throw new Error(`network key must be 32 bytes, got ${networkKey32.length}`);
  }
  const [pda, bump] = PublicKey.findProgramAddressSync(
    [new TextEncoder().encode(ENCRYPT_PROGRAM_SEEDS.networkKey), networkKey32],
    encryptProgramId(),
  );
  return { pda, bump };
}

/** Encrypt event-authority PDA: `["__event_authority"]`. */
export function deriveEncryptEventAuthorityPda(): { pda: PublicKey; bump: number } {
  const [pda, bump] = PublicKey.findProgramAddressSync(
    [new TextEncoder().encode(ENCRYPT_PROGRAM_SEEDS.eventAuthority)],
    encryptProgramId(),
  );
  return { pda, bump };
}
