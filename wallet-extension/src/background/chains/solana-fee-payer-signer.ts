/**
 * resolves the **dWallet Vault's fee-payer signer** for Solana - the local ed25519 keypair
 * stored on the vault record (HD: derived from mnemonic at `m/44'/501'/0'/0'`, lazor:
 * `lazorIkaFeePayerSolSecretKeyB64`, hardware-MWA/WC with local fee key:
 * `ikaGrpcFeePayerSolSecretKeyB64`). this is the address shown as "Solana devnet fee payer
 * (ika pre-alpha)" on the VaultBaseCard, distinct from any MPC dWallet's Solana address.
 *
 * use this for user-initiated wallet UI sends (Send tab to vault fee-payer). dWallet-derived
 * sends still go through `signMessageSol` / ika MPC, do not collapse the two paths.
 */

import type { Connection, Keypair } from '@solana/web3.js';
import { getSession } from '@/background/session';

export type VaultFeePayerSession = {
  payer: Keypair;
  /** connection registered alongside the fee-payer (devnet for ika pre-alpha). */
  connection: Connection;
};

/**
 * returns `{ payer, connection }` when the active vault has a local Solana fee-payer
 * keypair. throws a user-facing message when:
 *   - wallet is locked,
 *   - the active vault is not Solana-base (no `solanaConnection`),
 *   - the fee-payer is hardware-only (Ledger/MWA/WC), signing those needs the existing
 *     hardware sign popup, not this path.
 */
export function requireVaultFeePayerSession(): VaultFeePayerSession {
  const s = getSession();
  if (!s) throw new Error('Wallet locked');
  if (!s.solanaConnection) {
    throw new Error(
      'Active vault is not configured for Solana. Switch to a Solana-base dWallet Vault to send from its fee-payer.',
    );
  }
  if (!s.solanaFeePayer) {
    if (s.solanaLedgerFee || s.solanaMwaAccount || s.solanaWcAccount) {
      throw new Error(
        "This vault's Solana fee-payer is on a hardware wallet (Ledger / phone). Sweeping its assets from the wallet UI is not supported yet — sign with your hardware wallet directly to recover funds at this address.",
      );
    }
    throw new Error('No Solana fee-payer keypair available on the active vault.');
  }
  return { payer: s.solanaFeePayer, connection: s.solanaConnection };
}
