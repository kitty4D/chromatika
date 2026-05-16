import { blake2b } from '@noble/hashes/blake2.js';
import * as ed25519 from '@noble/ed25519';
import { toBase64 } from '@mysten/sui/utils';
import { messageWithIntent, toSerializedSignature } from '@mysten/sui/cryptography';
import { Ed25519PublicKey } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { verifyTransactionSignature } from '@mysten/sui/verify';
import { resolveCanonicalSuiReceiveAddress } from '@/background/identity';
import { getSession, type SessionState } from '@/background/session';
import { signMessageSol } from '@/background/chains/signing';
import {
  getDwalletEd25519PublicKey,
  getDwalletEd25519PublicKeyForDwalletId,
} from '@/background/chains/solana';
import { dryRunSuiTransaction } from '@/background/sui/sui-simulation';
import { friendlySuiExecutionError } from '@/background/sui/execute-transaction';

function hexSigToBytes(hex: string): Uint8Array {
  const h = hex.replace(/^0x/i, '');
  if (h.length !== 128) throw new Error('expected 64-byte Ed25519 signature (hex)');
  return Uint8Array.from(h.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)));
}

/** accept wallet-standard style `{ transaction }` or raw bytes / base64 / JSON string. */
export function parseSuiDappTransactionPayload(first: unknown): Transaction {
  let inner: unknown = first;
  if (inner && typeof inner === 'object' && 'transaction' in (inner as object)) {
    inner = (inner as { transaction: unknown }).transaction;
  }
  if (inner instanceof Uint8Array) {
    return Transaction.from(inner);
  }
  if (Array.isArray(inner)) {
    return Transaction.from(Uint8Array.from(inner));
  }
  if (typeof inner === 'string') {
    return Transaction.from(inner);
  }
  if (inner && typeof inner === 'object') {
    return Transaction.from(JSON.stringify(inner));
  }
  throw new Error('unsupported Sui transaction payload');
}

export async function resolveSuiDappSenderAddress(opts?: { ed25519DwalletId?: string }): Promise<string> {
  const s = getSession();
  if (!s) throw new Error('Wallet locked');
  if (!opts?.ed25519DwalletId) {
    const { address } = await resolveCanonicalSuiReceiveAddress(s);
    return address;
  }
  const pubBytes = await getDwalletEd25519PublicKeyForDwalletId(opts.ed25519DwalletId);
  return new Ed25519PublicKey(pubBytes).toSuiAddress();
}

export async function buildDappSuiTransaction(
  tx: Transaction,
  opts?: { ed25519DwalletId?: string },
): Promise<Uint8Array> {
  const s = getSession();
  if (!s) throw new Error('Wallet locked');
  const address = await resolveSuiDappSenderAddress(opts);
  tx.setSenderIfNotSet(address);
  return tx.build({ client: s.suiClient });
}

/**
 * signs built transaction bytes with the ED25519 dWallet (ika), using the same intent + BLAKE2b
 * preimage as Mysten `Signer.signTransaction`.
 */
export async function signBuiltSuiTransactionBytes(
  transactionBytes: Uint8Array,
  opts?: { ed25519DwalletId?: string },
): Promise<{
  signature: string;
  bytes: string;
}> {
  const s = getSession();
  if (!s) throw new Error('Wallet locked');
  const edId = opts?.ed25519DwalletId;
  const address = await resolveSuiDappSenderAddress(edId ? { ed25519DwalletId: edId } : undefined);

  const intentMessage = messageWithIntent('TransactionData', transactionBytes);
  const digest = blake2b(intentMessage, { dkLen: 32 });
  const { signature: mpcHex } = await signMessageSol(digest, edId ? { ed25519DwalletId: edId } : undefined);
  const sigBytes = hexSigToBytes(mpcHex);
  const pubBytes = edId
    ? await getDwalletEd25519PublicKeyForDwalletId(edId)
    : await getDwalletEd25519PublicKey();
  const pub = new Ed25519PublicKey(pubBytes);
  const serialized = toSerializedSignature({
    signature: sigBytes,
    signatureScheme: 'ED25519',
    publicKey: pub,
  });

  // ---- DIAGNOSTIC LOGGING for "Invalid signature" debug ----
  const _toHex = (u: Uint8Array): string => Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');
  let localEd25519Verify: boolean | string = 'not run';
  try {
    localEd25519Verify = await ed25519.verify(sigBytes, digest, pubBytes);
  } catch (e) {
    localEd25519Verify = `threw: ${e instanceof Error ? e.message : String(e)}`;
  }
  console.warn('[sui-dapp-tx] pre-verify diag', {
    edId,
    address,
    addressDerivedFromPub: new Ed25519PublicKey(pubBytes).toSuiAddress(),
    addressesMatch: address === new Ed25519PublicKey(pubBytes).toSuiAddress(),
    digestHex: '0x' + _toHex(digest),
    sigHex: '0x' + _toHex(sigBytes),
    pubHex: '0x' + _toHex(pubBytes),
    sigLen: sigBytes.length,
    pubLen: pubBytes.length,
    serializedSigLen: serialized.length,
    localEd25519Verify,
  });
  // ----------------------------------------------------------

  const txCopy = new Uint8Array(transactionBytes);
  try {
    await verifyTransactionSignature(txCopy, serialized, { address });
  } catch (verifyErr) {
    console.warn('[sui-dapp-tx] verifyTransactionSignature THREW', {
      errorMessage: verifyErr instanceof Error ? verifyErr.message : String(verifyErr),
      errorName: verifyErr instanceof Error ? verifyErr.name : 'unknown',
      errorStack: verifyErr instanceof Error ? verifyErr.stack?.slice(0, 600) : undefined,
      txBytesLen: txCopy.length,
      address,
      localEd25519Verify,
    });
    throw verifyErr;
  }

  return { signature: serialized, bytes: toBase64(transactionBytes) };
}

export async function executeDappSuiSignedTransaction(
  tx: Transaction,
  transactionBytes: Uint8Array,
  signature: string,
): Promise<Awaited<ReturnType<SessionState['suiClient']['executeTransaction']>>> {
  const s = getSession();
  if (!s) throw new Error('Wallet locked');
  const dry = await dryRunSuiTransaction(s, tx, { checksEnabled: true });
  if (!dry.ok) {
    throw friendlySuiExecutionError(new Error(dry.summaryLines.join(' ')));
  }
  try {
    return await s.suiClient.executeTransaction({
      transaction: transactionBytes,
      signatures: [signature],
      include: { transaction: true, effects: true, balanceChanges: true },
    });
  } catch (e) {
    throw friendlySuiExecutionError(e);
  }
}
