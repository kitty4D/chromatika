/**
 * high-level DeSo flows: send DeSo, submit a post, fetch balance.
 *
 * pipeline (matches `wallet-extension/docs/DESO_SPIKE.md` "Sign-bytes derivation"):
 *   1. compose unsigned tx via `/api/v0/send-deso` or `/api/v0/submit-post`. returns `TransactionHex`
 *      ending in `00` (empty signature length placeholder).
 *   2. pass the raw bytes (hex to bytes) to `signBitcoinTxSighashPreimage`, ika applies
 *      DoubleSHA256 internally (= sha256(sha256(...)) which is what DeSo expects).
 *   3. ika returns r||s as 128-char hex.
 *   4. recover the recovery byte by trying 0..3 against the active dWallet's compressed pubkey.
 *   5. wrap r||s as DeSo-flavored DER (SEQUENCE tag mutation = `0x30 + 1 + recoveryId`).
 *   6. splice into TransactionHex (drop trailing `00`, append `<sigLenVarint><DER>`).
 *   7. POST signed hex to `/api/v0/submit-transaction`. returns the on-chain txn hash.
 *   8. persist into the chromatika tx-record store (kind: `'deso-send'` or `'deso-post'`).
 */

import { signBitcoinTxSighashPreimage } from '@/background/chains/signing';
import { getSession } from '@/background/session';
import { getDwalletSecpPublicKey } from '@/background/chains/bitcoin';
import {
  constructSendDeSo,
  constructSubmitPost,
  getUsersStateless,
  submitTransaction,
} from '@/background/chains/deso/deso-node-client';
import {
  bytesToHex,
  findRecoveryId,
  hexToBytes,
  sha256x2,
  spliceSignatureIntoTransactionHex,
  wrapEcdsaForDeSo,
} from '@/background/chains/deso/deso-signature';
import { getEffectiveDeSoSendIdentity } from '@/background/chains/deso/deso-derived';

export class DeSoError extends Error {
  constructor(
    readonly reason:
      | 'wallet-locked'
      | 'wrong-base-chain'
      | 'no-dwallet'
      | 'protocol-error'
      | 'bad-signature'
      | 'recovery-failed',
    message: string,
  ) {
    super(`[deso/${reason}] ${message}`);
    this.name = 'DeSoError';
  }
}

/**
 * get the active vault's DeSo identity (compressed SECP pubkey + base58check address).
 *
 * when NO delegation is active: chromatika's existing SECP dWallet IS the DeSo identity (the
 * brainstorm's "no new key material" promise, same key, derived BC1Y... address).
 *
 * when a delegation is active (via Identity /derive flow): the EFFECTIVE on-chain identity is
 * the OWNER's pubkey. the dWallet pubkey is the *derived* key, used to sign txs the chain
 * accepts on behalf of the owner. UI surfaces this difference via `isDelegated`.
 */
export async function getDeSoIdentity(): Promise<{
  compressedPubkey: Uint8Array;
  publicKeyBase58Check: string;
  derivedPubkeyBase58Check: string;
  isDelegated: boolean;
  ownerPubkeyBase58Check?: string;
  expirationBlock?: number;
}> {
  const s = getSession();
  if (!s) throw new DeSoError('wallet-locked', 'unlock the wallet to read DeSo identity');
  const eff = await getEffectiveDeSoSendIdentity();
  return {
    compressedPubkey: eff.signingCompressedPubkey,
    publicKeyBase58Check: eff.sendAsPubkeyBase58Check,
    derivedPubkeyBase58Check: eff.signingPubkeyBase58Check,
    isDelegated: eff.isDelegated,
    ownerPubkeyBase58Check: eff.ownerPubkeyBase58Check,
    expirationBlock: eff.expirationBlock,
  };
}

/**
 * sign + submit a DeSo transaction whose unsigned form is already constructed. shared by
 * `sendDeSoNative` and `submitDeSoPost`.
 *
 * `declaredValueMicros` flows through to the policy-vault soft path. sends pass the USD
 * value of `amountNanos`, posts pass 0n.
 *
 * hard-policy mode: when `priceMicrosPerDeso > 0n` AND the active vault has a PolicyVault
 * link, dispatches through `sign_deso_with_policy` (Move v0 binary decoder). the chain
 * sums TxOutputs.AmountNanos and enforces the cap on chain-derived value, not the
 * caller's claim. falls back to soft-policy path if the price wasn't resolved (price
 * fetch failure / non-send paths like `submitDeSoPost`).
 */
async function signAndSubmitDeSoTransactionHex(
  unsignedHex: string,
  opts?: {
    declaredValueMicros?: bigint;
    /** DESO/USD price as micro-USD per DESO (e.g. $30 -> 30_000_000n). */
    priceMicrosPerDeso?: bigint;
  },
): Promise<{ txnHashHex: string; signedHex: string }> {
  const txBytes = hexToBytes(unsignedHex);

  // ika SECP signing: applies DoubleSHA256 internally, returns r||s compact hex.
  // three paths:
  //   1. policy + hard-DeSo mode: route through signBytesSecpThroughPolicy with
  //      desoHardPolicy set so the Move parser enforces cap on output sum.
  //   2. policy + soft mode (post-only or price resolution failed): existing
  //      signBitcoinTxSighashPreimage path with caller-declared value.
  //   3. no policy link: legacy direct signBitcoinTxSighashPreimage.
  const useDesoHardPolicy =
    opts?.priceMicrosPerDeso != null && opts.priceMicrosPerDeso > 0n;
  let sigHex: string;
  if (useDesoHardPolicy) {
    const { shouldDispatchThroughPolicy, signBytesSecpThroughPolicy } = await import(
      '@/background/policy-vault/policy-vault-sign'
    );
    if (await shouldDispatchThroughPolicy()) {
      const { Hash } = await import('@ika.xyz/sdk');
      const out = await signBytesSecpThroughPolicy({
        message: txBytes,
        hashScheme: Hash.DoubleSHA256,
        declaredValueMicros: opts!.declaredValueMicros ?? 0n,
        desoHardPolicy: { priceMicrosPerDeso: opts!.priceMicrosPerDeso! },
      });
      sigHex = out.signature;
    } else {
      // policy not opted in: fall back to direct signing path.
      const out = await signBitcoinTxSighashPreimage(txBytes, {
        declaredValueMicros: opts?.declaredValueMicros ?? 0n,
      });
      sigHex = out.signature;
    }
  } else {
    const out = await signBitcoinTxSighashPreimage(txBytes, {
      declaredValueMicros: opts?.declaredValueMicros ?? 0n,
    });
    sigHex = out.signature;
  }
  const sigBytes = hexToBytes(sigHex.replace(/^0x/, ''));
  if (sigBytes.length !== 64) {
    throw new DeSoError('bad-signature', `expected 64-byte ECDSA signature, got ${sigBytes.length}`);
  }
  const r = sigBytes.subarray(0, 32);
  const s = sigBytes.subarray(32, 64);

  // the digest DeSo's verifier reproduces from the unsigned bytes (incl. trailing `00`).
  const digest = sha256x2(txBytes);

  // find the recovery byte that recovers our dWallet's compressed pubkey.
  const expectedPubkey = await getDwalletSecpPublicKey();
  const recoveryId = findRecoveryId({ r, s, digest, expectedCompressedPubkey: expectedPubkey });
  if (recoveryId === null) {
    throw new DeSoError(
      'recovery-failed',
      'no recovery byte (0..3) recovered the active dWallet pubkey from this signature, ika output may be malformed',
    );
  }

  // wrap as DeSo-flavored DER (recovery-byte SEQUENCE tag mutation) + splice into TransactionHex.
  const wrapped = wrapEcdsaForDeSo({ r, s, recoveryId });
  const signedHex = spliceSignatureIntoTransactionHex(unsignedHex, wrapped);

  // submit to the node.
  const submitRes = await submitTransaction(signedHex);
  const txnHashHex = submitRes.TxnHashHex;
  if (!txnHashHex) {
    throw new DeSoError(
      'protocol-error',
      `submit-transaction returned no TxnHashHex (raw=${JSON.stringify(submitRes).slice(0, 200)})`,
    );
  }
  void bytesToHex; // referenced for diagnostic-helper consumers
  return { txnHashHex, signedHex };
}

/**
 * send native DESO from the active dWallet to a recipient (base58check pubkey or `@username`).
 * returns the on-chain txn hash (`TxnHashHex`). records into `chromatika_signed_txs_v1` so the
 * activity feed picks up the send.
 */
export async function sendDeSoNative(args: {
  recipient: string;
  amountNanos: bigint;
  minFeeRateNanosPerKB?: number;
}): Promise<{ txnHashHex: string }> {
  const session = getSession();
  if (!session?.activeVaultId) {
    throw new DeSoError('wallet-locked', 'unlock the wallet to send DESO');
  }
  if (args.amountNanos <= 0n) {
    throw new DeSoError('protocol-error', 'amount must be positive');
  }
  const identity = await getDeSoIdentity();
  const construct = await constructSendDeSo({
    senderPublicKeyBase58Check: identity.publicKeyBase58Check,
    recipientPublicKeyOrUsername: args.recipient,
    amountNanos: args.amountNanos,
    minFeeRateNanosPerKB: args.minFeeRateNanosPerKB,
  });
  if (!construct.TransactionHex) {
    throw new DeSoError('protocol-error', 'send-deso returned no TransactionHex');
  }
  // resolve declared USD value for policy-vault dispatch (no-op when not opted in).
  // hard-policy: also resolve DESO/USD as micro-USD per DESO so the Move parser can
  // sum TxOutputs.AmountNanos and enforce cap on chain-derived value.
  const { resolveDeSoDeclaredValueMicros, resolveDeSoPriceMicrosPerDeso } = await import(
    '@/background/policy-vault/policy-vault-deso-value'
  );
  const declaredValueMicros = await resolveDeSoDeclaredValueMicros(args.amountNanos);
  const priceMicrosPerDeso = await resolveDeSoPriceMicrosPerDeso();
  const { txnHashHex } = await signAndSubmitDeSoTransactionHex(construct.TransactionHex, {
    declaredValueMicros,
    priceMicrosPerDeso,
  });

  // tx-record so the activity feed picks this up. origin null = wallet-ui-initiated.
  try {
    const { recordSignedTx } = await import('@/background/services/tx-record');
    await recordSignedTx({
      txHash: txnHashHex,
      origin: null,
      chainId: 'deso-mainnet',
      vaultId: session.activeVaultId,
      timestampMs: Date.now(),
      kind: 'deso-send',
    });
  } catch (e) {
    console.warn('[chromatika tx-record] deso-send origin record failed', e);
  }

  return { txnHashHex };
}

/**
 * publish a text post via `/api/v0/submit-post`. returns the on-chain txn hash. same signing
 * pipeline as send-DeSo.
 */
export async function submitDeSoPost(args: {
  body: string;
  imageUrls?: string[];
  videoUrls?: string[];
  minFeeRateNanosPerKB?: number;
}): Promise<{ txnHashHex: string }> {
  const session = getSession();
  if (!session?.activeVaultId) {
    throw new DeSoError('wallet-locked', 'unlock the wallet to publish a DeSo post');
  }
  if (!args.body || args.body.trim().length === 0) {
    throw new DeSoError('protocol-error', 'post body cannot be empty');
  }
  const identity = await getDeSoIdentity();
  const construct = await constructSubmitPost({
    updaterPublicKeyBase58Check: identity.publicKeyBase58Check,
    body: args.body,
    imageUrls: args.imageUrls,
    videoUrls: args.videoUrls,
    minFeeRateNanosPerKB: args.minFeeRateNanosPerKB,
  });
  if (!construct.TransactionHex) {
    throw new DeSoError('protocol-error', 'submit-post returned no TransactionHex');
  }
  const { txnHashHex } = await signAndSubmitDeSoTransactionHex(construct.TransactionHex);

  try {
    const { recordSignedTx } = await import('@/background/services/tx-record');
    await recordSignedTx({
      txHash: txnHashHex,
      origin: null,
      chainId: 'deso-mainnet',
      vaultId: session.activeVaultId,
      timestampMs: Date.now(),
      kind: 'deso-post',
    });
  } catch (e) {
    console.warn('[chromatika tx-record] deso-post origin record failed', e);
  }

  return { txnHashHex };
}

/** fetch the active vault's DESO balance in nanos (1 DESO = 10^9 nanos). */
export async function getDeSoBalance(): Promise<{
  publicKeyBase58Check: string;
  balanceNanos: bigint;
  username: string | null;
}> {
  const identity = await getDeSoIdentity();
  const res = await getUsersStateless([identity.publicKeyBase58Check]);
  const user = res.UserList?.[0];
  if (!user) {
    return { publicKeyBase58Check: identity.publicKeyBase58Check, balanceNanos: 0n, username: null };
  }
  return {
    publicKeyBase58Check: identity.publicKeyBase58Check,
    balanceNanos: BigInt(user.BalanceNanos ?? 0),
    username: user.ProfileEntryResponse?.Username ?? null,
  };
}
