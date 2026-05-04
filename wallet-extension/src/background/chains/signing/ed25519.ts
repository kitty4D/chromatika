import {
  Curve,
  Hash,
  SignatureAlgorithm,
  IkaTransaction,
  type ZeroTrustDWallet,
} from '@ika.xyz/sdk';
import { Transaction } from '@mysten/sui/transactions';
import { getSession } from '@/background/session';
import type { CurveKey } from '@/background/session';
import { allocateIkaCoinsForOperation } from '@/background/ika/coin-allocation';
import { getIkaAdapter } from '@/background/ika/ika-adapter';
import { graphqlUrlForNetwork } from '@/config/sui';
import { beginOperation, type OperationProgressAction } from '@/background/progress/operation-progress';
import { DWalletGoneError } from '@/background/ika/errors';
import {
  capIdForDwallet,
  ensureEncryptedShareId,
  resolveSignSessionId,
  runSignWithRetry,
  takePresignWithAutoRefill,
  withTransientSuiReadRetry,
} from './internal';
import { signMessageSolSolanaGrpc } from './solana-grpc';

/** Solana / Sui message signing via ika MPC (ed25519 + EDDSA + SHA512). */
export async function signMessageSol(
  message: Uint8Array,
  opts?: { ed25519DwalletId?: string },
) {
  const s = getSession();
  if (!s) throw new Error('Wallet locked');

  // Solana-base ika: do a fresh per-sign Presign over gRPC, then Sign. ed25519 is deterministic
  // per RFC 8032 (no per-signature random nonce), but the validator still requires a Presign
  // session to bind to. upstream `chains/solana/examples/protocols-e2e/main.rs` runs DKG to
  // Presign to Sign for every curve including EdDSA on Curve25519. we use `DWalletRequest::Presign`
  // (the global variant) here, NOT `PresignForDWallet`. the latter is gated to imported ECDSA
  // and rejects Curve25519/EdDSA with "PresignForDWallet is only for imported ECDSA keys", which
  // is why the presign-pool path stays disabled for ED25519. skipping Presign entirely surfaces
  // as "no key for dwallet ... or scheme X incompatible with curve Y" on the next Sign, looks
  // like a wiped dWallet but is actually a missing protocol step. the Sui-base path below still
  // uses the presign-pool-then-sign pattern because `IkaTransaction.requestSign` requires
  // `verifiedPresignCap`.
  if (s.activeVaultBaseChain === 'solana') {
    const curveKey: CurveKey = 'ED25519';
    const dwalletId =
      opts?.ed25519DwalletId?.trim() || s.dwalletMeta[curveKey]?.dwalletId;
    if (!dwalletId) throw new Error('No ED25519 dWallet - create one first');
    if (!s.solanaIkaGrpc) throw new Error('Solana ika gRPC not initialized');
    const op = beginOperation('Signing Solana message');
    try {
      await op.updateStage('grpc-presign', 'Requesting Ika presign');
      const { presignIdHex } = await s.solanaIkaGrpc.requestPresign('Curve25519', 'EdDSA');
      const result = await signMessageSolSolanaGrpc(message, presignIdHex, dwalletId, s);
      await op.succeed('Signed');
      return result;
    } catch (e) {
      const action: OperationProgressAction | undefined =
        e instanceof DWalletGoneError && e.curve === 'ED25519'
          ? { kind: 'recreate-ed25519-dwallet', label: 'Recreate dWallet', cluster: e.cluster }
          : undefined;
      await op.fail(e instanceof Error ? e.message : String(e), action ? { action } : undefined);
      throw e;
    }
  }

  // Sui-base path: presign-take is outside runSerializedIkaTx to avoid re-entrant mutex deadlock.
  const op = beginOperation('Signing message (ika MPC)');
  try {
    const result = await runSignWithRetry(
      () => takePresignWithAutoRefill('ED25519_EDDSA', 'Presign pool empty - auto-refill failed for ED25519_EDDSA'),
      (presignId) => signMessageSolCore(message, presignId, opts?.ed25519DwalletId),
    );
    await op.succeed('Signed');
    return result;
  } catch (e) {
    await op.fail(e instanceof Error ? e.message : String(e));
    throw e;
  }
}

async function signMessageSolCore(
  message: Uint8Array,
  presignId: string,
  ed25519DwalletIdOverride?: string,
): Promise<{ signature: string; signId: string }> {
  const s = getSession();
  if (!s) throw new Error('Wallet locked');
  const curveKey: CurveKey = 'ED25519';
  const dwalletId =
    ed25519DwalletIdOverride?.trim() || s.dwalletMeta[curveKey]?.dwalletId;
  if (!dwalletId) throw new Error('No ED25519 dWallet - create one first');

  // Sui-base only, Solana base shortcuts in `signMessageSol`. adapter still picks Sui by default.
  const adapter = getIkaAdapter(s, s.dwalletMeta[curveKey]?.baseChain ?? 'sui');
  const dWallet = await adapter.getDWallet(dwalletId);
  if (dWallet.kind !== 'zero-trust') throw new Error('Expected zero-trust ED25519 dWallet');
  const stateKind = (dWallet.state as { $kind: string }).$kind;
  if (stateKind !== 'Active') throw new Error(`ED25519 dWallet must be Active to sign (current: ${stateKind})`);
  const encShareId = await ensureEncryptedShareId(s, curveKey, adapter, dwalletId);

  const presign = await adapter.getPresignInParticularState(presignId, 'Completed', {
    timeout: 120_000,
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
    curve: Curve.ED25519,
    signatureAlgorithm: SignatureAlgorithm.EdDSA,
    hashScheme: Hash.SHA512,
    message,
  });
  const verifiedPresignCap = await ikaTx.verifyPresignCap({ presign: presign as never });
  await ikaTx.requestSign({
    dWallet: dWallet as ZeroTrustDWallet,
    messageApproval,
    hashScheme: Hash.SHA512,
    verifiedPresignCap,
    presign: presign as never,
    encryptedUserSecretKeyShare: encShare,
    message,
    signatureScheme: SignatureAlgorithm.EdDSA,
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
    Curve.ED25519,
    SignatureAlgorithm.EdDSA,
    T.effects,
    T.events,
  );
  if (!signId) throw new Error('Could not resolve Sign session id from transaction effects');

  const sign = await withTransientSuiReadRetry(
    () =>
      adapter.getSignInParticularState(
        signId,
        Curve.ED25519,
        SignatureAlgorithm.EdDSA,
        'Completed',
        { timeout: 120_000 },
      ),
    { log: { graphqlUrl: graphqlUrlForNetwork(s.network), label: 'getSignInParticularState ed25519 sol' } },
  );
  if (sign.state.$kind !== 'Completed') {
    throw new Error(`Sign session not completed: ${sign.state.$kind}`);
  }
  const raw = Uint8Array.from(sign.state.Completed.signature);
  const hex = Array.from(raw, (b) => b.toString(16).padStart(2, '0')).join('');
  return { signature: `0x${hex}`, signId };
}
