/**
 * shared helpers extracted from `wallet-service.ts` so per-method onboarding modules
 * (passkey, waap, lazor, hardware, private-key, dwallet-anchored) can call them without
 * importing back through wallet-service (which would create an import cycle).
 *
 *   - `defaultSuiNetworkForNewVault`: small constant-ish helper, the default Sui network
 *     a freshly-created vault lands on until the user edits the per-vault dWallet tier.
 *   - `kickDiscoveryForVault`: fire-and-forget post-add side effect that triggers ika
 *     dWallet discovery on both curves. used by every "add vault" path so the new vault's
 *     dWallets show up in the UI without a manual refresh.
 *   - `persistVaultFromSession`: re-encrypt the in-memory session into the vault blob using
 *     the in-session credential (no password required). called before any read-modify-write
 *     of the encrypted payload from a different code path so live edits to dwalletMeta /
 *     ikaShareKeysB64 / label are not lost. wallet-service.ts re-exports this for external
 *     callers (dwallet-discovery, dkg, encryption-key, accept-share).
 */

import { getSession, setSession } from '@/background/session';
import {
  loadVaultPayloadWithKey,
  maybePersistIkaKeyUpdates,
  storeEncryptedPayloadWithKey,
  type VaultCredential,
} from '@/background/vault-store';
import type { VaultPayloadV3, VaultRecord } from '@/background/vault-types';
import { getDwalletNetworkSettings } from '@/background/network/tier-network-settings';
import { registrySuiIdToSuiNetworkId, type SuiNetworkId } from '@/config/sui';
import { sessionStateFromRecord } from '@/background/vault-session-builder';
import { clearUnlockCache, writeUnlockCache } from '@/background/session-state';
import {
  buildPasskeyPrfEnvelope,
  buildPasswordEnvelope,
  buildRecoveryWordsEnvelope,
  buildWalletSignatureEnvelope,
} from '@/background/vault-store';

/** envelope union for `createInitialVaultBlobV4` builder, narrow alias for ergonomics. */
export type VaultEnvelopeForCreate =
  | Awaited<ReturnType<typeof buildPasswordEnvelope>>
  | Awaited<ReturnType<typeof buildPasskeyPrfEnvelope>>
  | Awaited<ReturnType<typeof buildWalletSignatureEnvelope>>
  | Awaited<ReturnType<typeof buildRecoveryWordsEnvelope>>;

/** new HD vaults default to mainnet ika Sui until per-vault dWallet tier is edited. */
export function defaultSuiNetworkForNewVault(): SuiNetworkId {
  return 'mainnet';
}

export function kickDiscoveryForVault(vaultId: string): void {
  void import('@/background/ika/dwallet-discovery')
    .then(async (m) => {
      try {
        const d1 = await m.discoverDWalletsForVault(vaultId, 'SECP256K1');
        const d2 = await m.discoverDWalletsForVault(vaultId, 'ED25519');
        await m.mergeDiscoveredDWallets(vaultId, 'SECP256K1', d1);
        await m.mergeDiscoveredDWallets(vaultId, 'ED25519', d2);
      } catch {
        /* non-blocking */
      }
    })
    .catch(() => {});
}

/**
 * shared post-unlock + post-create-with-unlock work. builds the session state for the active
 * vault, persists any drifted ika share keys back into the blob, writes the unlock cache, and
 * fires discovery. used by every unlock entry-point (password / passkey / waap / recovery)
 * AND by the per-method create paths that auto-unlock the freshly-created blob (passkey,
 * waap, lazor) so the user doesn't have to re-tap or re-type immediately after onboarding.
 */
export async function finalizeUnlock(
  r: { keyBytes: Uint8Array; key: CryptoKey; kdfMeta: VaultCredential['kdfMeta']; payload: VaultPayloadV3 },
  autoLockMinutes?: number,
): Promise<void> {
  try {
    const cred: VaultCredential = { key: r.key, kdfMeta: r.kdfMeta };
    let payload = r.payload;
    if (!payload.vaults.length) throw new Error('No vaults');
    let activeId = payload.activeVaultId;
    if (!activeId || !payload.vaults.some((v) => v.id === activeId)) {
      activeId = payload.vaults[0]!.id;
      payload.activeVaultId = activeId;
      await storeEncryptedPayloadWithKey(cred, payload);
    }
    const record = payload.vaults.find((v) => v.id === activeId)!;

    const s = await sessionStateFromRecord(record, cred);
    const updated = await maybePersistIkaKeyUpdates(cred, payload, record, s.ikaShareKeysB64);
    if (updated !== payload) payload = updated;

    setSession(s);
    if (autoLockMinutes && autoLockMinutes > 0) {
      await writeUnlockCache(r.keyBytes, r.kdfMeta, autoLockMinutes);
    } else {
      await clearUnlockCache();
    }
    void kickDiscoveryForVault(record.id);
  } finally {
    r.keyBytes.fill(0);
  }
}

export async function persistVaultFromSession(): Promise<void> {
  const s = getSession();
  if (!s) throw new Error('Locked');
  const cred: VaultCredential = { key: s.vaultKey, kdfMeta: s.vaultKdfMeta };
  const payload = await loadVaultPayloadWithKey(cred.key);
  const idx = payload.vaults.findIndex((v) => v.id === s.activeVaultId);
  if (idx === -1) throw new Error('Active vault missing from storage');
  const dNet = await getDwalletNetworkSettings(s.activeVaultId, {
    network: s.network,
    baseChain: s.activeVaultBaseChain,
  });
  const prev = payload.vaults[idx]!;
  payload.vaults[idx] = {
    ...prev,
    network: registrySuiIdToSuiNetworkId(dNet.suiNetworkId),
    ikaShareKeysB64: s.ikaShareKeysB64,
    dwalletMeta: s.dwalletMeta,
    label: s.activeVaultLabel,
    baseChain: s.activeVaultBaseChain,
    ...(prev.accountKind === 'hd' ? { mnemonic: s.mnemonic } : {}),
    ...(s.vaultPersistSecrets?.suiPrivateKeyBech32
      ? { suiPrivateKeyBech32: s.vaultPersistSecrets.suiPrivateKeyBech32 }
      : {}),
    ...(s.vaultPersistSecrets?.solanaSecretKeyB64
      ? { solanaSecretKeyB64: s.vaultPersistSecrets.solanaSecretKeyB64 }
      : {}),
  } as VaultRecord;
  payload.activeVaultId = s.activeVaultId;
  await storeEncryptedPayloadWithKey(cred, payload);
}
