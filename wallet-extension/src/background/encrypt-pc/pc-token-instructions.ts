/**
 * Solana instruction builders for PC-Token. mirrors the upstream pinocchio program at
 * `chains/solana/examples/pc-token/pinocchio/src/lib.rs` and the e2e at
 * `chains/solana/examples/pc-token/e2e/instructions.ts` in dwallet-labs/encrypt-pre-alpha.
 *
 * each ix returns a `TransactionInstruction` ready to push into a `Transaction` /
 * `VersionedTransaction`. account ordering is positional and matches the upstream program; do
 * not reorder.
 *
 * per-ix wire formats are documented in `wallet-extension/docs/PC_TOKEN_SPIKE.md` section 3.
 */

import { PublicKey, TransactionInstruction, type AccountMeta, SystemProgram } from '@solana/web3.js';
import {
  PC_TOKEN_IX,
  SPL_TOKEN_PROGRAM_ID_B58,
  getPcTokenProgramId,
  isPcTokenConfigured,
} from '@/background/encrypt-pc/pc-token-program';
import { buildEncryptCpiSuffix } from '@/background/encrypt-pc/pc-token-cpi';
import {
  derivePcAccountPda,
  derivePcReceiptPda,
  derivePcVaultPda,
} from '@/background/encrypt-pc/pc-token-pda';
import { PcTokenError } from '@/background/encrypt-pc/pc-token-types';

function pcTokenProgram(): PublicKey {
  if (!isPcTokenConfigured()) {
    throw new PcTokenError(
      'not-configured',
      'cannot build instruction; PC-Token program ID is the unconfigured sentinel',
    );
  }
  return getPcTokenProgramId();
}

function u64LeBytes(v: bigint): Uint8Array {
  if (v < 0n || v > (1n << 64n) - 1n) {
    throw new Error(`u64 out of range: ${v}`);
  }
  const buf = new Uint8Array(8);
  let x = v;
  for (let i = 0; i < 8; i++) {
    buf[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return buf;
}

/**
 * InitializeAccount (disc 1). one-shot per (vault, mint) pair. creates the user's TokenAccount
 * PDA + writes encrypted-zero into the fresh `balanceCt` keypair.
 *
 * `balanceCt` MUST be a freshly-generated keypair-account; the caller signs the transaction with
 * that keypair so the program can `init` it. after this ix lands the program populates the PDA's
 * `balance.ciphertext_pubkey` field with `balanceCt.publicKey`.
 */
export function buildInitializeAccountIx(args: {
  pcMint: PublicKey;
  owner: PublicKey;
  payer: PublicKey;
  balanceCt: PublicKey;
  networkKey32: Uint8Array;
}): TransactionInstruction {
  const programId = pcTokenProgram();
  const { pda: accountPda, bump: accountBump } = derivePcAccountPda(args.pcMint, args.owner);
  const cpi = buildEncryptCpiSuffix(args.payer, args.networkKey32);

  const data = new Uint8Array(3);
  data[0] = PC_TOKEN_IX.InitializeAccount;
  data[1] = accountBump;
  data[2] = cpi.cpiAuthorityBump;

  const keys: AccountMeta[] = [
    { pubkey: accountPda, isSigner: false, isWritable: true },
    { pubkey: args.pcMint, isSigner: false, isWritable: false },
    { pubkey: args.owner, isSigner: false, isWritable: false },
    { pubkey: args.balanceCt, isSigner: true, isWritable: true },
    ...cpi.metas,
  ];
  return new TransactionInstruction({ programId, keys, data: Buffer.from(data) });
}

/**
 * Transfer (disc 3) - the hidden-send moment.
 *
 * per the spike, plain Transfer (disc 3) silently no-ops on insufficient balance. the flows
 * orchestrator (`pc-token-flows.ts`) does a balance pre-check before submitting this ix to
 * surface a clean `insufficient-balance` error rather than a "tx succeeded but Bob got nothing"
 * UX.
 */
export function buildTransferIx(args: {
  fromAccountPda: PublicKey;
  toAccountPda: PublicKey;
  fromBalanceCt: PublicKey;
  toBalanceCt: PublicKey;
  amountCt: PublicKey;
  owner: PublicKey;
  payer: PublicKey;
  networkKey32: Uint8Array;
}): TransactionInstruction {
  const programId = pcTokenProgram();
  const cpi = buildEncryptCpiSuffix(args.payer, args.networkKey32);

  const data = new Uint8Array(2);
  data[0] = PC_TOKEN_IX.Transfer;
  data[1] = cpi.cpiAuthorityBump;

  const keys: AccountMeta[] = [
    { pubkey: args.fromAccountPda, isSigner: false, isWritable: false },
    { pubkey: args.toAccountPda, isSigner: false, isWritable: false },
    { pubkey: args.fromBalanceCt, isSigner: false, isWritable: true },
    { pubkey: args.toBalanceCt, isSigner: false, isWritable: true },
    { pubkey: args.amountCt, isSigner: false, isWritable: true },
    { pubkey: args.owner, isSigner: true, isWritable: false },
    ...cpi.metas,
  ];
  return new TransactionInstruction({ programId, keys, data: Buffer.from(data) });
}

/**
 * Wrap (disc 30) - SPL -> pcSPL. `amountPlaintext` is what the SPL transfer leg moves; it's
 * VISIBLE on-chain (the privacy guarantee is for the post-wrap balance, not the wrap deposit).
 */
export function buildWrapIx(args: {
  vaultPda: PublicKey;
  tokenAccountPda: PublicKey;
  userAta: PublicKey;
  vaultAta: PublicKey;
  balanceCt: PublicKey;
  amountCt: PublicKey;
  owner: PublicKey;
  payer: PublicKey;
  amountPlaintext: bigint;
  networkKey32: Uint8Array;
}): TransactionInstruction {
  const programId = pcTokenProgram();
  const cpi = buildEncryptCpiSuffix(args.payer, args.networkKey32);

  const data = new Uint8Array(10);
  data[0] = PC_TOKEN_IX.Wrap;
  data[1] = cpi.cpiAuthorityBump;
  data.set(u64LeBytes(args.amountPlaintext), 2);

  const keys: AccountMeta[] = [
    { pubkey: args.vaultPda, isSigner: false, isWritable: false },
    { pubkey: args.tokenAccountPda, isSigner: false, isWritable: false },
    { pubkey: args.userAta, isSigner: false, isWritable: true },
    { pubkey: args.vaultAta, isSigner: false, isWritable: true },
    { pubkey: args.balanceCt, isSigner: false, isWritable: true },
    { pubkey: args.amountCt, isSigner: false, isWritable: true },
    { pubkey: args.owner, isSigner: true, isWritable: false },
    ...cpi.metas,
    { pubkey: new PublicKey(SPL_TOKEN_PROGRAM_ID_B58), isSigner: false, isWritable: false },
  ];
  return new TransactionInstruction({ programId, keys, data: Buffer.from(data) });
}

/**
 * UnwrapBurn (disc 31) - step 1 of 3. burns the encrypted requested amount from the user's
 * balance and creates a `WithdrawalReceipt` PDA tracking what's actually owed. `burnedCt` starts
 * at encrypted-zero; the FHE graph writes the actually-burned amount into it (capped at the
 * user's available balance).
 */
export function buildUnwrapBurnIx(args: {
  vaultPda: PublicKey;
  tokenAccountPda: PublicKey;
  balanceCt: PublicKey;
  amountCt: PublicKey;
  burnedCt: PublicKey;
  owner: PublicKey;
  payer: PublicKey;
  amountPlaintext: bigint;
  networkKey32: Uint8Array;
}): TransactionInstruction {
  const programId = pcTokenProgram();
  const { pda: receiptPda, bump: receiptBump } = derivePcReceiptPda(args.burnedCt);
  const cpi = buildEncryptCpiSuffix(args.payer, args.networkKey32);

  const data = new Uint8Array(11);
  data[0] = PC_TOKEN_IX.UnwrapBurn;
  data[1] = receiptBump;
  data[2] = cpi.cpiAuthorityBump;
  data.set(u64LeBytes(args.amountPlaintext), 3);

  const keys: AccountMeta[] = [
    { pubkey: args.vaultPda, isSigner: false, isWritable: false },
    { pubkey: args.tokenAccountPda, isSigner: false, isWritable: true },
    { pubkey: receiptPda, isSigner: false, isWritable: true },
    { pubkey: args.balanceCt, isSigner: false, isWritable: true },
    { pubkey: args.amountCt, isSigner: false, isWritable: true },
    { pubkey: args.burnedCt, isSigner: false, isWritable: true },
    { pubkey: args.owner, isSigner: true, isWritable: false },
    ...cpi.metas,
  ];
  return new TransactionInstruction({ programId, keys, data: Buffer.from(data) });
}

/**
 * UnwrapDecrypt (disc 32) - step 2 of 3. requests the executor decrypt `burnedCt` so step 3 can
 * release exactly that many SPL tokens. after this ix lands the chromatika UI must poll the
 * `requestAcct` until the executor commits a decryption response (~3-60s on devnet).
 */
export function buildUnwrapDecryptIx(args: {
  receiptPda: PublicKey;
  requestAcct: PublicKey;
  burnedCt: PublicKey;
  owner: PublicKey;
  payer: PublicKey;
  networkKey32: Uint8Array;
}): TransactionInstruction {
  const programId = pcTokenProgram();
  // configPda must be non-writable for UnwrapDecrypt per upstream e2e.
  const cpi = buildEncryptCpiSuffix(args.payer, args.networkKey32, { configPdaWritable: false });

  const data = new Uint8Array(2);
  data[0] = PC_TOKEN_IX.UnwrapDecrypt;
  data[1] = cpi.cpiAuthorityBump;

  const keys: AccountMeta[] = [
    { pubkey: args.receiptPda, isSigner: false, isWritable: true },
    { pubkey: args.requestAcct, isSigner: true, isWritable: true },
    { pubkey: args.burnedCt, isSigner: false, isWritable: false },
    { pubkey: args.owner, isSigner: true, isWritable: false },
    ...cpi.metas,
  ];
  return new TransactionInstruction({ programId, keys, data: Buffer.from(data) });
}

/**
 * UnwrapComplete (disc 33) - step 3 of 3. verifies the decryption result and releases SPL
 * tokens from the vault to the user's ATA. `destination` reclaims the SOL rent when the receipt
 * closes; usually the payer.
 */
export function buildUnwrapCompleteIx(args: {
  receiptPda: PublicKey;
  vaultPda: PublicKey;
  pcMint: PublicKey;
  requestAcct: PublicKey;
  vaultAta: PublicKey;
  userAta: PublicKey;
  owner: PublicKey;
  destination: PublicKey;
}): TransactionInstruction {
  const programId = pcTokenProgram();

  const data = new Uint8Array(1);
  data[0] = PC_TOKEN_IX.UnwrapComplete;

  const keys: AccountMeta[] = [
    { pubkey: args.receiptPda, isSigner: false, isWritable: true },
    { pubkey: args.vaultPda, isSigner: false, isWritable: false },
    { pubkey: args.pcMint, isSigner: false, isWritable: false },
    { pubkey: args.requestAcct, isSigner: false, isWritable: false },
    { pubkey: args.vaultAta, isSigner: false, isWritable: true },
    { pubkey: args.userAta, isSigner: false, isWritable: true },
    { pubkey: args.owner, isSigner: true, isWritable: false },
    { pubkey: args.destination, isSigner: false, isWritable: true },
    { pubkey: new PublicKey(SPL_TOKEN_PROGRAM_ID_B58), isSigner: false, isWritable: false },
  ];
  return new TransactionInstruction({ programId, keys, data: Buffer.from(data) });
}

/**
 * InitializeVault (disc 23) - one-time per (pcMint, splMint) pair. the mint admin runs this, not
 * end users. included here for completeness; chromatika's runtime does NOT call it directly in v0
 * (we assume a vault exists for the demo pcUSDC mint).
 */
export function buildInitializeVaultIx(args: {
  pcMint: PublicKey;
  splMint: PublicKey;
  payer: PublicKey;
}): TransactionInstruction {
  const programId = pcTokenProgram();
  const { pda: vaultPda, bump: vaultBump } = derivePcVaultPda(args.pcMint);
  const data = new Uint8Array(2);
  data[0] = PC_TOKEN_IX.InitializeVault;
  data[1] = vaultBump;

  const keys: AccountMeta[] = [
    { pubkey: vaultPda, isSigner: false, isWritable: true },
    { pubkey: args.pcMint, isSigner: false, isWritable: false },
    { pubkey: args.splMint, isSigner: false, isWritable: false },
    { pubkey: args.payer, isSigner: true, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
  return new TransactionInstruction({ programId, keys, data: Buffer.from(data) });
}
