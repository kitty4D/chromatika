import {
  IkaTransaction,
  createRandomSessionIdentifier,
  prepareDKGAsync,
} from '@ika.xyz/sdk';
import { Transaction } from '@mysten/sui/transactions';
import { getSession } from '@/background/session';
import type { CurveKey } from '@/background/session';
import { requireSuiAndIkaCoins } from '@/background/ika/coins';
import { executeSuiTransaction } from '@/background/sui/execute-transaction';
import { getSuiFeePayerSuiAddress } from '@/background/sui/sui-fee-payer-signing';
import { loadDwalletMeta, saveDwalletMeta } from '@/background/storage-meta';
import { getRequiredCoinAmounts } from '@/background/ika/pricing';
import { pollForSolanaDwalletPda } from '@/background/ika/solana-dwallet-account-read';
import {
  beginOperation,
  updateCurrentOperationStage,
} from '@/background/progress/operation-progress';
import { mergeDwalletMeta, persistVaultFromSession } from '@/background/wallet-service';
import {
  extractEncryptedShareIdFromEvents,
  idsFromEvents,
  normalizeEvents,
  resolveEncryptedShareIdByProbing,
  toCurve,
  u8ToB64,
  type RawEventLike,
} from './internal';
import {
  ensureCurveEncryptionKeyReady,
  registerEncryptionKeyOnChain,
  rotateCurveEncryptionKey,
} from './encryption-key';
import { acceptEncryptedUserShareForCurve } from './accept-share';

/** ika Solana pre-alpha: mock DKG over gRPC (no Sui PTBs). */
async function createDWalletSolanaGrpc(curveKey: CurveKey): Promise<{
  dwalletId?: string;
  phase: string;
}> {
  const s = getSession();
  if (!s?.solanaIkaGrpc) throw new Error('Solana ika gRPC not initialized — unlock vault on Solana ika base');
  if (!s.dwalletSolanaConnection) throw new Error('Solana RPC not configured for ika dWallet network');
  // DKG fires multiple `approve_message` gRPC calls; ensure the in-extension fee account has
  // enough SOL before we start. auto-refills from Seeker if the user opted in (default), or
  // throws `IkaFeesLowError` if the user disabled auto-refill (settings panel handles surfacing
  // the manual top-up CTA).
  const { ensureFeePayerFunded } = await import('@/background/ika/ensure-fee-payer-funded');
  await ensureFeePayerFunded(s);
  await updateCurrentOperationStage('grpc-dkg', 'Requesting DKG attestation from Ika network');
  const curve = curveKey === 'SECP256K1' ? 'Secp256k1' : 'Curve25519';
  const r = await s.solanaIkaGrpc.requestDKG(curve);

  // the gRPC response only proves the network signed an attestation. the on-chain `DWallet` PDA
  // (which `Sign` validators look up) is written separately by the Network Operator Attestation
  // service via `CommitDWallet` (disc 31, NOA-only - users cannot submit it). without polling
  // here the user gets a clean "DKG done!" then a baffling "no key for dwallet" on the first
  // sign. block until the PDA appears so failures land in the create flow with a clearer error.
  await updateCurrentOperationStage(
    'noa-commit',
    'Waiting for Ika network operator to commit dWallet on-chain',
  );
  await pollForSolanaDwalletPda(s.dwalletSolanaConnection, r.dwalletAddrB58, {
    timeoutMs: 60_000,
    intervalMs: 2_000,
    onPoll: (elapsedMs) => {
      // refresh the stage label every tick so the elapsed counter in the banner stays paired
      // with a "still waiting" message - quiet 60s would feel like a hang.
      void updateCurrentOperationStage(
        'noa-commit',
        elapsedMs === 0
          ? 'Waiting for Ika network operator to commit dWallet on-chain'
          : `Waiting for Ika network operator (${Math.round(elapsedMs / 1000)}s)`,
      );
    },
  });

  s.dwalletMeta[curveKey] = {
    baseChain: 'solana',
    dwalletId: r.dwalletAddrB58,
    dwalletPublicKeyB64: r.dwalletPublicKeyB64,
    dwalletAttestationBytesB64: r.dwalletAttestationBytesB64,
  };
  await saveDwalletMeta(s.activeVaultId, s.dwalletMeta);
  await persistVaultFromSession();
  return { dwalletId: r.dwalletAddrB58, phase: 'active' };
}

/**
 * zero-trust dWallet: DKG -> persist share id + public output -> accept encrypted share (tx 2) when possible.
 * requires funded SUI + IKA and a registered encryption key for this curve.
 */
export async function createDWalletForCurve(curveKey: CurveKey): Promise<{
  dwalletId?: string;
  phase: string;
}> {
  const s = getSession();
  if (!s) throw new Error('Wallet locked');
  if (s.activeVaultBaseChain === 'solana') {
    const op = beginOperation(`Creating ${curveKey} dWallet`);
    try {
      const r = await createDWalletSolanaGrpc(curveKey);
      await op.succeed('dWallet created');
      return r;
    } catch (e) {
      await op.fail(e instanceof Error ? e.message : String(e));
      throw e;
    }
  }
  const curve = toCurve(curveKey);
  const meta = await loadDwalletMeta(s.activeVaultId);
  s.dwalletMeta = mergeDwalletMeta(s.dwalletMeta, meta, s.activeVaultBaseChain);
  if (s.dwalletMeta[curveKey]?.registeredEncryptionKey) {
    await ensureCurveEncryptionKeyReady(curveKey);
  } else {
    await registerEncryptionKeyOnChain(curveKey);
  }

  const owner = getSuiFeePayerSuiAddress(s);
  const { ikaAmount, suiAmount } = await getRequiredCoinAmounts(s.ikaClient);
  const { suiCoinId, ikaCoinId } = await requireSuiAndIkaCoins(
    s.suiClient,
    s.ikaClient.ikaConfig,
    owner,
    { minSuiProtocolSplitMist: suiAmount, session: s },
  );
  const networkKey = await s.ikaClient.getLatestNetworkEncryptionKey();
  const sessionBytes = createRandomSessionIdentifier();
  let keys = s.ikaShareKeys[curveKey];
  let dkgInput: Awaited<ReturnType<typeof prepareDKGAsync>>;
  try {
    dkgInput = await prepareDKGAsync(
      s.ikaClient,
      curve,
      keys,
      sessionBytes,
      owner,
    );
  } catch (e) {
    const canRecover =
      curveKey === 'ED25519' &&
      !s.dwalletMeta[curveKey]?.dwalletId &&
      String(e).includes('Invalid typed array length: 32');
    if (!canRecover) throw e;
    // defensive dev-path recovery: rotate ED key material again if legacy bytes are incompatible.
    await rotateCurveEncryptionKey(curveKey, 2);
    await registerEncryptionKeyOnChain(curveKey);
    keys = s.ikaShareKeys[curveKey];
    dkgInput = await prepareDKGAsync(
      s.ikaClient,
      curve,
      keys,
      sessionBytes,
      owner,
    );
  }

  const tx = new Transaction();
  const ikaTx = new IkaTransaction({
    ikaClient: s.ikaClient,
    transaction: tx as never,
    userShareEncryptionKeys: keys,
  });
  const sessionArg = ikaTx.registerSessionIdentifier(sessionBytes);
  const splitIka = tx.splitCoins(tx.object(ikaCoinId), [ikaAmount]);
  const splitSui = tx.splitCoins(tx.object(suiCoinId), [suiAmount]);
  const dkgResult = await ikaTx.requestDWalletDKG({
    dkgRequestInput: dkgInput,
    ikaCoin: splitIka[0],
    suiCoin: splitSui[0],
    sessionIdentifier: sessionArg,
    dwalletNetworkEncryptionKeyId: networkKey.id,
    curve,
  });
  // ika takes coins by &mut ref and returns multiple objects - handle all
  tx.transferObjects([splitIka[0], splitSui[0]], owner);
  if (dkgResult) tx.transferObjects([dkgResult[0]], owner);

  const result = await executeSuiTransaction(s, tx, { include: { effects: true, events: true } });
  if (result.$kind === 'FailedTransaction') {
    const err = result.FailedTransaction.status.error;
    throw new Error(typeof err === 'string' ? err : JSON.stringify(err));
  }

  const rawEvents = normalizeEvents(
    result.Transaction.events as RawEventLike[] | { nodes?: RawEventLike[] } | undefined,
  );

  const evIds = idsFromEvents(rawEvents);
  let dwalletId = s.dwalletMeta[curveKey]?.dwalletId;
  // some network/package upgrade windows can make SDK cap parsing fail even when tx succeeded.
  // treat cap listing as best-effort and rely on emitted event ids as fallback.
  try {
    const caps = await s.ikaClient.getOwnedDWalletCaps(owner, undefined, 50);
    const newest = caps.dWalletCaps[caps.dWalletCaps.length - 1];
    const capDwallet =
      newest && 'dwallet_id' in newest ? String((newest as { dwallet_id: string }).dwallet_id) : undefined;
    if (!dwalletId && capDwallet) dwalletId = capDwallet;
  } catch {
    /* keep going with event/object fallbacks */
  }
  if (!dwalletId && evIds.length) dwalletId = evIds[evIds.length - 1];

  const encId =
    extractEncryptedShareIdFromEvents(rawEvents) ??
    (await resolveEncryptedShareIdByProbing(s.ikaClient, dwalletId ?? '', evIds));

  s.dwalletMeta[curveKey] ??= { baseChain: s.activeVaultBaseChain };
  if (dwalletId) s.dwalletMeta[curveKey]!.dwalletId = dwalletId;
  s.dwalletMeta[curveKey]!.dkgUserPublicOutputB64 = u8ToB64(dkgInput.userPublicOutput);
  if (encId) s.dwalletMeta[curveKey]!.encryptedUserSecretKeyShareId = encId;
  await saveDwalletMeta(s.activeVaultId, s.dwalletMeta);

  if (!dwalletId) {
    return { phase: 'dkg_submitted', dwalletId: undefined };
  }

  const dWallet = await s.ikaClient.getDWallet(dwalletId);
  const kind = (dWallet.state as { $kind: string }).$kind;

  if (kind === 'AwaitingKeyHolderSignature' && encId) {
    try {
      const r = await acceptEncryptedUserShareForCurve(curveKey);
      return { dwalletId: r.dwalletId ?? dwalletId, phase: r.phase };
    } catch {
      return {
        dwalletId,
        phase: 'awaiting_key_holder_signature',
      };
    }
  }

  if (kind === 'AwaitingKeyHolderSignature' && !encId) {
    return {
      dwalletId,
      phase: 'awaiting_key_holder_signature',
    };
  }

  return { dwalletId, phase: kind ?? 'unknown' };
}
