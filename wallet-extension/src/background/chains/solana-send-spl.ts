/**
 * SPL token transfer from the **dWallet Vault's fee-payer address**, the local ed25519
 * keypair on the session, NOT an MPC dWallet. builds a two-instruction tx:
 *   1. CreateAssociatedTokenAccountIdempotent: opens the recipient's ATA if missing
 *      (no-op when it already exists, so we skip the preflight lookup).
 *   2. SPL Token Transfer: moves `amountRaw` (mint base units) from sender ATA to dest ATA.
 *
 * no ika MPC. classic SPL Token only, Token-2022 is a separate program id and not handled
 * here. we intentionally avoid `@solana/spl-token` (already a non-dep per `pc-token-spl-ata.ts`),
 * the instruction layouts are tiny and stable.
 */

import {
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import { confirmSolanaTxByPolling } from '@/background/chains/solana-confirm';
import { requireVaultFeePayerSession } from '@/background/chains/solana-fee-payer-signer';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  SPL_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from '@/background/encrypt-pc/pc-token-spl-ata';

/** parse decimal "1.234" to base units given mint decimals. */
export function parseDecimalSplToBaseUnits(amount: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new Error(`Invalid decimals: ${decimals}`);
  }
  const t = amount.trim();
  if (!t || t === '.') return 0n;
  const neg = t.startsWith('-');
  const u = neg ? t.slice(1) : t;
  const [wholeRaw, fracRaw = ''] = u.split('.');
  const whole = wholeRaw.replace(/^0+/, '') || '0';
  const fracPadded = (fracRaw + '0'.repeat(decimals)).slice(0, decimals);
  const base = BigInt(whole) * 10n ** BigInt(decimals) + (decimals > 0 ? BigInt(fracPadded) : 0n);
  return neg ? -base : base;
}

/** ATA program: CreateIdempotent (instruction discriminator 1). no-op when account already exists. */
function createAssociatedTokenAccountIdempotentIx(
  funder: PublicKey,
  ata: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: funder, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SPL_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
}

/** SPL Token program: Transfer (instruction discriminator 3). plain transfer (not TransferChecked). */
function splTransferIx(
  source: PublicKey,
  dest: PublicKey,
  authority: PublicKey,
  amountRaw: bigint,
): TransactionInstruction {
  if (amountRaw < 0n || amountRaw > 0xffffffffffffffffn) {
    throw new Error('SPL transfer amount out of u64 range');
  }
  const data = Buffer.alloc(9);
  data.writeUInt8(3, 0);
  data.writeBigUInt64LE(amountRaw, 1);
  return new TransactionInstruction({
    programId: SPL_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: dest, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data,
  });
}

/**
 * send `amountRaw` (mint base units, NOT decimal) of `mint` to `to` from the vault
 * fee-payer address. auto-creates the recipient's ATA via CreateIdempotent so first-time
 * recipients work. returns Solana sig (base58).
 */
export async function sendSolanaSplTransfer(
  to: string,
  mint: string,
  amountRaw: bigint,
): Promise<string> {
  if (amountRaw <= 0n) throw new Error('Amount must be positive');

  const { payer, connection } = requireVaultFeePayerSession();
  const fromPubkey = payer.publicKey;
  const toPubkey = new PublicKey(to.trim());
  const mintPubkey = new PublicKey(mint.trim());

  const sourceAta = getAssociatedTokenAddressSync(mintPubkey, fromPubkey);
  // dest may be a system account today (no ATA yet), CreateIdempotent handles that.
  // if `to` is itself off-curve (a PDA), the user needs a wallet that supports that flow, we
  // assume a normal wallet address.
  const destAta = getAssociatedTokenAddressSync(mintPubkey, toPubkey);

  const { blockhash } = await connection.getLatestBlockhash('confirmed');

  const tx = new Transaction()
    .add(createAssociatedTokenAccountIdempotentIx(fromPubkey, destAta, toPubkey, mintPubkey))
    .add(splTransferIx(sourceAta, destAta, fromPubkey, amountRaw));
  tx.recentBlockhash = blockhash;
  tx.feePayer = fromPubkey;
  tx.sign(payer);

  const raw = tx.serialize();
  const sig = await connection.sendRawTransaction(raw, {
    skipPreflight: false,
    maxRetries: 3,
  });

  await confirmSolanaTxByPolling(connection, sig, { commitment: 'confirmed' });

  // record wallet-ui-initiated SPL send into chromatika_signed_txs_v1 (origin null = no dapp).
  try {
    const { getSession } = await import('@/background/session');
    const { recordSignedTx } = await import('@/background/services/tx-record');
    const session = getSession();
    if (session?.activeVaultId) {
      await recordSignedTx({
        txHash: sig,
        origin: null,
        chainId: 'sol-devnet',
        vaultId: session.activeVaultId,
        timestampMs: Date.now(),
        kind: 'sol-send',
      });
    }
  } catch (e) {
    console.warn('[chromatika tx-record] sol-send (spl) origin record failed', e);
  }

  return sig;
}
