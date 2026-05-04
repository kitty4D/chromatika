/**
 * `approve_message` (disc 8) on ika Solana dWallet program, direct signer path (0.1.1).
 * @see skills/ika-solana-prealpha/references/instructions.md
 *
 * 0.1.1 changes:
 *  - ix data is 100 bytes: disc(1) + bump(1) + msg_digest(32) + metadata_digest(32) +
 *    user_pubkey(32) + signature_scheme u16 LE(2).
 *  - accounts use 6-meta direct signer path: coordinator, message_approval, dwallet,
 *    authority, payer, system_program.
 *  - DWallet PDA = `["dwallet", ...chunks_of_32(curve_u16_le || public_key)]`.
 *  - MessageApproval PDA = `["dwallet", ...chunks..., "message_approval",
 *    &scheme_u16_le, &message_digest, [&metadata_digest]]`, the metadata seed is
 *    only included when metadata_digest is non-zero.
 */

import { keccak_256 } from '@noble/hashes/sha3.js';
import { Connection, PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';
import { base58 } from '@scure/base';
import { confirmSolanaTxByPolling } from '@/background/chains/solana-confirm';
import {
  SOLANA_PREALPHA_PROGRAM_ID,
  deriveSolanaDWalletPda,
  type SolanaDkgCurve,
} from '@/background/ika/solana-grpc-client';

const PROGRAM_ID = new PublicKey(SOLANA_PREALPHA_PROGRAM_ID);

/**
 * `DWalletSignatureScheme` u16 values (per skill `events.md` / `account-layouts.md`).
 * validators read this from the on-chain MessageApproval account to pick the hash scheme.
 */
export enum DWalletSignatureScheme {
  EcdsaKeccak256 = 0,
  EcdsaSha256 = 1,
  EcdsaDoubleSha256 = 2,
  TaprootSha256 = 3,
  EcdsaBlake2b256 = 4,
  EddsaSha512 = 5,
  SchnorrkelMerlin = 6,
}

const COORDINATOR_PDA: PublicKey = PublicKey.findProgramAddressSync(
  [Buffer.from('dwallet_coordinator')],
  PROGRAM_ID,
)[0];

/** split `(curve_u16_le || public_key)` into 32-byte chunks for PDA seeds. */
function dwalletSeedChunks(curve: SolanaDkgCurve, publicKey: Uint8Array): Buffer[] {
  const curveU16 = curve === 'Secp256k1' ? 0 : 2;
  const payload = new Uint8Array(2 + publicKey.length);
  payload[0] = curveU16 & 0xff;
  payload[1] = (curveU16 >> 8) & 0xff;
  payload.set(publicKey, 2);
  const chunks: Buffer[] = [];
  for (let i = 0; i < payload.length; i += 32) {
    chunks.push(Buffer.from(payload.subarray(i, Math.min(i + 32, payload.length))));
  }
  return chunks;
}

function schemeLeBytes(scheme: DWalletSignatureScheme): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(scheme, 0);
  return b;
}

function isZero32(bytes: Uint8Array): boolean {
  for (let i = 0; i < bytes.length; i++) if (bytes[i] !== 0) return false;
  return true;
}

/**
 * build + send the `approve_message` ix on the ika Solana dWallet program.
 *
 * caller supplies:
 * - `curve` + `dwalletPublicKey`: required to derive the DWallet PDA and the
 *   MessageApproval PDA seeds (both use `chunks_of_32(curve_u16_le || pk)`).
 * - `signatureScheme`: full `DWalletSignatureScheme` u16.
 * - `messageMetadata`: optional; when non-empty its keccak digest is included in
 *   both the ix data and the PDA seeds.
 */
export async function sendApproveMessageForSign(
  connection: Connection,
  feePayerPubkey: PublicKey,
  args: {
    curve: SolanaDkgCurve;
    dwalletPublicKey: Uint8Array;
    message: Uint8Array;
    signatureScheme: DWalletSignatureScheme;
    messageMetadata?: Uint8Array;
  },
  signAndSendLegacyTx: (tx: Transaction) => Promise<string>,
): Promise<{ txSigBytes: Uint8Array; slot: bigint }> {
  const dwalletChunks = dwalletSeedChunks(args.curve, args.dwalletPublicKey);
  const dwalletPda = deriveSolanaDWalletPda(args.curve, args.dwalletPublicKey);
  const schemeLe = schemeLeBytes(args.signatureScheme);

  const msgDigest = keccak_256(args.message);
  const metaDigest = args.messageMetadata && args.messageMetadata.length > 0
    ? keccak_256(args.messageMetadata)
    : new Uint8Array(32);

  const approvalSeeds: Buffer[] = [
    Buffer.from('dwallet'),
    ...dwalletChunks,
    Buffer.from('message_approval'),
    schemeLe,
    Buffer.from(msgDigest),
  ];
  if (!isZero32(metaDigest)) approvalSeeds.push(Buffer.from(metaDigest));
  const [approvalPda, bump] = PublicKey.findProgramAddressSync(approvalSeeds, PROGRAM_ID);

  const userPk = feePayerPubkey.toBuffer();
  const data = Buffer.alloc(100);
  data.writeUInt8(8, 0);
  data.writeUInt8(bump, 1);
  Buffer.from(msgDigest).copy(data, 2);
  Buffer.from(metaDigest).copy(data, 34);
  userPk.copy(data, 66);
  data.writeUInt16LE(args.signatureScheme, 98);

  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: COORDINATOR_PDA, isSigner: false, isWritable: false },
      { pubkey: approvalPda, isSigner: false, isWritable: true },
      { pubkey: dwalletPda, isSigner: false, isWritable: false },
      { pubkey: feePayerPubkey, isSigner: true, isWritable: false },
      { pubkey: feePayerPubkey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });

  const tx = new Transaction().add(ix);
  tx.feePayer = feePayerPubkey;
  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;

  const sigStr = await signAndSendLegacyTx(tx);
  await confirmSolanaTxByPolling(connection, sigStr, {
    commitment: 'confirmed',
    progressLabel: 'Waiting for Solana to confirm approve_message',
    progressStageId: 'approve-message-confirm',
  });
  const info = await connection.getTransaction(sigStr, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
  const slot = BigInt(info?.slot ?? 0);
  const txSigBytes = base58.decode(sigStr);
  return { txSigBytes, slot };
}

/** ED25519 / Curve25519 convenience, maps to `DWalletSignatureScheme::EddsaSha512`. */
export async function sendApproveMessageForEd25519Sign(
  connection: Connection,
  feePayerPubkey: PublicKey,
  args: {
    dwalletPublicKey: Uint8Array;
    message: Uint8Array;
    messageMetadata?: Uint8Array;
  },
  signAndSendLegacyTx: (tx: Transaction) => Promise<string>,
): Promise<{ txSigBytes: Uint8Array; slot: bigint }> {
  return sendApproveMessageForSign(
    connection,
    feePayerPubkey,
    {
      curve: 'Curve25519',
      dwalletPublicKey: args.dwalletPublicKey,
      message: args.message,
      signatureScheme: DWalletSignatureScheme.EddsaSha512,
      messageMetadata: args.messageMetadata,
    },
    signAndSendLegacyTx,
  );
}

/**
 * Secp256k1 ECDSA convenience, caller picks the hash variant
 * (`Keccak256` for EVM, `DoubleSHA256` for BTC, `Sha256` for generic).
 */
export async function sendApproveMessageForSecp256k1Sign(
  connection: Connection,
  feePayerPubkey: PublicKey,
  args: {
    dwalletPublicKey: Uint8Array;
    message: Uint8Array;
    hashScheme: 'Keccak256' | 'Sha256' | 'DoubleSHA256';
    messageMetadata?: Uint8Array;
  },
  signAndSendLegacyTx: (tx: Transaction) => Promise<string>,
): Promise<{ txSigBytes: Uint8Array; slot: bigint }> {
  const scheme =
    args.hashScheme === 'Keccak256'
      ? DWalletSignatureScheme.EcdsaKeccak256
      : args.hashScheme === 'DoubleSHA256'
        ? DWalletSignatureScheme.EcdsaDoubleSha256
        : DWalletSignatureScheme.EcdsaSha256;
  return sendApproveMessageForSign(
    connection,
    feePayerPubkey,
    {
      curve: 'Secp256k1',
      dwalletPublicKey: args.dwalletPublicKey,
      message: args.message,
      signatureScheme: scheme,
      messageMetadata: args.messageMetadata,
    },
    signAndSendLegacyTx,
  );
}
