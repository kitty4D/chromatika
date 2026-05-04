import { getSession, type CurveKey } from '@/background/session';
import { listOwnedDWalletCapsForVault } from '@/background/ika/dwallet-discovery';
import { saveDwalletMeta } from '@/background/storage-meta';
import { isSuiIkaDwalletObjectId } from '@/background/ika/solana-dwallet-account-read';

export type ResolvedDwalletIdentity = {
  curve: CurveKey;
  dwalletId: string;
  status: string;
};

export async function resolveDwalletIdentity(curve: CurveKey): Promise<ResolvedDwalletIdentity> {
  const s = getSession();
  if (!s) throw new Error('Wallet locked');
  const vaultId = s.activeVaultId;
  const localId = s.dwalletMeta[curve]?.dwalletId;
  if (localId) {
    return { curve, dwalletId: localId, status: 'local' };
  }
  const caps = await listOwnedDWalletCapsForVault(vaultId);
  const row = caps.find((x) => x.curve === curve && x.dwalletId !== 'unknown');
  if (!row) throw new Error(`No ${curve} dWallet found`);

  const inferredBase: 'sui' | 'solana' =
    row.dwalletId && !isSuiIkaDwalletObjectId(row.dwalletId) ? 'solana' : s.activeVaultBaseChain;
  s.dwalletMeta[curve] = {
    baseChain: inferredBase,
    ...(s.dwalletMeta[curve] ?? {}),
    dwalletId: row.dwalletId,
  };
  await saveDwalletMeta(vaultId, s.dwalletMeta);
  return { curve, dwalletId: row.dwalletId, status: row.status };
}
