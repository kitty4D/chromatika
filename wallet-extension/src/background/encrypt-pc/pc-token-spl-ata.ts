/**
 * inline associated-token-account derivation. chromatika doesn't depend on `@solana/spl-token`
 * (the bundle would grow noticeably for one helper); instead we derive the ATA directly. this
 * matches `getAssociatedTokenAddressSync` from spl-token byte-for-byte.
 *
 * ATA PDA seeds: `[owner, tokenProgram, mint]` on the associated-token-account program.
 *
 * reference: https://spl.solana.com/associated-token-account
 */

import { PublicKey } from '@solana/web3.js';

/** standard SPL Token program (classic, not Token-2022). */
export const SPL_TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

/** standard Associated Token Account program. */
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

/**
 * derive the associated token account for `owner` + `mint`. set `allowOwnerOffCurve = true` to
 * derive an ATA whose owner is itself a PDA (e.g. our `vaultPda` holds the vault's USDC ATA).
 */
export function getAssociatedTokenAddressSync(
  mint: PublicKey,
  owner: PublicKey,
  allowOwnerOffCurve = false,
): PublicKey {
  if (!allowOwnerOffCurve && !PublicKey.isOnCurve(owner.toBytes())) {
    throw new Error('owner is off-curve - pass allowOwnerOffCurve=true if intended');
  }
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBytes(), SPL_TOKEN_PROGRAM_ID.toBytes(), mint.toBytes()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return ata;
}
