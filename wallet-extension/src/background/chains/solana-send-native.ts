/**
 * native SOL transfer from the **dWallet Vault's fee-payer address**, the local ed25519
 * keypair held on the session (`s.solanaFeePayer`). this is the address shown on the
 * VaultBaseCard ("Solana devnet fee payer (ika pre-alpha)"), NOT the MPC dWallet's address.
 *
 * dWallet-address sends still need to go through ika MPC (signMessageSol), this path is
 * specifically for sweeping / spending assets sitting at the vault fee-payer address.
 */

import { PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { confirmSolanaTxByPolling } from '@/background/chains/solana-confirm';
import { requireVaultFeePayerSession } from '@/background/chains/solana-fee-payer-signer';

/** parse decimal SOL string to lamports (bigint). */
export function parseDecimalSolToLamports(amount: string): bigint {
  const t = amount.trim();
  if (!t || t === '.') return 0n;
  const neg = t.startsWith('-');
  const u = neg ? t.slice(1) : t;
  const [wholeRaw, fracRaw = ''] = u.split('.');
  const whole = wholeRaw.replace(/^0+/, '') || '0';
  const frac = (fracRaw + '000000000').slice(0, 9);
  const lamports = BigInt(whole) * 1_000_000_000n + BigInt(frac);
  return neg ? -lamports : lamports;
}

/**
 * broadcast a native SOL transfer signed locally with the vault fee-payer keypair on the
 * fee-payer's network. returns Solana transaction signature (base58).
 */
export async function sendSolanaNativeTransfer(to: string, lamports: bigint): Promise<string> {
  if (lamports <= 0n) throw new Error('Amount must be positive');

  const { payer, connection } = requireVaultFeePayerSession();
  const fromPubkey = payer.publicKey;
  const toPubkey = new PublicKey(to.trim());

  const { blockhash } = await connection.getLatestBlockhash('confirmed');

  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey,
      toPubkey,
      lamports,
    }),
  );
  tx.recentBlockhash = blockhash;
  tx.feePayer = fromPubkey;
  tx.sign(payer);

  const raw = tx.serialize();
  const sig = await connection.sendRawTransaction(raw, {
    skipPreflight: false,
    maxRetries: 3,
  });

  await confirmSolanaTxByPolling(connection, sig, { commitment: 'confirmed' });

  await recordSolanaSendForOriginTracking(sig);
  return sig;
}

/**
 * persist a `sol-send` tx-record so the activity feed picks up the wallet-ui send (origin = null,
 * wallet-ui-initiated, not dapp-initiated). failure to record never propagates, the broadcast
 * has already succeeded by this point and storage hiccups shouldn't look like failed sends.
 */
async function recordSolanaSendForOriginTracking(signature: string): Promise<void> {
  try {
    const { getSession } = await import('@/background/session');
    const { recordSignedTx } = await import('@/background/services/tx-record');
    const session = getSession();
    if (!session?.activeVaultId) return;
    await recordSignedTx({
      txHash: signature,
      origin: null,
      chainId: 'sol-devnet',
      vaultId: session.activeVaultId,
      timestampMs: Date.now(),
      kind: 'sol-send',
    });
  } catch (e) {
    console.warn('[chromatika tx-record] sol-send origin record failed', e);
  }
}
