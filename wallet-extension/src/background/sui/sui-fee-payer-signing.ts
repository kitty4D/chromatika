import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import type { SessionState } from '@/background/session';

/**
 * Sui PTB fee payer used for dry-run sender, signAndExecute, and balance error hints.
 * uses Ledger popup signing when `session.suiLedgerFee` is set; otherwise local `session.suiKeypair`.
 */
export type SuiFeePayerSigningContext = {
  signer: Ed25519Keypair;
  feePayerAddress: string;
};

/** canonical fee-payer Sui address (Ledger path uses `suiLedgerFee.feePayerAddress`). */
export function getSuiFeePayerSuiAddress(session: SessionState): string {
  return session.suiLedgerFee?.feePayerAddress ?? session.suiKeypair.toSuiAddress();
}

export function getSuiFeePayerSigningContext(session: SessionState): SuiFeePayerSigningContext {
  const signer = session.suiKeypair;
  return {
    signer,
    feePayerAddress: getSuiFeePayerSuiAddress(session),
  };
}
