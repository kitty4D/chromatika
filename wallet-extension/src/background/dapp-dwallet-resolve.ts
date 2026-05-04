import { getSession } from '@/background/session';
import { getPermission } from '@/background/dapp-permissions';
import { resolveDwalletIdentity } from '@/background/dwallet-identity';
import { listOwnedDWalletCapsForVault } from '@/background/ika/dwallet-discovery';

export async function isOwnedActiveSecpDwallet(vaultId: string, dwalletId: string): Promise<boolean> {
  try {
    const caps = await listOwnedDWalletCapsForVault(vaultId);
    const row = caps.find((c) => c.dwalletId === dwalletId && c.curve === 'SECP256K1');
    return !!row && row.status === 'Active';
  } catch {
    return false;
  }
}

/**
 * which SECP256K1 dWallet to use for an EVM dapp: per-site `selectedDwalletId` when valid,
 * else vault meta / first owned cap (via `resolveDwalletIdentity`).
 */
export async function resolveSecpDwalletIdForDapp(origin: string | undefined): Promise<string> {
  const s = getSession();
  if (!s) throw new Error('Wallet locked');
  const vaultId = s.activeVaultId;
  const fromPermission = origin ? (await getPermission(origin))?.selectedDwalletId : undefined;
  if (fromPermission && (await isOwnedActiveSecpDwallet(vaultId, fromPermission))) {
    return fromPermission;
  }
  const fromMeta = s.dwalletMeta.SECP256K1?.dwalletId;
  if (fromMeta && (await isOwnedActiveSecpDwallet(vaultId, fromMeta))) {
    return fromMeta;
  }
  const { dwalletId } = await resolveDwalletIdentity('SECP256K1');
  return dwalletId;
}

/** user-picked id from connect approval, validated against owned active SECP caps. */
export async function resolveSecpDwalletIdForConnect(
  vaultId: string,
  userPickedId: string | undefined,
): Promise<string> {
  if (userPickedId && (await isOwnedActiveSecpDwallet(vaultId, userPickedId))) {
    return userPickedId;
  }
  return resolveSecpDwalletIdForDapp(undefined);
}

export async function isOwnedActiveEd25519Dwallet(vaultId: string, dwalletId: string): Promise<boolean> {
  try {
    const caps = await listOwnedDWalletCapsForVault(vaultId);
    const row = caps.find((c) => c.dwalletId === dwalletId && c.curve === 'ED25519');
    return !!row && row.status === 'Active';
  } catch {
    return false;
  }
}

export async function resolveEd25519DwalletIdForDapp(origin: string | undefined): Promise<string> {
  const s = getSession();
  if (!s) throw new Error('Wallet locked');
  const vaultId = s.activeVaultId;
  const fromPermission = origin ? (await getPermission(origin))?.selectedEd25519DwalletId : undefined;
  if (fromPermission && (await isOwnedActiveEd25519Dwallet(vaultId, fromPermission))) {
    return fromPermission;
  }
  const fromMeta = s.dwalletMeta.ED25519?.dwalletId;
  if (fromMeta && (await isOwnedActiveEd25519Dwallet(vaultId, fromMeta))) {
    return fromMeta;
  }
  const { dwalletId } = await resolveDwalletIdentity('ED25519');
  return dwalletId;
}

export async function resolveEd25519DwalletIdForConnect(
  vaultId: string,
  userPickedId: string | undefined,
): Promise<string> {
  if (userPickedId && (await isOwnedActiveEd25519Dwallet(vaultId, userPickedId))) {
    return userPickedId;
  }
  return resolveEd25519DwalletIdForDapp(undefined);
}
