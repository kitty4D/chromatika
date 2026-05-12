import {
  Curve,
  Hash,
  SignatureAlgorithm,
  IkaTransaction,
} from '@ika.xyz/sdk';
import { Transaction } from '@mysten/sui/transactions';
import { getSession } from '@/background/session';
import type { CurveKey } from '@/background/session';
import { allocateIkaCoinsForOperation } from '@/background/ika/coin-allocation';
import { getIkaAdapter } from '@/background/ika/ika-adapter';
import { setSigningProgress } from '@/background/signing-progress';
import { bitcoinMessageBytes } from '../bitcoin';
import { IKA_SOLANA_SECP_SIGNING_IMPLEMENTED } from '@/background/ika/solana-secp-signing';
import { assertNotSolanaBaseForSecpSigning } from '@/background/chains/signing-solana-guard';
import { graphqlUrlForNetwork } from '@/config/sui';
import {
  assertActiveSecpDwallet,
  capIdForDwallet,
  ensureEncryptedShareId,
  resolveSignSessionId,
  runSignWithRetry,
  takePresignWithAutoRefill,
  withTransientSuiReadRetry,
} from './internal';
import { signSecp256k1MessageSolanaGrpc } from './solana-grpc';

/** Bitcoin message signing via ika MPC (secp256k1 + ECDSA + DoubleSHA256 on prefixed message). */
export async function signMessageBtc(messageHex: string) {
  assertNotSolanaBaseForSecpSigning(getSession(), 'btc');
  // presign take is outside runSerializedIkaTx to avoid re-entrant mutex deadlock
  return runSignWithRetry(
    () => takePresignWithAutoRefill('SECP256K1_ECDSA', 'Presign pool empty - auto-refill failed for SECP256K1_ECDSA'),
    (presignId) => signMessageBtcCore(messageHex, presignId),
  );
}

/**
 * sign a BIP143 witness-v0 sighash preimage (raw preimage bytes, ika applies DoubleSHA256 like Bitcoin hash256).
 * used for native BTC spends (not the Bitcoin signed-message envelope).
 *
 * **policy vault dispatch**: when the active vault has a `chromatika_policy::sign_gate`
 * link, this delegates to `signBytesSecpThroughPolicy` with `Hash.DoubleSHA256` (BTC + DeSo
 * use the same hash). the MPC network refuses unless cap + cool-down + non-panicked +
 * actuator checks pass.
 *
 * **hard policy** (preferred for BTC native sends): pass `isBtcTx: true` +
 * `priceMicrosPerSatoshi` to dispatch through `sign_btc_with_policy`, which decodes the
 * preimage's `amount` field on-chain and enforces the cap against the chain-derived value
 * (in sats * price). cap is on input UTXO value (conservative: input >= output, the diff
 * is the fee). lying caller can no longer bypass the cap, the chain enforces.
 *
 * **soft policy** fallback: for DeSo (which also DoubleSHA256s but has a different binary
 * shape), or any path that opts out of `isBtcTx`, the soft `sign_with_policy` runs with
 * caller-declared value. see `chains/deso/deso-send.ts`.
 */
export async function signBitcoinTxSighashPreimage(
  preimage: Uint8Array,
  opts?: {
    /** override for policy-vault dispatch: declared USD value (micro-USD). default 0. */
    declaredValueMicros?: bigint;
    /**
     * when true + `priceMicrosPerSatoshi` set, dispatch through `sign_btc_with_policy`
     * (Move BIP143 decoder, chain-derived value enforcement). when false / unset, the
     * soft `sign_with_policy` runs with `declaredValueMicros`.
     */
    isBtcTx?: boolean;
    /** BTC/USD price as micro-USD per satoshi. required when `isBtcTx === true`. */
    priceMicrosPerSatoshi?: bigint;
  },
) {
  assertNotSolanaBaseForSecpSigning(getSession(), 'btc');
  const { shouldDispatchThroughPolicy, signBytesSecpThroughPolicy } = await import(
    '@/background/policy-vault/policy-vault-sign'
  );
  if (await shouldDispatchThroughPolicy()) {
    const { Hash } = await import('@ika.xyz/sdk');
    return signBytesSecpThroughPolicy({
      message: preimage,
      hashScheme: Hash.DoubleSHA256,
      declaredValueMicros: opts?.declaredValueMicros ?? 0n,
      btcHardPolicy:
        opts?.isBtcTx && opts.priceMicrosPerSatoshi != null
          ? { priceMicrosPerSatoshi: opts.priceMicrosPerSatoshi }
          : undefined,
    });
  }
  return runSignWithRetry(
    () => takePresignWithAutoRefill('SECP256K1_ECDSA', 'Presign pool empty - auto-refill failed for SECP256K1_ECDSA'),
    (presignId) => signBitcoinTxSighashPreimageCore(preimage, presignId),
  );
}

async function signBitcoinTxSighashPreimageCore(
  preimage: Uint8Array,
  presignId: string,
): Promise<{ signature: string; signId: string }> {
  const s = getSession();
  if (!s) throw new Error('Wallet locked');
  const curveKey: CurveKey = 'SECP256K1';
  const adapter = getIkaAdapter(s, s.dwalletMeta[curveKey]?.baseChain ?? 'sui');
  const { dWallet, dwalletId } = await assertActiveSecpDwallet(s, adapter);
  if (IKA_SOLANA_SECP_SIGNING_IMPLEMENTED && s.activeVaultBaseChain === 'solana') {
    void dWallet;
    setSigningProgress('solana-grpc-secp-sign');
    return signSecp256k1MessageSolanaGrpc(preimage, presignId, dwalletId, s, 'DoubleSHA256');
  }
  const encShareId = await ensureEncryptedShareId(s, curveKey, adapter, dwalletId);

  const presign = await adapter.getPresignInParticularState(presignId, 'Completed', {
    timeout: 45_000,
  });
  const encShare = await adapter.getEncryptedUserSecretKeyShare(encShareId);
  const tx = new Transaction();
  const alloc = await allocateIkaCoinsForOperation(s, adapter, tx);
  const capId = await capIdForDwallet(adapter, alloc.owner, dwalletId);

  const keys = s.ikaShareKeys[curveKey];
  const msgBytes = preimage;

  const ikaTx = new IkaTransaction({
    ikaClient: adapter.ikaClient,
    transaction: tx as never,
    userShareEncryptionKeys: keys,
  });
  const messageApproval = await ikaTx.approveMessage({
    dWalletCap: capId,
    curve: Curve.SECP256K1,
    signatureAlgorithm: SignatureAlgorithm.ECDSASecp256k1,
    hashScheme: Hash.DoubleSHA256,
    message: msgBytes,
  });
  const verifiedPresignCap = await ikaTx.verifyPresignCap({ presign: presign as never });
  await ikaTx.requestSign({
    dWallet,
    messageApproval,
    hashScheme: Hash.DoubleSHA256,
    verifiedPresignCap,
    presign: presign as never,
    encryptedUserSecretKeyShare: encShare,
    message: msgBytes,
    signatureScheme: SignatureAlgorithm.ECDSASecp256k1,
    ikaCoin: alloc.ikaCoin,
    suiCoin: alloc.suiCoin,
  });
  alloc.finalize();

  const result = await adapter.executeTx(s, tx);
  if (result.$kind === 'FailedTransaction') {
    const err = result.FailedTransaction.status.error;
    throw new Error(typeof err === 'string' ? err : JSON.stringify(err));
  }

  const T = result.Transaction;
  const signId = await resolveSignSessionId(
    adapter,
    Curve.SECP256K1,
    SignatureAlgorithm.ECDSASecp256k1,
    T.effects,
    T.events,
  );
  if (!signId) throw new Error('Could not resolve Sign session id from transaction effects');

  const sign = await withTransientSuiReadRetry(
    () =>
      adapter.getSignInParticularState(
        signId,
        Curve.SECP256K1,
        SignatureAlgorithm.ECDSASecp256k1,
        'Completed',
        { timeout: 120_000 },
      ),
    { log: { graphqlUrl: graphqlUrlForNetwork(s.network), label: 'getSignInParticularState secp256k1 btc-tx' } },
  );
  if (sign.state.$kind !== 'Completed') {
    throw new Error(`Sign session not completed: ${sign.state.$kind}`);
  }
  const raw = Uint8Array.from(sign.state.Completed.signature);
  const hex = Array.from(raw, (b) => b.toString(16).padStart(2, '0')).join('');
  return { signature: `0x${hex}`, signId };
}

async function signMessageBtcCore(messageHex: string, presignId: string): Promise<{ signature: string; signId: string }> {
  const s = getSession();
  if (!s) throw new Error('Wallet locked');
  const curveKey: CurveKey = 'SECP256K1';
  const adapter = getIkaAdapter(s, s.dwalletMeta[curveKey]?.baseChain ?? 'sui');
  const { dWallet, dwalletId } = await assertActiveSecpDwallet(s, adapter);
  const rawBytes = Uint8Array.from(messageHex.replace(/^0x/i, '').match(/.{1,2}/g)!.map((b) => parseInt(b, 16)));
  const msgBytes = bitcoinMessageBytes(rawBytes);
  if (IKA_SOLANA_SECP_SIGNING_IMPLEMENTED && s.activeVaultBaseChain === 'solana') {
    void dWallet;
    setSigningProgress('solana-grpc-secp-sign');
    return signSecp256k1MessageSolanaGrpc(msgBytes, presignId, dwalletId, s, 'DoubleSHA256');
  }
  const encShareId = await ensureEncryptedShareId(s, curveKey, adapter, dwalletId);

  const presign = await adapter.getPresignInParticularState(presignId, 'Completed', {
    timeout: 45_000,
  });
  const encShare = await adapter.getEncryptedUserSecretKeyShare(encShareId);
  const tx = new Transaction();
  const alloc = await allocateIkaCoinsForOperation(s, adapter, tx);
  const capId = await capIdForDwallet(adapter, alloc.owner, dwalletId);

  const keys = s.ikaShareKeys[curveKey];

  const ikaTx = new IkaTransaction({
    ikaClient: adapter.ikaClient,
    transaction: tx as never,
    userShareEncryptionKeys: keys,
  });
  const messageApproval = await ikaTx.approveMessage({
    dWalletCap: capId,
    curve: Curve.SECP256K1,
    signatureAlgorithm: SignatureAlgorithm.ECDSASecp256k1,
    hashScheme: Hash.DoubleSHA256,
    message: msgBytes,
  });
  const verifiedPresignCap = await ikaTx.verifyPresignCap({ presign: presign as never });
  await ikaTx.requestSign({
    dWallet,
    messageApproval,
    hashScheme: Hash.DoubleSHA256,
    verifiedPresignCap,
    presign: presign as never,
    encryptedUserSecretKeyShare: encShare,
    message: msgBytes,
    signatureScheme: SignatureAlgorithm.ECDSASecp256k1,
    ikaCoin: alloc.ikaCoin,
    suiCoin: alloc.suiCoin,
  });
  alloc.finalize();

  const result = await adapter.executeTx(s, tx);
  if (result.$kind === 'FailedTransaction') {
    const err = result.FailedTransaction.status.error;
    throw new Error(typeof err === 'string' ? err : JSON.stringify(err));
  }

  const T = result.Transaction;
  const signId = await resolveSignSessionId(
    adapter,
    Curve.SECP256K1,
    SignatureAlgorithm.ECDSASecp256k1,
    T.effects,
    T.events,
  );
  if (!signId) throw new Error('Could not resolve Sign session id from transaction effects');

  const sign = await withTransientSuiReadRetry(
    () =>
      adapter.getSignInParticularState(
        signId,
        Curve.SECP256K1,
        SignatureAlgorithm.ECDSASecp256k1,
        'Completed',
        { timeout: 120_000 },
      ),
    { log: { graphqlUrl: graphqlUrlForNetwork(s.network), label: 'getSignInParticularState secp256k1 btc-msg' } },
  );
  if (sign.state.$kind !== 'Completed') {
    throw new Error(`Sign session not completed: ${sign.state.$kind}`);
  }
  const raw = Uint8Array.from(sign.state.Completed.signature);
  const hex = Array.from(raw, (b) => b.toString(16).padStart(2, '0')).join('');
  return { signature: `0x${hex}`, signId };
}
