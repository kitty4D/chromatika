import {
  IkaTransaction,
  type ZeroTrustDWallet,
} from '@ika.xyz/sdk';
import { Transaction } from '@mysten/sui/transactions';
import { getSession } from '@/background/session';
import type { CurveKey } from '@/background/session';
import { executeSuiTransaction } from '@/background/sui/execute-transaction';
import { loadDwalletMeta, saveDwalletMeta } from '@/background/storage-meta';
import { discoverDWalletsForVault, listOwnedDWalletCapsForVault } from '@/background/ika/dwallet-discovery';
import {
  fetchSolanaDWalletAccount,
  isSuiIkaDwalletObjectId,
} from '@/background/ika/solana-dwallet-account-read';
import { mergeDwalletMeta } from '@/background/wallet-service';
import { b64ToU8, deepFindAddressByKey, deepFindStringByKey } from './internal';

async function recoverUserPublicOutputFromTx(
  digest: string,
  dwalletId: string,
): Promise<string | undefined> {
  const s = getSession();
  if (!s) return undefined;
  try {
    const tx = await s.suiClient.getTransaction({
      digest,
      include: { events: true },
    });
    if (tx.$kind !== 'Transaction') return undefined;
    const events = (tx.Transaction.events ?? []).map((e) => e.json as unknown);
    for (const ev of events) {
      const evDwalletId = deepFindStringByKey(ev, ['dwallet', 'id']);
      if (typeof evDwalletId === 'string' && evDwalletId !== dwalletId) continue;
      const b64 = deepFindStringByKey(ev, ['user', 'public', 'output']);
      if (b64 && typeof b64 === 'string') return b64;
    }
  } catch {
    /* best-effort recovery */
  }
  return undefined;
}

async function recoverUserPublicOutputForDWallet(
  curveKey: CurveKey,
  dwalletId: string,
): Promise<string | undefined> {
  const s = getSession();
  if (!s) return undefined;
  try {
    const dwObj = await s.suiClient.getObject({
      objectId: dwalletId,
      include: { previousTransaction: true },
    });
    const digest = dwObj.object.previousTransaction;
    if (digest) {
      const fromDwalletTx = await recoverUserPublicOutputFromTx(digest, dwalletId);
      if (fromDwalletTx) return fromDwalletTx;
    }
  } catch {
    /* continue to cap fallback */
  }
  try {
    const caps = await listOwnedDWalletCapsForVault(s.activeVaultId);
    const cap = caps.find((c) => c.curve === curveKey && c.dwalletId === dwalletId);
    if (!cap?.capObjectId || cap.capObjectId === 'unknown') return undefined;
    const capObj = await s.suiClient.getObject({
      objectId: cap.capObjectId,
      include: { previousTransaction: true },
    });
    const digest = capObj.object.previousTransaction;
    if (!digest) return undefined;
    return await recoverUserPublicOutputFromTx(digest, dwalletId);
  } catch {
    return undefined;
  }
}

async function recoverEncryptedShareIdForDWallet(dwalletId: string): Promise<string | undefined> {
  const s = getSession();
  if (!s) return undefined;
  try {
    const d = await s.ikaClient.getDWallet(dwalletId) as {
      encrypted_user_secret_key_shares?: { id?: string };
    };
    const tableId = d.encrypted_user_secret_key_shares?.id;
    if (!tableId || !tableId.startsWith('0x')) return undefined;
    let dfCursor: string | null = null;
    for (;;) {
      const page: {
        hasNextPage: boolean;
        cursor: string | null;
        dynamicFields: Array<{ fieldId?: string; childId?: string }>;
      } = await s.suiClient.listDynamicFields({ parentId: tableId, cursor: dfCursor, limit: 50 });
      for (const f of page.dynamicFields) {
        const candIds = [
          (f as { fieldId?: string }).fieldId,
          (f as { childId?: string }).childId,
        ].filter((x): x is string => typeof x === 'string' && x.startsWith('0x'));
        for (const id of candIds) {
          try {
            const enc = await s.ikaClient.getEncryptedUserSecretKeyShare(id) as { dwallet_id?: string };
            if (enc.dwallet_id === dwalletId) return id;
          } catch {
            /* not an encrypted share id */
          }
        }
      }
      if (!page.hasNextPage || !page.cursor) break;
      dfCursor = page.cursor;
    }
  } catch {
    /* best effort */
  }
  return undefined;
}

async function readDwalletPhaseAfterAccept(
  dwalletId: string,
  encryptedShareId?: string,
): Promise<string> {
  const s = getSession();
  if (!s) return 'unknown';
  for (let i = 0; i < 8; i++) {
    try {
      const d = await s.ikaClient.getDWallet(dwalletId);
      const kind = (d.state as { $kind?: string } | undefined)?.$kind ?? 'unknown';
      if (kind !== 'AwaitingKeyHolderSignature') return kind;
      if (i < 7) await new Promise((r) => setTimeout(r, 1000));
    } catch {
      if (i < 7) await new Promise((r) => setTimeout(r, 1000));
    }
  }
  if (encryptedShareId) {
    try {
      const enc = await s.ikaClient.getEncryptedUserSecretKeyShare(encryptedShareId) as {
        state?: { $kind?: string };
      };
      const encState = enc.state?.$kind;
      if (encState === 'KeyHolderSigned') {
        return 'key_holder_signed_pending_network_verification';
      }
    } catch {
      /* ignore */
    }
  }
  return 'AwaitingKeyHolderSignature';
}

export type AcceptEncryptedUserShareOpts = {
  /** when set, complete zero-trust for this dWallet (must be AwaitingKeyHolderSignature on-chain). */
  dwalletId?: string;
};

/**
 * second zero-trust tx: accept encrypted user share on-chain.
 * uses persisted `encryptedUserSecretKeyShareId` + `dkgUserPublicOutputB64`.
 *
 * if vault meta still points at an older *active* dWallet on the same curve, we re-target any cap
 * that still needs zero-trust completion so the second tx hits the right object.
 */
export async function acceptEncryptedUserShareForCurve(
  curveKey: CurveKey,
  opts?: AcceptEncryptedUserShareOpts,
): Promise<{
  dwalletId?: string;
  phase: string;
}> {
  const s = getSession();
  if (!s) throw new Error('Wallet locked');
  const session = s;
  const loadedMeta = await loadDwalletMeta(session.activeVaultId);
  session.dwalletMeta = mergeDwalletMeta(session.dwalletMeta, loadedMeta, session.activeVaultBaseChain);
  let curveMeta = session.dwalletMeta[curveKey];

  /** Sol ika pre-alpha: mock DKG is one gRPC step, no Sui `acceptEncryptedUserShare` or encrypted share object id. */
  if (session.activeVaultBaseChain === 'solana') {
    const targetId =
      opts?.dwalletId?.trim() || curveMeta?.dwalletId?.trim();
    if (!targetId) {
      throw new Error(`No dWallet id for ${curveKey} on this vault — run DKG first.`);
    }
    if (isSuiIkaDwalletObjectId(targetId)) {
      throw new Error(
        'ika Solana pre-alpha dWallets use Solana account PDAs, not Sui 0x object ids — check vault metadata.',
      );
    }
    const conn = session.dwalletSolanaConnection ?? session.solanaConnection;
    if (!conn) throw new Error('Solana RPC not configured for this vault');
    try {
      const acc = await fetchSolanaDWalletAccount(conn, targetId);
      if (acc.curveKey !== curveKey) {
        throw new Error(
          `Curve mismatch: this dWallet is ${acc.curveKey} on-chain; switch curve or pick another dWallet.`,
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('Curve mismatch')) throw e;
      throw new Error(`Solana dWallet check failed: ${msg}`);
    }
    return { dwalletId: targetId, phase: 'Active' };
  }

  const explicitOpt = opts?.dwalletId?.trim();
  let dwalletId = explicitOpt || curveMeta?.dwalletId;
  let encId = explicitOpt ? undefined : curveMeta?.encryptedUserSecretKeyShareId;
  let outB64 = explicitOpt ? undefined : curveMeta?.dkgUserPublicOutputB64;
  if (!dwalletId) {
    const discovered = await discoverDWalletsForVault(s.activeVaultId, curveKey);
    const pick =
      discovered.find((d) => d.status === 'AwaitingKeyHolderSignature') ?? discovered[0];
    if (pick?.dwalletId) {
      s.dwalletMeta[curveKey] ??= { baseChain: s.activeVaultBaseChain };
      s.dwalletMeta[curveKey]!.dwalletId = pick.dwalletId;
      if (pick.encryptedShareId) {
        s.dwalletMeta[curveKey]!.encryptedUserSecretKeyShareId = pick.encryptedShareId;
      }
      await saveDwalletMeta(s.activeVaultId, s.dwalletMeta);
      curveMeta = s.dwalletMeta[curveKey];
      dwalletId = curveMeta?.dwalletId;
      encId = curveMeta?.encryptedUserSecretKeyShareId;
    }
  }

  const capsViews = await listOwnedDWalletCapsForVault(s.activeVaultId);
  if (!dwalletId) {
    const pick =
      capsViews.find(
        (c) => c.curve === curveKey && c.needsZeroTrustCompletion && c.dwalletId !== 'unknown',
      ) ?? capsViews.find((c) => c.curve === curveKey && c.dwalletId !== 'unknown');
    if (pick?.dwalletId) {
      s.dwalletMeta[curveKey] ??= { baseChain: s.activeVaultBaseChain };
      s.dwalletMeta[curveKey]!.dwalletId = pick.dwalletId;
      if (pick.encryptedShareId) s.dwalletMeta[curveKey]!.encryptedUserSecretKeyShareId = pick.encryptedShareId;
      await saveDwalletMeta(s.activeVaultId, s.dwalletMeta);
      curveMeta = s.dwalletMeta[curveKey];
      dwalletId = curveMeta?.dwalletId;
      encId = curveMeta?.encryptedUserSecretKeyShareId;
    }
  }

  const pendingForCurve = capsViews.filter(
    (c) => c.curve === curveKey && c.needsZeroTrustCompletion && c.dwalletId !== 'unknown',
  );

  async function persistCurveTarget(id: string, shareId?: string) {
    session.dwalletMeta[curveKey] ??= { baseChain: session.activeVaultBaseChain };
    session.dwalletMeta[curveKey]!.dwalletId = id;
    if (shareId) session.dwalletMeta[curveKey]!.encryptedUserSecretKeyShareId = shareId;
    else delete session.dwalletMeta[curveKey]!.encryptedUserSecretKeyShareId;
    delete session.dwalletMeta[curveKey]!.dkgUserPublicOutputB64;
    await saveDwalletMeta(session.activeVaultId, session.dwalletMeta);
    curveMeta = session.dwalletMeta[curveKey];
  }

  if (explicitOpt) {
    const row = pendingForCurve.find((c) => c.dwalletId === explicitOpt);
    if (!row) {
      throw new Error(
        `That dWallet is not listed as needing zero-trust completion for ${curveKey} — refresh caps or pick the matching curve.`,
      );
    }
    dwalletId = explicitOpt;
    encId = row.encryptedShareId;
    outB64 = undefined;
    await persistCurveTarget(dwalletId, encId);
  } else if (dwalletId) {
    let kind: string | undefined;
    let fetchOk = false;
    try {
      const d = await s.ikaClient.getDWallet(dwalletId);
      kind = (d.state as { $kind?: string })?.$kind;
      fetchOk = true;
    } catch {
      kind = undefined;
    }
    if (fetchOk && kind !== 'AwaitingKeyHolderSignature' && pendingForCurve.length > 0) {
      const pick =
        pendingForCurve.find((c) => c.dwalletId === dwalletId) ?? pendingForCurve[0]!;
      dwalletId = pick.dwalletId;
      encId = pick.encryptedShareId;
      outB64 = undefined;
      await persistCurveTarget(dwalletId, encId ?? undefined);
    }
  } else if (pendingForCurve.length > 0) {
    const pick = pendingForCurve[0]!;
    dwalletId = pick.dwalletId;
    encId = pick.encryptedShareId;
    outB64 = undefined;
    await persistCurveTarget(dwalletId, encId ?? undefined);
  }
  if (dwalletId && !encId) {
    try {
      const d = await s.ikaClient.getDWallet(dwalletId);
      const maybe = deepFindAddressByKey(d, ['encrypted', 'share']);
      if (typeof maybe === 'string' && maybe.startsWith('0x')) {
        s.dwalletMeta[curveKey] ??= { baseChain: s.activeVaultBaseChain };
        s.dwalletMeta[curveKey]!.encryptedUserSecretKeyShareId = maybe;
        await saveDwalletMeta(s.activeVaultId, s.dwalletMeta);
        encId = maybe;
      }
    } catch {
      /* keep existing error path below */
    }
  }
  if (dwalletId && encId) {
    try {
      const enc = await s.ikaClient.getEncryptedUserSecretKeyShare(encId) as { dwallet_id?: string };
      if (enc.dwallet_id !== dwalletId) {
        const recovered = await recoverEncryptedShareIdForDWallet(dwalletId);
        if (recovered) {
          s.dwalletMeta[curveKey] ??= { baseChain: s.activeVaultBaseChain };
          s.dwalletMeta[curveKey]!.encryptedUserSecretKeyShareId = recovered;
          await saveDwalletMeta(s.activeVaultId, s.dwalletMeta);
          encId = recovered;
        }
      }
    } catch {
      const recovered = await recoverEncryptedShareIdForDWallet(dwalletId);
      if (recovered) {
        s.dwalletMeta[curveKey] ??= { baseChain: s.activeVaultBaseChain };
        s.dwalletMeta[curveKey]!.encryptedUserSecretKeyShareId = recovered;
        await saveDwalletMeta(s.activeVaultId, s.dwalletMeta);
        encId = recovered;
      }
    }
  }
  if (dwalletId && !encId) {
    const recovered = await recoverEncryptedShareIdForDWallet(dwalletId);
    if (recovered) {
      s.dwalletMeta[curveKey] ??= { baseChain: s.activeVaultBaseChain };
      s.dwalletMeta[curveKey]!.encryptedUserSecretKeyShareId = recovered;
      await saveDwalletMeta(s.activeVaultId, s.dwalletMeta);
      encId = recovered;
    }
  }
  if (dwalletId) {
    // always prefer authoritative user_public_output from the cap creation tx.
    // this prevents stale cached values from causing "user public output mismatch".
    const recovered = await recoverUserPublicOutputForDWallet(curveKey, dwalletId);
    if (recovered) {
      s.dwalletMeta[curveKey] ??= { baseChain: s.activeVaultBaseChain };
      s.dwalletMeta[curveKey]!.dkgUserPublicOutputB64 = recovered;
      await saveDwalletMeta(s.activeVaultId, s.dwalletMeta);
      outB64 = recovered;
    }
  }
  if (!dwalletId) throw new Error('No dWallet id for this curve — run DKG first');
  if (!encId) throw new Error(`Missing encryptedUserSecretKeyShareId — cannot complete zero-trust (dwallet ${dwalletId?.slice(0, 10) ?? 'unknown'}…)`);
  if (!outB64) throw new Error('Missing DKG userPublicOutput — cannot complete zero-trust');

  const keys = s.ikaShareKeys[curveKey];
  const dWallet = await s.ikaClient.getDWallet(dwalletId);
  if (dWallet.kind !== 'zero-trust') {
    throw new Error('acceptEncryptedUserShare requires a zero-trust dWallet');
  }
  const userPublicOutput = b64ToU8(outB64);

  const tx = new Transaction();
  const ikaTx = new IkaTransaction({
    ikaClient: s.ikaClient,
    transaction: tx as never,
    userShareEncryptionKeys: keys,
  });
  await ikaTx.acceptEncryptedUserShare({
    dWallet: dWallet as ZeroTrustDWallet,
    userPublicOutput,
    encryptedUserSecretKeyShareId: encId,
  });

  const result = await executeSuiTransaction(s, tx, { include: { effects: true, events: true } });
  if (result.$kind === 'FailedTransaction') {
    const err = result.FailedTransaction.status.error;
    throw new Error(typeof err === 'string' ? err : JSON.stringify(err));
  }

  const phase = await readDwalletPhaseAfterAccept(dwalletId, encId);
  return { dwalletId, phase };
}

export async function getDWalletState(curveKey: CurveKey) {
  const s = getSession();
  if (!s) throw new Error('Wallet locked');
  const id = s.dwalletMeta[curveKey]?.dwalletId?.trim();
  if (!id) return { curve: curveKey, status: 'none' as const };
  if (s.activeVaultBaseChain === 'solana' && !isSuiIkaDwalletObjectId(id)) {
    const conn = s.dwalletSolanaConnection ?? s.solanaConnection;
    if (!conn) {
      return { curve: curveKey, status: 'error' as const, dwalletId: id, error: 'Solana RPC not configured' };
    }
    try {
      const acc = await fetchSolanaDWalletAccount(conn, id);
      if (acc.curveKey !== curveKey) {
        return {
          curve: curveKey,
          status: 'error' as const,
          dwalletId: id,
          error: `on-chain curve is ${acc.curveKey}, meta curve is ${curveKey}`,
        };
      }
      return { curve: curveKey, status: 'Active' as const, dwalletId: id };
    } catch (e) {
      return { curve: curveKey, status: 'error' as const, dwalletId: id, error: String(e) };
    }
  }
  try {
    const d = await s.ikaClient.getDWallet(id);
    const kind = (d.state as { $kind: string }).$kind;
    return { curve: curveKey, status: kind, dwalletId: id };
  } catch (e) {
    return { curve: curveKey, status: 'error', error: String(e) };
  }
}
