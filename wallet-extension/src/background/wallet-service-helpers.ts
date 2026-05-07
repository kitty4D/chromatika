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

/** options for `finalizeUnlock`. converted to a struct so adding new flags doesn't keep growing the positional signature. */
export type FinalizeUnlockOptions = {
  /** when set + > 0, write the derived key bytes to the unlock cache so cold SW restarts can rehydrate. */
  autoLockMinutes?: number;
  /**
   * `true` only when the calling site just CREATED a new vault (passkey/waap/mnemonic create
   * paths that auto-unlock). `false` (default) for every plain unlock-an-existing-vault path.
   * gates side-effects that should fire ONCE on first finalize: today, just the team faucet
   * call for Sui-base vaults; potentially more in future.
   */
  isFreshlyCreated?: boolean;
};

/**
 * shared post-unlock + post-create-with-unlock work. builds the session state for the active
 * vault, persists any drifted ika share keys back into the blob, writes the unlock cache, and
 * fires discovery. used by every unlock entry-point (password / passkey / waap / recovery)
 * AND by the per-method create paths that auto-unlock the freshly-created blob (passkey,
 * waap, lazor) so the user doesn't have to re-tap or re-type immediately after onboarding.
 *
 * when `options.isFreshlyCreated` is true AND the active vault is Sui-base, fires the team
 * faucet call so the user has SUI + IKA on hand to create their first dWallets without
 * acquiring tokens themselves. credential-agnostic: works for passkey, WaaP, mnemonic HD,
 * any future Sui-base auto-unlock path. silent no-op when faucet env vars are unset.
 */
export async function finalizeUnlock(
  r: { keyBytes: Uint8Array; key: CryptoKey; kdfMeta: VaultCredential['kdfMeta']; payload: VaultPayloadV3 },
  options?: FinalizeUnlockOptions,
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
    const autoLockMinutes = options?.autoLockMinutes;
    if (autoLockMinutes && autoLockMinutes > 0) {
      await writeUnlockCache(r.keyBytes, r.kdfMeta, autoLockMinutes);
    } else {
      await clearUnlockCache();
    }
    void kickDiscoveryForVault(record.id);

    // team faucet trigger - fires ONCE on first finalize for Sui-base vaults. credential-agnostic.
    // surface progress + retry affordance via the OperationProgressBanner pattern. failures here
    // never block onboarding - the user can self-fund or retry from the banner.
    if (options?.isFreshlyCreated && record.baseChain === 'sui') {
      void triggerTeamFunding(s);
    }
  } finally {
    r.keyBytes.fill(0);
  }
}

/**
 * fire-and-forget faucet trigger. extracted so `finalizeUnlock` stays linear; callers that
 * want to retry after a failure (the OperationProgressBanner "Retry" action) can also call
 * this directly via `retryTeamFundingFromActiveSession()` below.
 */
async function triggerTeamFunding(s: Awaited<ReturnType<typeof sessionStateFromRecord>>): Promise<void> {
  const { faucetEnvConfigured, requestTeamFunding } = await import('@/background/onboarding-faucet');
  if (!faucetEnvConfigured()) return;
  const { getSuiFeePayerSuiAddress } = await import('@/background/sui/sui-fee-payer-signing');
  const recipient = getSuiFeePayerSuiAddress(s);
  const { beginOperation } = await import('@/background/progress/operation-progress');
  const op = beginOperation('Funding from team');
  try {
    const outcome = await requestTeamFunding(recipient);
    switch (outcome.kind) {
      case 'success':
        await op.succeed('Received SUI + IKA from team');
        return;
      case 'skipped':
        // already_funded / cap-exhausted - no banner needed; clear the slot quietly.
        await op.succeed('Funding skipped');
        return;
      case 'disabled':
        // build was not wired up to a faucet (dev / fork without env vars).
        await op.succeed('Funding skipped');
        return;
      case 'error':
        await op.fail(outcome.message, { action: { kind: 'retry-team-funding', label: 'Retry' } });
        return;
    }
  } catch (e) {
    await op.fail((e as Error).message, { action: { kind: 'retry-team-funding', label: 'Retry' } });
  }
}

/**
 * UI-facing retry hook for the team-funding banner action. reads the active session's Sui
 * fee-payer address and re-runs the faucet through the same banner pipeline.
 */
export async function retryTeamFundingFromActiveSession(): Promise<void> {
  const s = getSession();
  if (!s) throw new Error('Wallet locked');
  if (s.activeVaultBaseChain !== 'sui') throw new Error('Active vault is not Sui-base');
  await triggerTeamFunding(s);
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
