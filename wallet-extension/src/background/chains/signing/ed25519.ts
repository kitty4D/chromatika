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
    console.warn('[chromatika][ed25519] solana-base sign begin', { dwalletId, messageBytesLen: message.length });
    const op = beginOperation('Signing Solana message');

    const SOLANA_SIGN_MAX_ATTEMPTS = 3;
    const SOLANA_SIGN_BACKOFF_MS = 2_000;
    let lastErr: unknown;

    for (let attempt = 1; attempt <= SOLANA_SIGN_MAX_ATTEMPTS; attempt++) {
      try {
        console.warn(`[chromatika][ed25519] attempt ${attempt}/${SOLANA_SIGN_MAX_ATTEMPTS}: requesting presign`);
        await op.updateStage('grpc-presign', `Requesting Ika presign${attempt > 1 ? ` (attempt ${attempt}/${SOLANA_SIGN_MAX_ATTEMPTS})` : ''}`);
        const t0 = Date.now();
        const { presignIdHex } = await s.solanaIkaGrpc.requestPresign('Curve25519', 'EdDSA');
        console.warn(`[chromatika][ed25519] presign ok in ${Date.now() - t0}ms`, { presignIdHex });
        const t1 = Date.now();
        const result = await signMessageSolSolanaGrpc(message, presignIdHex, dwalletId, s);
        console.warn(`[chromatika][ed25519] sign ok in ${Date.now() - t1}ms`);
        await op.succeed('Signed');
        return result;
      } catch (e) {
        lastErr = e;
        console.warn(`[chromatika][ed25519] attempt ${attempt} failed`, { error: e instanceof Error ? e.message : String(e) });
        if (e instanceof DWalletGoneError) break;
        if (attempt < SOLANA_SIGN_MAX_ATTEMPTS) {
          const backoff = SOLANA_SIGN_BACKOFF_MS * attempt;
          await op.updateStage('retry-backoff', `Attempt ${attempt} failed, retrying in ${backoff / 1000}s...`);
          await new Promise((r) => setTimeout(r, backoff));
        }
      }
    }

    const action: OperationProgressAction | undefined =
      lastErr instanceof DWalletGoneError && lastErr.curve === 'ED25519'
        ? { kind: 'recreate-ed25519-dwallet', label: 'Recreate dWallet', cluster: lastErr.cluster }
        : undefined;
    await op.fail(lastErr instanceof Error ? lastErr.message : String(lastErr), action ? { action } : undefined);
    throw lastErr;
  }

  // Sui-base path: presign-take is outside runSerializedIkaTx to avoid re-entrant mutex deadlock.
  console.warn('[chromatika][ed25519] sui-base sign begin', {
    dwalletId: opts?.ed25519DwalletId?.slice(0, 20) || s.dwalletMeta.ED25519?.dwalletId?.slice(0, 20),
    metaBaseChain: s.dwalletMeta.ED25519?.baseChain,
    vaultBaseChain: s.activeVaultBaseChain,
    network: s.network,
    messageBytesLen: message.length,
  });
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

  const metaBaseChain = s.dwalletMeta[curveKey]?.baseChain;
  const adapterChain = metaBaseChain ?? 'sui';
  console.warn('[chromatika][signMessageSolCore] begin', {
    presignId,
    dwalletId,
    metaBaseChain,
    adapterChain,
    vaultBaseChain: s.activeVaultBaseChain,
    network: s.network,
    graphqlUrl: graphqlUrlForNetwork(s.network),
    messageBytesLen: message.length,
  });

  // Sui-base only, Solana base shortcuts in `signMessageSol`. adapter still picks Sui by default.
  const adapter = getIkaAdapter(s, adapterChain);

  // log ika config to verify correct network packages
  try {
    const cfg = adapter.ikaClient.ikaConfig;
    console.warn('[chromatika][signMessageSolCore] ika config', {
      ikaPackage: cfg.packages?.ikaPackage?.slice(0, 20),
      ikaDwallet2pcMpc: cfg.packages?.ikaDwallet2pcMpcPackage?.slice(0, 20),
    });
  } catch { /* solana adapter throws on ikaClient access */ }

  const dWallet = await adapter.getDWallet(dwalletId);
  if (dWallet.kind !== 'zero-trust') throw new Error('Expected zero-trust ED25519 dWallet');
  const stateKind = (dWallet.state as { $kind: string }).$kind;
  console.warn('[chromatika][signMessageSolCore] dWallet loaded', {
    kind: dWallet.kind,
    state: stateKind,
    curve: dWallet.curve,
  });
  if (stateKind !== 'Active') throw new Error(`ED25519 dWallet must be Active to sign (current: ${stateKind})`);
  const encShareId = await ensureEncryptedShareId(s, curveKey, adapter, dwalletId);
  console.warn('[chromatika][signMessageSolCore] encShareId resolved', { encShareId: encShareId?.slice(0, 20) });

  // diagnostic: read the presign object ONCE (no polling) to see its current state
  try {
    const rawPresign = await adapter.ikaClient.getPresign(presignId);
    const rawState = (rawPresign as { state?: { $kind?: string } }).state;
    console.warn('[chromatika][signMessageSolCore] presign raw state BEFORE polling', {
      presignId: presignId.slice(0, 20),
      stateKind: rawState?.$kind ?? 'unknown',
      curve: (rawPresign as { curve?: unknown }).curve,
      fullState: JSON.stringify(rawState)?.slice(0, 300),
    });
  } catch (diagErr) {
    console.warn('[chromatika][signMessageSolCore] presign diagnostic read FAILED', {
      presignId: presignId.slice(0, 20),
      error: diagErr instanceof Error ? diagErr.message : String(diagErr),
    });
  }

  console.warn('[chromatika][signMessageSolCore] polling presign for Completed (45s timeout)...');
  const t0Presign = Date.now();
  const presign = await adapter.getPresignInParticularState(presignId, 'Completed', {
    timeout: 45_000,
  });
  console.warn(`[chromatika][signMessageSolCore] presign reached Completed in ${Date.now() - t0Presign}ms`);
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
