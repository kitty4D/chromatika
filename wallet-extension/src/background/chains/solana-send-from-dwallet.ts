/**
 * send native SOL or any SPL token from a **dWallet's** Solana address (the ED25519 dWallet's
 * derived base58 address), signed by ika MPC instead of the vault fee-payer keypair.
 *
 * sibling to:
 *   - [`solana-send-native.ts`](./solana-send-native.ts) - sends SOL from the vault keypair
 *   - [`solana-send-spl.ts`](./solana-send-spl.ts) - sends SPL from the vault keypair
 *
 * fee model: the dWallet's Solana address is BOTH the transfer authority and the fee payer.
 * the dWallet needs SOL at its Solana address for gas + (for SPL) potentially for
 * CreateIdempotent rent. if it doesn't, the tx fails before signing. (sponsored-fee-payer
 * where the vault keypair pays gas is doable - tx.feePayer = vaultPubkey, then sign with both
 * vault keypair and ika - but it requires two signatures so left for follow-up if users hit
 * empty-SOL-balance often.)
 *
 * signing path mirrors the dapp `solana_signTransaction` flow in
 * [`solana-tx-sign.ts`](./solana-tx-sign.ts): build a VersionedTransaction, sign the message
 * bytes via `signMessageSol` (ika ED25519), verify via @noble/ed25519, then add the signature
 * back to the wire transaction and broadcast.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  TransactionInstruction,
} from '@solana/web3.js';
import * as ed25519 from '@noble/ed25519';
import { base58 } from '@scure/base';
import { getSession } from '@/background/session';
import { confirmSolanaTxByPolling } from '@/background/chains/solana-confirm';
import { getDwalletEd25519PublicKeyForDwalletId } from '@/background/chains/solana';
import { signMessageSol } from '@/background/chains/signing';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  SPL_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from '@/background/encrypt-pc/pc-token-spl-ata';

function hexSigToBytes(hex: string): Uint8Array {
  const h = hex.replace(/^0x/i, '');
  if (h.length !== 128) throw new Error('expected 64-byte Ed25519 signature (hex)');
  return Uint8Array.from(h.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)));
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

/** minimum SOL we want left AT the dWallet's Solana address AFTER a send, so the account
 * doesn't go below Solana's rent-exempt floor (~890_880 lamports for a base 0-data account).
 * solana validates post-state at preflight - sending too much that the source drops below
 * rent fails with "insufficient funds for rent" even if the System Program transfer itself
 * succeeded. we conservatively reserve a bit more than the strict minimum to cover priority
 * fees, possible compute-unit price changes, and any future ATA-creation rent (for SPL sends).
 */
const SOLANA_RENT_EXEMPT_MIN_LAMPORTS = 890_880n; // minBalanceForRentExemption(0) on mainnet
const TX_FEE_BUFFER_LAMPORTS = 10_000n;            // base 5000 × 2 sigs slack
const SPL_ATA_RENT_RESERVE_LAMPORTS = 2_500_000n;  // CreateAssociatedTokenAccount rent ~2,039,280 + slack

/** lamports that must REMAIN at the dWallet after a send completes (rent floor + fee). */
const DWALLET_SOL_POST_SEND_RESERVE_LAMPORTS =
  SOLANA_RENT_EXEMPT_MIN_LAMPORTS + TX_FEE_BUFFER_LAMPORTS;

/** preflight floor for whether the dWallet's Solana address has *any* SOL we can work with.
 * sub-this means even a sweep can't succeed; surface a clear error before signing. */
const DWALLET_SOL_MIN_BALANCE_LAMPORTS = DWALLET_SOL_POST_SEND_RESERVE_LAMPORTS + 1n;

/** how many times to retry the entire sign + broadcast cycle when the broadcast fails because
 * the blockhash expired. ika MPC sign on Sui-base routinely takes 30-80s; Solana blockhashes
 * are valid ~60-90s. with the signing-key cache hot, sign drops to ~25-30s and one re-sign
 * almost always lands inside the next blockhash's validity window. each retry is another full
 * MPC sign so we cap at 2 retries (3 total attempts) to avoid runaway latency. */
const BLOCKHASH_EXPIRY_MAX_RETRIES = 2;

function isBlockhashExpiredError(msg: string): boolean {
  const lower = msg.toLowerCase();
  return (
    lower.includes('blockhash not found') ||
    lower.includes('blockhashnotfound') ||
    // mostly seen as the human-readable form, but the error code variant exists too
    lower.includes('blockhash not in recent') ||
    lower.includes('block height exceeded')
  );
}

/** poll `getSignatureStatus(sig)` for up to `totalMs`. used after a broadcast/confirm threw to
 * detect the "tx actually landed but the client lost the race" case before we trigger a retry.
 *
 * why this matters: ika MPC sign on Sui-base is slow (30-80s) and routinely brushes against
 * Solana's blockhash validity window (~60-90s). a tx can be accepted by the RPC, propagate to
 * the leader, and land in a block - while our `confirmSolanaTxByPolling` 60s timer expires or
 * the broadcast call throws "blockhash not found" because the cluster moved on. without this
 * check we'd retry, the retry's preflight rejects with "insufficient lamports / rent" (the
 * wallet is now drained), and the user sees a scary "Solana RPC rejected" error in the UI
 * even though their send actually succeeded. polling for a few seconds catches this race. */
async function pollForSignatureLanded(
  connection: Connection,
  sig: string,
  options: { totalMs: number; intervalMs: number },
): Promise<
  | { landed: true; confirmationStatus: string | null; chainErr: unknown; slot: number | null }
  | { landed: false }
> {
  const start = Date.now();
  while (Date.now() - start < options.totalMs) {
    try {
      // `searchTransactionHistory: true` so we also catch txs that already moved out of the
      // status cache (signature lookups after a few seconds are cheap on mainnet/devnet RPCs).
      const res = await connection.getSignatureStatus(sig, { searchTransactionHistory: true });
      if (res?.value) {
        return {
          landed: true,
          confirmationStatus: res.value.confirmationStatus ?? null,
          chainErr: res.value.err,
          slot: res.value.slot ?? null,
        };
      }
    } catch (e) {
      // transient RPC error - keep polling; the next interval might succeed
      console.warn('[solana-send-from-dwallet] post-error status poll failed (will retry)', e);
    }
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs));
  }
  return { landed: false };
}

async function buildSignAndSend(
  connection: Connection,
  dwalletPubkey: PublicKey,
  dwalletId: string,
  instructions: TransactionInstruction[],
): Promise<string> {
  const dwalletAddr = dwalletPubkey.toBase58();
  console.warn('[solana-send-from-dwallet] start', {
    dwalletAddr,
    dwalletId: dwalletId.slice(0, 20),
    instructionCount: instructions.length,
    rpcEndpoint: (connection as unknown as { rpcEndpoint?: string }).rpcEndpoint,
  });

  // preflight: dWallet's Solana address pays its own gas. without SOL there, `sendRawTransaction`
  // throws "Account does not exist or has no lamports" (or similar) at preflight and the tx never
  // lands on chain, so it doesn't appear on solscan. surface a clear error here instead.
  let balanceLamports: number;
  try {
    balanceLamports = await connection.getBalance(dwalletPubkey, 'confirmed');
  } catch (e) {
    console.warn('[solana-send-from-dwallet] balance check failed', e);
    balanceLamports = 0;
  }
  console.warn('[solana-send-from-dwallet] dWallet SOL balance preflight', {
    dwalletAddr,
    balanceLamports,
    minTotalLamports: DWALLET_SOL_MIN_BALANCE_LAMPORTS.toString(),
    rentExemptFloorLamports: SOLANA_RENT_EXEMPT_MIN_LAMPORTS.toString(),
    feeBufferLamports: TX_FEE_BUFFER_LAMPORTS.toString(),
  });
  if (BigInt(balanceLamports) < DWALLET_SOL_MIN_BALANCE_LAMPORTS) {
    throw new Error(
      `dWallet's Solana address (${dwalletAddr}) doesn't have enough SOL to send anything. ` +
        `Current balance: ${(balanceLamports / 1_000_000_000).toFixed(6)} SOL (${balanceLamports} lamports). ` +
        `Solana requires the account to stay above the rent-exempt minimum (~${SOLANA_RENT_EXEMPT_MIN_LAMPORTS} lamports) ` +
        `even after the send, plus ~${TX_FEE_BUFFER_LAMPORTS} lamports for the tx fee. ` +
        `Send at least ~0.001 SOL to that address first, then retry.`,
    );
  }

  // retry loop wraps blockhash fetch + sign + broadcast. on blockhash expiry we restart from
  // the blockhash fetch with a fresh value and re-run the ika MPC sign against the new
  // message bytes. all other failures bubble up immediately.
  const pubkeyBytes = await getDwalletEd25519PublicKeyForDwalletId(dwalletId);
  let lastError: unknown;
  for (let attempt = 0; attempt <= BLOCKHASH_EXPIRY_MAX_RETRIES; attempt++) {
    const attemptStartMs = Date.now();
    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    console.warn('[solana-send-from-dwallet] attempt', {
      attempt: attempt + 1,
      maxAttempts: BLOCKHASH_EXPIRY_MAX_RETRIES + 1,
      blockhash,
    });

    const messageV0 = new TransactionMessage({
      payerKey: dwalletPubkey,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message();
    const vtx = new VersionedTransaction(messageV0);

    const messageBytes = vtx.message.serialize();
    console.warn('[solana-send-from-dwallet] requesting ika MPC sign', { messageBytesLen: messageBytes.length, attempt: attempt + 1 });
    const signStartMs = Date.now();
    const { signature: mpcHex } = await signMessageSol(messageBytes, { ed25519DwalletId: dwalletId });
    const signElapsedMs = Date.now() - signStartMs;
    const sigBytes = hexSigToBytes(mpcHex);

    const verified = await ed25519.verify(sigBytes, messageBytes, pubkeyBytes);
    console.warn('[solana-send-from-dwallet] local verify result', {
      verified,
      sigLen: sigBytes.length,
      pubkeyLen: pubkeyBytes.length,
      dwalletAddr,
      signElapsedMs,
    });
    if (!verified) {
      throw new Error(
        'ika Ed25519 output failed Solana verification - hash/scheme mismatch vs chain',
      );
    }
    vtx.addSignature(dwalletPubkey, sigBytes);

    // a Solana tx's "signature" (the id you see on explorers) IS the first signer's signature
    // bytes, base58-encoded. computing it here means we can check `getSignatureStatus(expectedSig)`
    // on broadcast/confirm failure to detect "tx actually landed but the client lost the race"
    // before we trigger a duplicate-send retry that would fail on rent.
    const expectedSig = base58.encode(sigBytes);

    const raw = vtx.serialize();
    const totalElapsedMs = Date.now() - attemptStartMs;
    console.warn('[solana-send-from-dwallet] broadcasting tx', {
      rawTxBytes: raw.length,
      attempt: attempt + 1,
      expectedSig,
      totalElapsedSinceBlockhashMs: totalElapsedMs,
    });

    try {
      const sig = await connection.sendRawTransaction(raw, {
        skipPreflight: false,
        maxRetries: 3,
      });
      console.warn('[solana-send-from-dwallet] sendRawTransaction returned sig', {
        sig,
        attempt: attempt + 1,
        explorerHint: `https://explorer.solana.com/tx/${sig}`,
      });
      try {
        await confirmSolanaTxByPolling(connection, sig, { commitment: 'confirmed' });
        console.warn('[solana-send-from-dwallet] tx CONFIRMED on chain', { sig });
      } catch (confErr) {
        console.warn('[solana-send-from-dwallet] confirmation THREW (tx may still land later)', {
          sig,
          errorMessage: confErr instanceof Error ? confErr.message : String(confErr),
        });
        throw confErr;
      }
      return sig;
    } catch (e) {
      lastError = e;
      const msg = e instanceof Error ? e.message : String(e);

      // CRITICAL: before deciding to retry or surface the error, check whether the tx actually
      // landed on chain anyway. broadcast can throw "blockhash not found" or confirmation can
      // throw "not confirmed after 60s" while the tx is still propagating to the leader and
      // ends up in a block moments later. without this check, a retry triggers, the second
      // attempt's preflight rejects with "insufficient lamports / rent" (the wallet was drained
      // by the actual-landed first send), and the UI surfaces a confusing "Solana RPC rejected"
      // error even though the user's send succeeded. polling for a few seconds is the price of
      // not double-spending or showing a wrong error.
      console.warn('[solana-send-from-dwallet] broadcast/confirm threw; checking if tx landed anyway', {
        expectedSig,
        attempt: attempt + 1,
        originalErrorMessage: msg,
      });
      const landedRes = await pollForSignatureLanded(connection, expectedSig, {
        totalMs: 8_000,
        intervalMs: 1_000,
      });
      if (landedRes.landed) {
        console.warn('[solana-send-from-dwallet] tx ACTUALLY LANDED despite broadcast/confirm error - returning success', {
          expectedSig,
          confirmationStatus: landedRes.confirmationStatus,
          chainErr: landedRes.chainErr,
          slot: landedRes.slot,
          originalErrorMessage: msg,
        });
        if (landedRes.chainErr) {
          // tx landed but with an on-chain error - surface that as the real failure, no retry
          throw new Error(
            `Solana tx ${expectedSig} landed on chain but with an on-chain error: ${JSON.stringify(landedRes.chainErr)}. ` +
              `Original broadcast error: ${msg}`,
          );
        }
        return expectedSig;
      }
      console.warn('[solana-send-from-dwallet] tx did NOT land after 8s post-error poll - proceeding with retry/surface', {
        expectedSig,
        attempt: attempt + 1,
        originalErrorMessage: msg,
      });

      if (isBlockhashExpiredError(msg) && attempt < BLOCKHASH_EXPIRY_MAX_RETRIES) {
        console.warn('[solana-send-from-dwallet] BLOCKHASH EXPIRED during sign cycle - retrying with fresh blockhash', {
          attempt: attempt + 1,
          totalElapsedSinceBlockhashMs: totalElapsedMs,
          remainingRetries: BLOCKHASH_EXPIRY_MAX_RETRIES - attempt,
        });
        continue;
      }
      // not a retryable error, or out of retries - fall through to surface diagnostics + rethrow
      await handleSendRawTransactionError(e, connection, dwalletAddr);
      throw e;
    }
  }
  // shouldn't be reachable since the loop returns or throws, but kept for type narrowing
  throw lastError instanceof Error ? lastError : new Error('solana send: exhausted retries');
}

/** extracted from the inline catch: dig the simulation logs out of a `SendTransactionError`
 * and rewrite the error to include the program-log tail so users see *why* preflight
 * rejected rather than a generic "Simulation failed". */
async function handleSendRawTransactionError(e: unknown, connection: Connection, dwalletAddr: string): Promise<never> {
  const msg = e instanceof Error ? e.message : String(e);
  const errAny = e as {
    logs?: string[];
    getLogs?: (c: Connection) => Promise<string[] | null | undefined>;
  };
  let simLogs: string[] | null = null;
  if (Array.isArray(errAny.logs) && errAny.logs.length > 0) {
    simLogs = errAny.logs;
  } else if (typeof errAny.getLogs === 'function') {
    try {
      const fetched = await errAny.getLogs(connection);
      simLogs = Array.isArray(fetched) && fetched.length > 0 ? fetched : null;
    } catch (logErr) {
      console.warn('[solana-send-from-dwallet] could not fetch sim logs', logErr);
    }
  }
  console.warn('[solana-send-from-dwallet] sendRawTransaction THREW (final)', {
    errorMessage: msg,
    errorName: e instanceof Error ? e.name : 'unknown',
    errorStackPreview: e instanceof Error ? e.stack?.slice(0, 600) : undefined,
    dwalletAddr,
    simulationLogs: simLogs,
  });
  const logsTail = simLogs ? simLogs.slice(-8).join('\n  ') : null;
  if (isBlockhashExpiredError(msg)) {
    throw new Error(
      `Solana broadcast failed after ${BLOCKHASH_EXPIRY_MAX_RETRIES + 1} attempts because every blockhash ` +
        `expired during the ika MPC sign cycle. This dWallet's sign is currently slow enough that ` +
        `blockhash validity (~60-90s) is a tight fit; try again - the signing-key cache is now hot ` +
        `and subsequent sends should be faster. Underlying error: ${msg}`,
    );
  }
  if (msg.includes('Transaction simulation failed') || msg.includes('insufficient') || msg.includes('rent')) {
    throw new Error(
      `Solana RPC rejected the transaction at preflight. dWallet address: ${dwalletAddr}.\n` +
        (logsTail
          ? `Program logs (last 8 lines):\n  ${logsTail}\n`
          : 'No program logs returned (RPC dropped them; check the SW console for raw error).\n') +
        `Common causes: not enough SOL for send + fee (current balance is shown above), recipient ATA ` +
        `can't be created with available rent, or sending an SPL token the dWallet doesn't hold. ` +
        `Underlying error: ${msg}`,
    );
  }
  throw e instanceof Error ? e : new Error(msg);
}

async function recordSolanaSend(signature: string): Promise<void> {
  try {
    const session = getSession();
    if (!session?.activeVaultId) return;
    const { recordSignedTx } = await import('@/background/services/tx-record');
    await recordSignedTx({
      txHash: signature,
      origin: null,
      chainId: session.solanaNetworkId ?? 'sol-mainnet',
      vaultId: session.activeVaultId,
      timestampMs: Date.now(),
      kind: 'sol-send',
    });
  } catch (e) {
    console.warn('[chromatika tx-record] sol-send (from dwallet) origin record failed', e);
  }
}

/**
 * send native SOL from a dWallet's Solana address. lamports must be > 0; the dWallet needs
 * additional SOL at its address to cover the network fee (typically ~5_000 lamports).
 */
export async function sendSolanaNativeFromDwallet(
  dwalletId: string,
  to: string,
  lamports: bigint,
): Promise<string> {
  if (lamports <= 0n) throw new Error('Amount must be positive');
  const s = getSession();
  if (!s) throw new Error('Wallet locked');
  if (!s.dwalletSolanaConnection) {
    throw new Error('Solana RPC not configured for the dWallet tier.');
  }

  const pubkeyBytes = await getDwalletEd25519PublicKeyForDwalletId(dwalletId);
  const dwalletPubkey = new PublicKey(pubkeyBytes);
  const toPubkey = new PublicKey(to.trim());

  // per-send rent-floor check: confirm that AFTER moving `lamports`, the dWallet's Solana
  // address would still hold at least the rent-exempt minimum + fee buffer. without this
  // the on-chain preflight rejects with "Transaction results in an account (0) with
  // insufficient funds for rent" - a confusing error compared to a clear pre-sign message.
  // also avoids wasting ~30-80s of ika MPC sign cycles on a tx that was always doomed.
  const balanceLamports = BigInt(await s.dwalletSolanaConnection.getBalance(dwalletPubkey, 'confirmed'));
  const requiredPostSend = DWALLET_SOL_POST_SEND_RESERVE_LAMPORTS;
  const maxSendable = balanceLamports > requiredPostSend ? balanceLamports - requiredPostSend : 0n;
  console.warn('[solana-send-from-dwallet] native SOL send preflight', {
    dwalletAddr: dwalletPubkey.toBase58(),
    balanceLamports: balanceLamports.toString(),
    requestedSendLamports: lamports.toString(),
    maxSendableLamports: maxSendable.toString(),
    rentExemptFloorLamports: SOLANA_RENT_EXEMPT_MIN_LAMPORTS.toString(),
    feeBufferLamports: TX_FEE_BUFFER_LAMPORTS.toString(),
  });
  if (lamports > maxSendable) {
    const balSol = Number(balanceLamports) / 1_000_000_000;
    const reqSol = Number(lamports) / 1_000_000_000;
    const maxSol = Number(maxSendable) / 1_000_000_000;
    const rentSol = Number(SOLANA_RENT_EXEMPT_MIN_LAMPORTS) / 1_000_000_000;
    throw new Error(
      `Send amount exceeds the dWallet's available SOL after the rent-exempt floor. ` +
        `Balance: ${balSol.toFixed(6)} SOL (${balanceLamports} lamports). ` +
        `Requested: ${reqSol.toFixed(6)} SOL (${lamports} lamports). ` +
        `Max sendable: ${maxSol.toFixed(6)} SOL (${maxSendable} lamports). ` +
        `Solana requires every account to stay above the rent-exempt minimum (~${rentSol.toFixed(6)} SOL) ` +
        `even after the send, plus ~${TX_FEE_BUFFER_LAMPORTS} lamports for the tx fee. ` +
        `Lower the amount to at most ${maxSendable} lamports and retry.`,
    );
  }

  const ix = SystemProgram.transfer({
    fromPubkey: dwalletPubkey,
    toPubkey,
    lamports,
  });

  const sig = await buildSignAndSend(s.dwalletSolanaConnection, dwalletPubkey, dwalletId, [ix]);
  await recordSolanaSend(sig);
  return sig;
}

/**
 * send an SPL token from a dWallet's ATA at its Solana address. auto-creates the recipient's
 * ATA via CreateIdempotent (the dWallet pays the rent if the recipient didn't have one yet).
 */
export async function sendSolanaSplFromDwallet(
  dwalletId: string,
  to: string,
  mint: string,
  amountRaw: bigint,
): Promise<string> {
  if (amountRaw <= 0n) throw new Error('Amount must be positive');
  const s = getSession();
  if (!s) throw new Error('Wallet locked');
  if (!s.dwalletSolanaConnection) {
    throw new Error('Solana RPC not configured for the dWallet tier.');
  }

  const pubkeyBytes = await getDwalletEd25519PublicKeyForDwalletId(dwalletId);
  const dwalletPubkey = new PublicKey(pubkeyBytes);
  const toPubkey = new PublicKey(to.trim());
  const mintPubkey = new PublicKey(mint.trim());

  // SPL preflight: the SPL transfer itself doesn't deduct from the dWallet's SOL balance,
  // but the dWallet must hold enough SOL for: tx fee + post-state rent floor + possible
  // ATA-creation rent (if the destination ATA doesn't exist yet, CreateIdempotent funds it
  // out of the dWallet). conservatively assume the ATA may need creating - if it already
  // exists, we have headroom; if it doesn't, we have exactly what's needed.
  const balanceLamports = BigInt(await s.dwalletSolanaConnection.getBalance(dwalletPubkey, 'confirmed'));
  const splFloor =
    DWALLET_SOL_POST_SEND_RESERVE_LAMPORTS + SPL_ATA_RENT_RESERVE_LAMPORTS;
  console.warn('[solana-send-from-dwallet] SPL send preflight', {
    dwalletAddr: dwalletPubkey.toBase58(),
    mint: mintPubkey.toBase58(),
    balanceLamports: balanceLamports.toString(),
    minRequiredLamports: splFloor.toString(),
    rentExemptFloorLamports: SOLANA_RENT_EXEMPT_MIN_LAMPORTS.toString(),
    feeBufferLamports: TX_FEE_BUFFER_LAMPORTS.toString(),
    splAtaRentReserveLamports: SPL_ATA_RENT_RESERVE_LAMPORTS.toString(),
  });
  if (balanceLamports < splFloor) {
    const balSol = Number(balanceLamports) / 1_000_000_000;
    const reqSol = Number(splFloor) / 1_000_000_000;
    throw new Error(
      `Not enough SOL at the dWallet's Solana address (${dwalletPubkey.toBase58()}) to cover the SPL transfer's gas + ATA rent. ` +
        `Balance: ${balSol.toFixed(6)} SOL. Required: ~${reqSol.toFixed(6)} SOL ` +
        `(tx fee + rent-exempt floor + reserve for creating the recipient's token account if it doesn't exist). ` +
        `Send ~0.005 SOL to that address first and retry.`,
    );
  }

  const sourceAta = getAssociatedTokenAddressSync(mintPubkey, dwalletPubkey);
  const destAta = getAssociatedTokenAddressSync(mintPubkey, toPubkey);

  const instructions: TransactionInstruction[] = [
    createAssociatedTokenAccountIdempotentIx(dwalletPubkey, destAta, toPubkey, mintPubkey),
    splTransferIx(sourceAta, destAta, dwalletPubkey, amountRaw),
  ];

  const sig = await buildSignAndSend(s.dwalletSolanaConnection, dwalletPubkey, dwalletId, instructions);
  await recordSolanaSend(sig);
  return sig;
}

void Keypair; // exported only for future sponsored-fee-payer path
