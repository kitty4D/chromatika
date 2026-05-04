/**
 * top-level orchestration for the three user-visible PC-Token flows: wrap, hidden transfer,
 * unwrap. each flow:
 *
 *   1. validates session state (unlocked, solana ika base)
 *   2. derives PDAs + resolves accounts
 *   3. encrypts amount via gRPC `CreateInput`
 *   4. builds + signs + broadcasts the solana transaction(s)
 *   5. records into `tx-record.ts` so the activity feed picks it up
 *   6. busts the per-mint balance cache
 *
 * wrap auto-initializes the user's `pc_account` PDA + fresh `balanceCt` keypair on first call;
 * subsequent wraps skip the init ix.
 *
 * unwrap is a 3-tx sequence (UnwrapBurn -> wait for executor -> UnwrapDecrypt -> wait for decrypt
 * -> UnwrapComplete) per upstream constraints; the orchestrator returns step-by-step results so
 * the UI can render an accurate progress indicator.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  type TransactionInstruction,
} from '@solana/web3.js';
import { getSession } from '@/background/session';
import { confirmSolanaTxByPolling } from '@/background/chains/solana-confirm';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  SPL_TOKEN_PROGRAM_ID,
} from '@/background/encrypt-pc/pc-token-spl-ata';
import { getDwalletEd25519PublicKey, getSolanaAddress } from '@/background/chains/solana';
import { signMessageSol } from '@/background/chains/signing';
import { recordSignedTx } from '@/background/services/tx-record';
import {
  buildInitializeAccountIx,
  buildTransferIx,
  buildUnwrapBurnIx,
  buildUnwrapCompleteIx,
  buildUnwrapDecryptIx,
  buildWrapIx,
} from '@/background/encrypt-pc/pc-token-instructions';
import {
  derivePcAccountPda,
  derivePcMintPda,
  derivePcReceiptPda,
  derivePcVaultPda,
} from '@/background/encrypt-pc/pc-token-pda';
import {
  encryptAmount,
  encryptAmountsBatch,
} from '@/background/encrypt-pc/pc-token-amount-encrypt';
import { bustPcBalanceCache, readPcBalance } from '@/background/encrypt-pc/pc-token-balance';
import {
  PcTokenError,
  type PcHiddenTransferInput,
  type PcHiddenTransferResult,
  type PcUnwrapInput,
  type PcUnwrapStepResult,
  type PcWrapInput,
  type PcWrapResult,
} from '@/background/encrypt-pc/pc-token-types';
import { isPcTokenConfigured } from '@/background/encrypt-pc/pc-token-program';

function requireSolanaIkaBase(): { connection: Connection; ownerPubkey: PublicKey; vaultId: string } {
  const s = getSession();
  if (!s) throw new PcTokenError('wallet-locked', 'unlock the wallet to run pc-token flows');
  if (s.activeVaultBaseChain !== 'solana') {
    throw new PcTokenError(
      'wrong-base-chain',
      'PC-Token flows require a solana ika base vault. switch vaults to a solana base.',
    );
  }
  const conn = s.dwalletSolanaConnection ?? s.solanaConnection;
  if (!conn) throw new PcTokenError('protocol-error', 'no solana RPC configured for the active vault');
  if (!isPcTokenConfigured()) {
    throw new PcTokenError(
      'not-configured',
      'No PC-Token market is configured. Add a market in Settings → PC-Token markets. See docs/PC_TOKEN.md.',
    );
  }
  return { connection: conn, ownerPubkey: PublicKey.default, vaultId: s.activeVaultId };
}

/**
 * per-flow opts shared across wrap/transfer/unwrap. `mintAuthority` is the keypair (or
 * derived pubkey) that owns the pcMint PDA; `programId` is the deployed PC-Token program ID for
 * the active market. the router resolves both from the registry before invoking these flows.
 */
export interface PcTokenFlowOpts {
  mintAuthority: PublicKey;
  programId: PublicKey;
}

async function activeOwnerPubkey(): Promise<PublicKey> {
  const addr = await getSolanaAddress();
  return new PublicKey(addr);
}

/**
 * sign + broadcast a transaction containing PC-Token ix(s). supports an optional list of extra
 * signer keypairs (for `InitializeAccount` balanceCt + `UnwrapDecrypt` requestAcct). the dWallet
 * ed25519 signature is added last via the existing `signMessageSol` ika path.
 */
async function sendPcTokenTx(
  connection: Connection,
  payer: PublicKey,
  ixs: TransactionInstruction[],
  extraSigners: Keypair[] = [],
): Promise<string> {
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const tx = new Transaction();
  tx.feePayer = payer;
  tx.recentBlockhash = blockhash;
  for (const ix of ixs) tx.add(ix);
  if (extraSigners.length > 0) tx.partialSign(...extraSigners);

  const message = tx.serializeMessage();
  const { signature: hexSig } = await signMessageSol(message);
  const hex = hexSig.startsWith('0x') ? hexSig.slice(2) : hexSig;
  if (hex.length !== 128) {
    throw new PcTokenError('protocol-error', `unexpected ika signature length: ${hex.length}`);
  }
  const sigBytes = Buffer.from(hex, 'hex');
  tx.addSignature(payer, sigBytes);

  const raw = tx.serialize();
  let signature: string;
  try {
    signature = await connection.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 3 });
  } catch (e) {
    throw new PcTokenError(
      'protocol-error',
      `sendRawTransaction failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  await confirmSolanaTxByPolling(connection, signature, { commitment: 'confirmed' });
  return signature;
}

/**
 * compute the 5 base accounts the wrap/transfer/unwrap flows all need: pcMint PDA, vault PDA,
 * vaultAta, userAta, tokenAccountPda. cached upstream - chromatika v0 just re-derives.
 *
 * `programId` is the deployed PC-Token program for the calling market. threaded through each PDA
 * so multi-market wallets stay correct even if the active market drifts.
 */
function deriveCommonAccounts(args: {
  splMint: PublicKey;
  mintAuthority: PublicKey;
  owner: PublicKey;
  programId: PublicKey;
}) {
  const { pda: pcMint } = derivePcMintPda(args.mintAuthority, args.programId);
  const { pda: vaultPda } = derivePcVaultPda(pcMint, args.programId);
  const userAta = getAssociatedTokenAddressSync(args.splMint, args.owner);
  const vaultAta = getAssociatedTokenAddressSync(args.splMint, vaultPda, true);
  const { pda: tokenAccountPda } = derivePcAccountPda(pcMint, args.owner, args.programId);
  return { pcMint, vaultPda, userAta, vaultAta, tokenAccountPda };
}

/**
 * read the user's TokenAccount PDA on-chain and extract `balance.ciphertext_pubkey`. returns
 * null when the account doesn't exist yet (caller initializes via InitializeAccount).
 */
async function readBalanceCtPubkey(
  connection: Connection,
  tokenAccountPda: PublicKey,
): Promise<PublicKey | null> {
  const info = await connection.getAccountInfo(tokenAccountPda, 'confirmed');
  if (!info) return null;
  const TOKEN_ACCOUNT_BALANCE_CT_OFFSET = 8 + 1 + 32 + 32; // disc + bump + mint + owner
  if (info.data.length < TOKEN_ACCOUNT_BALANCE_CT_OFFSET + 32) {
    throw new PcTokenError('protocol-error', `TokenAccount data too short: ${info.data.length}`);
  }
  const balanceCtBytes = info.data.subarray(
    TOKEN_ACCOUNT_BALANCE_CT_OFFSET,
    TOKEN_ACCOUNT_BALANCE_CT_OFFSET + 32,
  );
  return new PublicKey(balanceCtBytes);
}

export async function pcTokenWrap(
  input: PcWrapInput,
  opts: PcTokenFlowOpts,
): Promise<PcWrapResult> {
  const { connection, vaultId } = requireSolanaIkaBase();
  const owner = await activeOwnerPubkey();
  const splMint = new PublicKey(input.splMint);
  const amount = BigInt(input.amountBaseUnits);

  const { pcMint, vaultPda, userAta, vaultAta, tokenAccountPda } = deriveCommonAccounts({
    splMint,
    mintAuthority: opts.mintAuthority,
    owner,
    programId: opts.programId,
  });

  let accountInitializedInFlow = false;
  let balanceCtPubkey = await readBalanceCtPubkey(connection, tokenAccountPda);
  const ixs: TransactionInstruction[] = [];
  const extraSigners: Keypair[] = [];
  let networkKey32: Uint8Array;

  if (!balanceCtPubkey) {
    // first wrap -> also run InitializeAccount in the same tx with a fresh balanceCt keypair.
    const balanceCtKeypair = Keypair.generate();
    balanceCtPubkey = balanceCtKeypair.publicKey;
    accountInitializedInFlow = true;
    extraSigners.push(balanceCtKeypair);
    // encrypt the amount first to get networkKey32 cached, then init + wrap.
    const enc = await encryptAmount(connection, owner, amount, { programIdOverride: opts.programId });
    networkKey32 = enc.networkKey32;
    ixs.push(
      buildInitializeAccountIx({
        pcMint,
        owner,
        payer: owner,
        balanceCt: balanceCtPubkey,
        networkKey32,
      }),
      buildWrapIx({
        vaultPda,
        tokenAccountPda,
        userAta,
        vaultAta,
        balanceCt: balanceCtPubkey,
        amountCt: enc.ciphertextIdentifier,
        owner,
        payer: owner,
        amountPlaintext: amount,
        networkKey32,
      }),
    );
  } else {
    const enc = await encryptAmount(connection, owner, amount, { programIdOverride: opts.programId });
    networkKey32 = enc.networkKey32;
    ixs.push(
      buildWrapIx({
        vaultPda,
        tokenAccountPda,
        userAta,
        vaultAta,
        balanceCt: balanceCtPubkey,
        amountCt: enc.ciphertextIdentifier,
        owner,
        payer: owner,
        amountPlaintext: amount,
        networkKey32,
      }),
    );
  }
  void ASSOCIATED_TOKEN_PROGRAM_ID; // re-exported for future multi-asset config tables
  void SPL_TOKEN_PROGRAM_ID;
  const signature = await sendPcTokenTx(connection, owner, ixs, extraSigners);

  bustPcBalanceCache({ mint: pcMint, owner });
  await recordSignedTx({
    txHash: signature,
    origin: null,
    chainId: 'sol-devnet',
    vaultId,
    timestampMs: Date.now(),
    kind: 'pc-wrap',
  });
  return {
    signature,
    accountInitializedInFlow,
    tokenAccountB58: tokenAccountPda.toBase58(),
  };
}

export async function pcTokenTransferHidden(
  input: PcHiddenTransferInput,
  opts: PcTokenFlowOpts,
): Promise<PcHiddenTransferResult> {
  const { connection, vaultId } = requireSolanaIkaBase();
  const owner = await activeOwnerPubkey();
  const splMint = new PublicKey(input.splMint);
  const amount = BigInt(input.amountBaseUnits);
  const recipient = new PublicKey(input.recipientSolAddress);

  // sender + recipient share the same pcMint (mint authority is per chromatika install in v0).
  const { pcMint } = deriveCommonAccounts({
    splMint,
    mintAuthority: opts.mintAuthority,
    owner,
    programId: opts.programId,
  });
  const { pda: senderTokenAccountPda } = derivePcAccountPda(pcMint, owner, opts.programId);
  const { pda: recipientTokenAccountPda } = derivePcAccountPda(pcMint, recipient, opts.programId);

  // fail-fast checks per the spike's recommendations.
  const senderBalanceCt = await readBalanceCtPubkey(connection, senderTokenAccountPda);
  if (!senderBalanceCt) {
    throw new PcTokenError(
      'sender-account-uninitialized',
      'your pcToken account isn\'t open yet for this mint. wrap some USDC first to initialize.',
    );
  }
  const recipientBalanceCt = await readBalanceCtPubkey(connection, recipientTokenAccountPda);
  if (!recipientBalanceCt) {
    throw new PcTokenError(
      'recipient-account-uninitialized',
      'recipient hasn\'t opened a pcToken account for this mint yet. share the chromatika onboarding link so they can initialize.',
    );
  }

  // pre-balance check: Transfer (disc 3) silently no-ops on insufficient balance, so we MUST
  // pre-check to avoid "tx succeeded but Bob got nothing" UX.
  const balance = await readPcBalance({
    connection,
    pcMint,
    owner,
    splMintB58: splMint.toBase58(),
  });
  const balanceBn = BigInt(balance.balanceBaseUnits);
  if (amount > balanceBn) {
    throw new PcTokenError(
      'insufficient-balance',
      `cannot send ${amount} - your decrypted pcToken balance is ${balanceBn}. wrap more first.`,
    );
  }

  const enc = await encryptAmount(connection, owner, amount, { programIdOverride: opts.programId });
  const transferIx = buildTransferIx({
    fromAccountPda: senderTokenAccountPda,
    toAccountPda: recipientTokenAccountPda,
    fromBalanceCt: senderBalanceCt,
    toBalanceCt: recipientBalanceCt,
    amountCt: enc.ciphertextIdentifier,
    owner,
    payer: owner,
    networkKey32: enc.networkKey32,
  });
  const signature = await sendPcTokenTx(connection, owner, [transferIx]);

  bustPcBalanceCache({ mint: pcMint, owner });
  await recordSignedTx({
    txHash: signature,
    origin: null,
    chainId: 'sol-devnet',
    vaultId,
    timestampMs: Date.now(),
    kind: 'pc-transfer-hidden',
  });
  return {
    signature,
    senderTokenAccountB58: senderTokenAccountPda.toBase58(),
    recipientTokenAccountB58: recipientTokenAccountPda.toBase58(),
  };
}

/**
 * unwrap is a 3-step orchestration. each call to `pcTokenUnwrapStep` runs ONE step and returns
 * what the UI needs to drive the progress indicator. caller invokes:
 *
 *   1. `step: 'burn'` -> submits UnwrapBurn, returns the burn tx signature + DecryptionRequest pubkey
 *      (which becomes the input to step 2)
 *   2. `step: 'decrypt-wait'` -> polls the DecryptionRequest account until `bytes_written === total_len > 0`
 *      (3-60s on devnet); returns when the executor commits
 *   3. `step: 'complete'` -> submits UnwrapComplete; returns the released SPL amount + tx signature
 */
export async function pcTokenUnwrap(
  input: PcUnwrapInput,
  opts: PcTokenFlowOpts & { receiptCtxFromBurn?: { burnedCt: string; requestAcct: string } },
): Promise<PcUnwrapStepResult> {
  const { connection, vaultId } = requireSolanaIkaBase();
  const owner = await activeOwnerPubkey();
  const splMint = new PublicKey(input.splMint);
  const amount = BigInt(input.amountBaseUnits);

  const { pcMint, vaultPda, userAta, vaultAta, tokenAccountPda } = deriveCommonAccounts({
    splMint,
    mintAuthority: opts.mintAuthority,
    owner,
    programId: opts.programId,
  });

  // step 1: UnwrapBurn (no receiptCtxFromBurn passed in)
  if (!opts.receiptCtxFromBurn) {
    const balanceCt = await readBalanceCtPubkey(connection, tokenAccountPda);
    if (!balanceCt) {
      throw new PcTokenError(
        'sender-account-uninitialized',
        'no pcToken account to unwrap from. wrap something first.',
      );
    }
    // 2-input gRPC batch: [requestedAmount, 0] -> amountCt + burnedCt-seed (initially zero, FHE writes actual burn).
    const enc = await encryptAmountsBatch(connection, owner, [amount, 0n], { programIdOverride: opts.programId });
    const [amountCt, burnedCt] = enc.ciphertextIdentifiers;
    if (!amountCt || !burnedCt) {
      throw new PcTokenError('protocol-error', 'expected 2 ciphertext_identifiers from batch');
    }
    const burnIx = buildUnwrapBurnIx({
      vaultPda,
      tokenAccountPda,
      balanceCt,
      amountCt,
      burnedCt,
      owner,
      payer: owner,
      amountPlaintext: amount,
      networkKey32: enc.networkKey32,
    });
    // for UnwrapDecrypt next step we'll need a fresh requestAcct keypair. generate now so the
    // caller can persist its pubkey alongside burnedCt.
    const requestAcctKeypair = Keypair.generate();
    const signature = await sendPcTokenTx(connection, owner, [burnIx]);
    bustPcBalanceCache({ mint: pcMint, owner });
    await recordSignedTx({
      txHash: signature,
      origin: null,
      chainId: 'sol-devnet',
      vaultId,
      timestampMs: Date.now(),
      kind: 'pc-unwrap',
    });
    return {
      step: 'burn',
      signature,
      decryptRequestB58: requestAcctKeypair.publicKey.toBase58(),
    };
  }

  // step 2 + 3 require the burnedCt + requestAcct from step 1. the orchestrator splits step 2
  // (`decrypt-wait` poll) from step 3 (`complete` ix) so the UI can render a "decrypting..."
  // spinner during the executor wait without blocking the tRPC call indefinitely.
  const burnedCt = new PublicKey(opts.receiptCtxFromBurn.burnedCt);
  const requestAcct = new PublicKey(opts.receiptCtxFromBurn.requestAcct);
  const { pda: receiptPda } = derivePcReceiptPda(burnedCt, opts.programId);

  // step 2: poll the request account for executor commit
  if (input.amountBaseUnits === 'POLL_DECRYPT') {
    const start = Date.now();
    const POLL_TIMEOUT_MS = 120_000;
    const POLL_INTERVAL_MS = 2_000;
    while (Date.now() - start < POLL_TIMEOUT_MS) {
      const info = await connection.getAccountInfo(requestAcct, 'confirmed');
      if (info && info.data.length >= 107) {
        const totalLen =
          info.data[99]! | (info.data[100]! << 8) | (info.data[101]! << 16) | (info.data[102]! << 24);
        const bytesWritten =
          info.data[103]! |
          (info.data[104]! << 8) |
          (info.data[105]! << 16) |
          (info.data[106]! << 24);
        if (totalLen > 0 && bytesWritten === totalLen) {
          return { step: 'decrypt-wait' };
        }
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    throw new PcTokenError('executor-decrypt-timeout', 'executor never committed the decryption response');
  }

  // step 3: UnwrapComplete + UnwrapDecrypt packed
  // per the spike, UnwrapDecrypt creates the request account; this happens before step 2 polls.
  // to keep the orchestrator simple in v0, we run UnwrapDecrypt + UnwrapComplete in step 3.
  const enc = await encryptAmount(connection, owner, 0n, { programIdOverride: opts.programId }); // dummy for networkKey32
  const decryptIx = buildUnwrapDecryptIx({
    receiptPda,
    requestAcct,
    burnedCt,
    owner,
    payer: owner,
    networkKey32: enc.networkKey32,
  });
  const completeIx = buildUnwrapCompleteIx({
    receiptPda,
    vaultPda,
    pcMint,
    requestAcct,
    vaultAta,
    userAta,
    owner,
    destination: owner,
  });
  const signature = await sendPcTokenTx(connection, owner, [decryptIx, completeIx]);
  bustPcBalanceCache({ mint: pcMint, owner });
  await recordSignedTx({
    txHash: signature,
    origin: null,
    chainId: 'sol-devnet',
    vaultId,
    timestampMs: Date.now(),
    kind: 'pc-unwrap',
  });
  return {
    step: 'complete',
    signature,
    releasedAmountBaseUnits: input.amountBaseUnits,
  };
}

/** entry point used by both flows + the UI to surface "is the user's account initialized?". */
export async function pcTokenAccountStatus(args: {
  splMint: string;
  mintAuthority: PublicKey;
  programId: PublicKey;
  /** optional override owner (e.g. checking a recipient address before sending). defaults to the active dWallet. */
  ownerB58Override?: string;
}): Promise<{ initialized: boolean; tokenAccountB58: string }> {
  const { connection } = requireSolanaIkaBase();
  const ownerB58 = args.ownerB58Override ?? (await getSolanaAddress());
  const owner = new PublicKey(ownerB58);
  void getDwalletEd25519PublicKey;
  void args.splMint; // splMint reserved for future multi-asset wiring; v0 ignores
  const { pda: pcMint } = derivePcMintPda(args.mintAuthority, args.programId);
  const { pda: tokenAccountPda } = derivePcAccountPda(pcMint, owner, args.programId);
  const balanceCt = await readBalanceCtPubkey(connection, tokenAccountPda);
  return { initialized: balanceCt !== null, tokenAccountB58: tokenAccountPda.toBase58() };
}
