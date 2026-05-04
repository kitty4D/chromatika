/**
 * shared builder for x402 Solana exact-scheme transactions.
 *
 * two signing paths consume this:
 *   - `x402-solana-signer.ts`: signs via ika MPC (`signMessageSol`); the dWallet's address
 *     is the one paying USDC.
 *   - `x402-walletconnect-signer.ts`: signs via WalletConnect (Seeker / Phantom / Solflare);
 *     the WC-paired address is the one paying USDC. bypasses ika entirely.
 *
 * spec: `github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_svm.md`.
 *
 * the output is the unsigned `VersionedTransaction` (with feePayer = facilitator + an SPL
 * transfer + a Memo v2 instruction) plus the message bytes the owner must sign. each path
 * fills in the owner's signature differently; serialization happens at the call site since
 * the signing primitive returns its sig in different shapes across the two paths.
 */

import {
  Connection,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { getSession } from '@/background/session';
import {
  X402_SOLANA_USDC_MINT_MAINNET,
  isSolanaCaip2,
  type PaymentRequirements,
} from './x402-types';

/** SPL Token classic program. Token-2022 (TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb) not supported in v1. */
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
/** Associated Token Account program. */
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
/** Memo v2 program (current standard). */
const MEMO_V2_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

const SPL_TRANSFER_DISCRIMINATOR = 3;

export function deriveAta(owner: PublicKey, mint: PublicKey): PublicKey {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return ata;
}

export function splTransferInstruction(args: {
  source: PublicKey;
  destination: PublicKey;
  owner: PublicKey;
  amount: bigint;
}): TransactionInstruction {
  // Data: [u8 discriminator | u64 amount little-endian] = 9 bytes total.
  const data = Buffer.alloc(9);
  data.writeUInt8(SPL_TRANSFER_DISCRIMINATOR, 0);
  data.writeBigUInt64LE(args.amount, 1);
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: args.source, isSigner: false, isWritable: true },
      { pubkey: args.destination, isSigner: false, isWritable: true },
      { pubkey: args.owner, isSigner: true, isWritable: false },
    ],
    data,
  });
}

export function memoInstruction(text: string): TransactionInstruction {
  return new TransactionInstruction({
    programId: MEMO_V2_PROGRAM_ID,
    keys: [],
    data: Buffer.from(text, 'utf8'),
  });
}

/** ≥16 bytes of randomness, hex-encoded, per the spec. */
export function randomNonceHex(byteLen = 16): string {
  if (byteLen < 16) throw new Error('nonce length must be >= 16 bytes per scheme_exact_svm spec');
  const bytes = new Uint8Array(byteLen);
  crypto.getRandomValues(bytes);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return hex;
}

function decimalStringToBigint(value: string, field: string): bigint {
  const t = value.trim();
  if (!/^\d+$/.test(t)) {
    throw new Error(`${field} must be a non-negative decimal integer string; got '${value}'`);
  }
  return BigInt(t);
}

function readFeePayerFromExtra(extra: unknown): string {
  if (!extra || typeof extra !== 'object') {
    throw new Error('PaymentRequirements.extra is missing; cannot read facilitator feePayer');
  }
  const obj = extra as Record<string, unknown>;
  const fp = obj.feePayer;
  if (typeof fp !== 'string' || fp.length === 0) {
    throw new Error('PaymentRequirements.extra.feePayer is missing or not a string');
  }
  return fp;
}

function readOptionalMemoFromExtra(extra: unknown): string | null {
  if (!extra || typeof extra !== 'object') return null;
  const obj = extra as Record<string, unknown>;
  const memo = obj.memo;
  return typeof memo === 'string' && memo.length > 0 ? memo : null;
}

export function bufferToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export type X402SolanaBuildResult = {
  /** the unsigned versioned tx (feePayer=facilitator slot still empty, owner slot still empty). */
  vtx: VersionedTransaction;
  /** owner pubkey that must produce the ed25519 signature this builder leaves blank. */
  ownerPubkey: PublicKey;
  /** message bytes that must be signed (vtx.message.serialize()) - cached so the signer can pass the same blob to its primitive without recomputing. */
  messageBytes: Uint8Array;
  /** facilitator pubkey from extra.feePayer (string echoed back for receipt records). */
  feePayerStr: string;
  /** memo / nonce string placed in the Memo v2 instruction. */
  memoText: string;
  /** ATA used for the source side; surfaced for receipts + UI display. */
  sourceAta: string;
  /** ATA used for the destination side; surfaced for receipts + UI display. */
  destAta: string;
};

export type X402SolanaBuildArgs = {
  requirements: PaymentRequirements;
  /** Owner pubkey - dWallet-derived for the ika path, WC-account for the WC path. */
  owner: PublicKey;
};

/**
 * Validate + assemble the unsigned Solana versioned tx. Throws on every spec violation; the
 * call sites get a fully-checked vtx + the bytes they need to sign.
 */
export async function buildX402VersionedTx(args: X402SolanaBuildArgs): Promise<X402SolanaBuildResult> {
  const { requirements, owner } = args;

  if (!isSolanaCaip2(requirements.network)) {
    throw new Error(`x402 Solana builder cannot build for network '${requirements.network}'`);
  }
  if (requirements.scheme !== 'exact') {
    throw new Error(`x402 Solana builder only supports 'exact' scheme; got '${requirements.scheme}'`);
  }
  if (requirements.asset !== X402_SOLANA_USDC_MINT_MAINNET) {
    // x402-types validation also catches this upstream; keep the assert here so future
    // direct callers of the builder can't bypass.
    throw new Error(`x402 v1 only supports USDC; got asset '${requirements.asset}'`);
  }

  const session = getSession();
  if (!session) throw new Error('Wallet locked');
  const connection: Connection | undefined =
    session.dwalletSolanaConnection ?? session.solanaConnection;
  if (!connection) throw new Error('Solana RPC connection not configured for this vault');

  const mintPubkey = new PublicKey(requirements.asset);
  const payToPubkey = new PublicKey(requirements.payTo);
  const feePayerStr = readFeePayerFromExtra(requirements.extra);
  const feePayerPubkey = new PublicKey(feePayerStr);
  const amount = decimalStringToBigint(requirements.maxAmountRequired, 'maxAmountRequired');

  const sourceAta = deriveAta(owner, mintPubkey);
  const destAta = deriveAta(payToPubkey, mintPubkey);

  const memoText = readOptionalMemoFromExtra(requirements.extra) ?? randomNonceHex(16);

  const instructions: TransactionInstruction[] = [
    splTransferInstruction({
      source: sourceAta,
      destination: destAta,
      owner,
      amount,
    }),
    memoInstruction(memoText),
  ];

  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const v0Message = new TransactionMessage({
    payerKey: feePayerPubkey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();
  const vtx = new VersionedTransaction(v0Message);

  // sanity: confirm the owner is a required signer in the compiled message before any signer
  // burns a presign / asks the user to tap.
  const requiredSigners = v0Message.staticAccountKeys.slice(0, v0Message.header.numRequiredSignatures);
  const ownerInRequiredSlots = requiredSigners.some((pk) => pk.equals(owner));
  if (!ownerInRequiredSlots) {
    throw new Error(
      'compiled x402 tx does not list the owner as a required signer - SPL transfer instruction may be malformed',
    );
  }

  return {
    vtx,
    ownerPubkey: owner,
    messageBytes: vtx.message.serialize(),
    feePayerStr,
    memoText,
    sourceAta: sourceAta.toBase58(),
    destAta: destAta.toBase58(),
  };
}
