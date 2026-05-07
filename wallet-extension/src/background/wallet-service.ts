import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import {
  deriveSolanaKeypair,
  newMnemonic,
  suiAddressFromMnemonic,
  validateWords,
} from '@/background/keyring/hd';
import { clearIkaFeeSettings } from '@/background/ika/fee-settings';
import {
  type VaultRecord,
  type VaultPayloadV3,
} from '@/background/vault-types';
import { getSession, setSession } from '@/background/session';
import { graphqlUrlForNetwork } from '@/config/sui';
import type { BaseChain } from '@/background/ika/ika-adapter';
import {
  mergeDwalletMeta,
  dwalletCountFromVaultMeta,
  type VaultSummary,
} from '@/background/dwallet-meta-service';
import {
  getVaultNetworkSettings,
  resolveSolanaRpcUrl,
} from '@/background/network/tier-network-settings';
import { registrySuiIdToSuiNetworkId } from '@/config/sui';
import {
  createInitialVaultBlob,
  listVaultEnvelopes as listVaultEnvelopesStore,
  loadVaultPayloadWithKey,
  maybePersistIkaKeyUpdates,
  storeEncryptedPayloadWithKey,
  unlockVaultBytes,
  unlockVaultPasskeyPrf,
  unlockVaultRecoveryWords as unlockVaultRecoveryWordsStore,
  unlockVaultWalletSignature,
  walletExists,
  type VaultCredential,
} from '@/background/vault-store';
import {
  clearUnlockCache,
  importVaultKeyFromCache,
  readUnlockCache,
} from '@/background/session-state';

export {
  walletExists,
} from '@/background/vault-store';
export {
  getActiveVaultId,
  getLockState,
  lockWallet,
} from '@/background/session-state';

// shared helpers live in `wallet-service-helpers.ts` so per-method onboarding modules can
// import them without going through this file (cycle-free). `persistVaultFromSession` is
// re-exported below for external callers (dwallet-discovery, dkg, encryption-key,
// accept-share all import it from here).
import {
  defaultSuiNetworkForNewVault,
  finalizeUnlock,
  kickDiscoveryForVault,
  persistVaultFromSession,
} from '@/background/wallet-service-helpers';
export { persistVaultFromSession } from '@/background/wallet-service-helpers';

// dwallet meta + summary helpers in `dwallet-meta-service.ts`; re-exported here so call
// sites that already import from `wallet-service` keep working.
export { mergeDwalletMeta, dwalletCountFromVaultMeta };
export type { VaultSummary };
export type { VaultRecord } from '@/background/vault-types';

// pure key + seed helpers in `vault-keys.ts`. only the HD-vault path lives in this file
// now; other onboarding methods (passkey/waap/lazor/hardware/private-key/dwallet-anchored)
// import these helpers directly from `vault-keys` via their per-method modules.
import { buildIkaShareKeys, makeSeedForHdVault, solanaKeypairFromB64 } from '@/background/vault-keys';

// `feeMaterialFromVaultRecord` + `sessionStateFromRecord` in `vault-session-builder.ts`.
// `sessionStateFromRecord` is imported below; `feeMaterialFromVaultRecord` is internal-only.
import { sessionStateFromRecord } from '@/background/vault-session-builder';

/** BIP39 phrase for UI preview only. call `createVault` / `addVault` after the user confirms backup (PBKDF2 + ika keys run there). */
export function generateSetupMnemonic(wordCount: 12 | 24 = 12): string {
  return newMnemonic(wordCount);
}

// `resolveCredentialOrUnlock` extracted to `vault-credentials.ts`; per-method onboarding
// modules import it directly so there is no circular path back through wallet-service.
import { resolveCredentialOrUnlock } from '@/background/vault-credentials';

/**
 * create the first vault (onboarding). `accountIndex` defaults to 0; non-zero indices are for
 * the rare case where the user is bootstrapping with a non-default account from a recovered
 * scan (more common via `importVault`).
 */
export async function createVault(
  password: string,
  mnemonic?: string,
  accountIndex = 0,
  label = 'default',
): Promise<{ mnemonic: string; vaultId: string }> {
  const words = mnemonic ?? newMnemonic(12);
  if (!validateWords(words)) throw new Error('Invalid mnemonic');
  const id = crypto.randomUUID();
  const network = defaultSuiNetworkForNewVault();
  const { ikaShareKeysB64 } = await buildIkaShareKeys(makeSeedForHdVault(words, 'sui', accountIndex), {});
  const record: VaultRecord = {
    id,
    label,
    baseChain: 'sui',
    accountKind: 'hd',
    mnemonic: words,
    accountIndex,
    network,
    ikaShareKeysB64,
    dwalletMeta: {},
    createdAtMs: Date.now(),
  };
  const payload: VaultPayloadV3 = { v: 3, vaults: [record], activeVaultId: id };
  await createInitialVaultBlob(password, payload);
  return { mnemonic: words, vaultId: id };
}

/**
 * import recovery phrase as the first vault. `accountIndex` selects which BIP44 account slot to
 * persist - useful when the user picked a non-zero account from a pre-import scan (e.g. they
 * had activity at account 2 on this phrase, not account 0).
 */
export async function importVault(
  password: string,
  mnemonic: string,
  accountIndex = 0,
  label = 'default',
): Promise<{ vaultId: string }> {
  const words = mnemonic.trim().replace(/\s+/g, ' ');
  if (!validateWords(words)) throw new Error('Invalid recovery phrase');
  const id = crypto.randomUUID();
  const network = defaultSuiNetworkForNewVault();
  const { ikaShareKeysB64 } = await buildIkaShareKeys(makeSeedForHdVault(words, 'sui', accountIndex), {});
  const record: VaultRecord = {
    id,
    label,
    baseChain: 'sui',
    accountKind: 'hd',
    mnemonic: words,
    accountIndex,
    network,
    ikaShareKeysB64,
    dwalletMeta: {},
    createdAtMs: Date.now(),
  };
  const payload: VaultPayloadV3 = { v: 3, vaults: [record], activeVaultId: id };
  await createInitialVaultBlob(password, payload);
  return { vaultId: id };
}

/**
 * add another vault; becomes active and session is rebuilt if already unlocked.
 *
 * `accountIndex` lets the caller add a non-default BIP44 account from the SAME mnemonic as an
 * existing vault - the multi-account scan flow uses this to import accounts 1, 2, ... after the
 * user picks them from scan results. when omitted, defaults to 0 (single-account behavior).
 */
export async function addVault(
  password: string | undefined,
  opts: {
    baseChain?: BaseChain;
    mnemonic?: string;
    /** when generating a new phrase (no `mnemonic`), use 12 or 24 words */
    wordCount?: 12 | 24;
    label?: string;
    /** BIP44 account index for HD derivation. default 0. */
    accountIndex?: number;
  },
): Promise<{ vaultId: string; mnemonic?: string }> {
  const baseChain = opts.baseChain ?? 'sui';
  const supplied = opts.mnemonic?.trim().replace(/\s+/g, ' ');
  const words = supplied || newMnemonic(opts.wordCount ?? 12);
  if (!validateWords(words)) throw new Error('Invalid recovery phrase');
  const accountIndex = Math.max(0, Math.floor(opts.accountIndex ?? 0));

  if (getSession()) await persistVaultFromSession();

  const cred = await resolveCredentialOrUnlock(password);
  const payload = await loadVaultPayloadWithKey(cred.key);

  const id = crypto.randomUUID();
  const network = defaultSuiNetworkForNewVault();
  const { ikaShareKeysB64 } = await buildIkaShareKeys(makeSeedForHdVault(words, baseChain, accountIndex), {});
  const record: VaultRecord = {
    id,
    label: opts.label?.trim() || `vault ${payload.vaults.length + 1}`,
    baseChain,
    accountKind: 'hd',
    mnemonic: words,
    accountIndex,
    network,
    ikaShareKeysB64,
    dwalletMeta: {},
    createdAtMs: Date.now(),
  };
  payload.vaults.push(record);
  payload.activeVaultId = id;
  await storeEncryptedPayloadWithKey(cred, payload);

  if (getSession()) {
    const next = await sessionStateFromRecord(record, cred);
    setSession(next);
    void kickDiscoveryForVault(id);
  }
  return {
    vaultId: id,
    ...(supplied ? {} : { mnemonic: words }),
  };
}

/**
 * multi-account import helper: persist N vault records from one mnemonic, one per accountIndex.
 *
 * used by the scan-then-import flow: the user runs `scanForHd` against their phrase, sees rows
 * with activity at multiple BIP44 accounts, picks which to import, then the UI calls this with
 * those (accountIndex, label) pairs. delegates to `importVault` for the bootstrap row when no
 * wallet exists, then `addVault` for subsequent rows; when a wallet already exists, every row
 * goes through `addVault`.
 *
 * returns one result per row in input order. errors on row N abort the batch (we don't want to
 * leave a partially-imported wallet) - the caller should surface the error so the user can
 * retry.
 */
export async function importVaultsBatch(
  password: string,
  mnemonic: string,
  accounts: Array<{ accountIndex: number; label?: string }>,
): Promise<Array<{ vaultId: string; accountIndex: number }>> {
  if (accounts.length === 0) throw new Error('importVaultsBatch needs at least one account');
  const results: Array<{ vaultId: string; accountIndex: number }> = [];
  const seen = new Set<number>();
  for (const a of accounts) {
    if (seen.has(a.accountIndex)) continue; // dedupe
    seen.add(a.accountIndex);
    if (!(await walletExists()) && results.length === 0) {
      const r = await importVault(password, mnemonic, a.accountIndex, a.label?.trim() || `account ${a.accountIndex}`);
      results.push({ vaultId: r.vaultId, accountIndex: a.accountIndex });
    } else {
      const r = await addVault(password, {
        mnemonic,
        accountIndex: a.accountIndex,
        label: a.label?.trim() || `account ${a.accountIndex}`,
      });
      results.push({ vaultId: r.vaultId, accountIndex: a.accountIndex });
    }
  }
  return results;
}

export async function listVaultSummaries(): Promise<VaultSummary[]> {
  const s = getSession();
  if (!s) throw new Error('Wallet locked');
  const payload = await loadVaultPayloadWithKey(s.vaultKey);
  return Promise.all(
    payload.vaults.map(async (v) => {
      const vaultNet = await getVaultNetworkSettings(v.id, v);
      const solanaLookupRpcUrl = resolveSolanaRpcUrl(vaultNet.solana);
      const row: VaultSummary = {
        id: v.id,
        label: v.label,
        baseChain: v.baseChain,
        accountKind: v.accountKind,
        createdAtMs: v.createdAtMs,
        dwalletCount: dwalletCountFromVaultMeta(v.dwalletMeta),
        solanaLookupRpcUrl,
        suiGraphqlUrl: graphqlUrlForNetwork(registrySuiIdToSuiNetworkId(vaultNet.suiNetworkId)),
        ikaKeysReady: Boolean(v.ikaShareKeysB64.SECP256K1 && v.ikaShareKeysB64.ED25519),
      };
      if (v.accountKind === 'hardware' && v.baseChain === 'solana') {
        if ('walletconnect' in v && v.walletconnect) row.solanaMobileHardwareBridge = 'walletconnect';
        else if ('mwaTransport' in v && v.mwaTransport === 'remote') row.solanaMobileHardwareBridge = 'mwa-remote';
        else if ('mwaTransport' in v && v.mwaTransport === 'local') row.solanaMobileHardwareBridge = 'mwa';
      }
      try {
        if (v.accountKind === 'hd') {
          row.suiAddress0 = suiAddressFromMnemonic(v.mnemonic, 0);
          row.solanaAddress0 = deriveSolanaKeypair(v.mnemonic, 0).publicKey.toBase58();
        } else if ('suiPrivateKeyBech32' in v && v.suiPrivateKeyBech32) {
          row.suiAddress0 = Ed25519Keypair.fromSecretKey(v.suiPrivateKeyBech32).toSuiAddress();
        }
        if (v.accountKind !== 'hd' && 'solanaSecretKeyB64' in v && v.solanaSecretKeyB64) {
          row.solanaAddress0 = solanaKeypairFromB64(v.solanaSecretKeyB64).publicKey.toBase58();
        }
      } catch {
        /* ignore preview failures */
      }
      return row;
    }),
  );
}

/**
 * read an HD vault’s mnemonic when adding a vault on the *other* ika base chain with the same seed.
 * rejects if the vault is not HD or if it is already on `newVaultBaseChain` (no cross-reuse needed).
 */
export async function getMnemonicForCrossChainReuse(
  password: string | undefined,
  vaultId: string,
  newVaultBaseChain: BaseChain,
): Promise<string> {
  const cred = await resolveCredentialOrUnlock(password);
  const payload = await loadVaultPayloadWithKey(cred.key);
  const v = payload.vaults.find((x) => x.id === vaultId);
  if (!v) throw new Error('Vault not found');
  if (v.accountKind !== 'hd') throw new Error('That vault has no seed phrase to reuse');
  if (v.baseChain === newVaultBaseChain) {
    throw new Error('Choose a vault on the other ika base chain');
  }
  return v.mnemonic;
}

export async function removeVault(password: string | undefined, vaultId: string): Promise<void> {
  if (getSession()) await persistVaultFromSession();

  const cred = await resolveCredentialOrUnlock(password);
  let payload = await loadVaultPayloadWithKey(cred.key);
  if (payload.vaults.length <= 1) throw new Error('Cannot remove the last vault');
  const filtered = payload.vaults.filter((v) => v.id !== vaultId);
  if (filtered.length === payload.vaults.length) throw new Error('Vault not found');
  payload = { ...payload, vaults: filtered };
  if (payload.activeVaultId === vaultId) {
    payload.activeVaultId = filtered[0]!.id;
  }
  await storeEncryptedPayloadWithKey(cred, payload);
  // per-vault fee settings live in plaintext storage outside the encrypted blob; clear them
  // explicitly so a future vault id collision (extremely unlikely with crypto.randomUUID, but
  // possible in tests / dev profiles) doesn't inherit stale config.
  await clearIkaFeeSettings(vaultId).catch(() => {/* best-effort */});

  const sess = getSession();
  if (sess?.activeVaultId === vaultId) {
    const target = filtered.find((v) => v.id === payload.activeVaultId) ?? filtered[0]!;
    setSession(await sessionStateFromRecord(target, cred));
  }
}

// hardware onboarding moved to `vault-onboarding-hardware.ts`.
export {
  createInitialHardwareVault,
  addHardwareVault,
  refreshMwaAuthToken,
} from '@/background/vault-onboarding-hardware';

export async function renameVault(password: string | undefined, vaultId: string, label: string): Promise<void> {
  if (getSession()) await persistVaultFromSession();

  const cred = await resolveCredentialOrUnlock(password);
  const payload = await loadVaultPayloadWithKey(cred.key);
  const idx = payload.vaults.findIndex((v) => v.id === vaultId);
  if (idx === -1) throw new Error('Vault not found');
  payload.vaults[idx] = { ...payload.vaults[idx]!, label: label.trim() || payload.vaults[idx]!.label };
  await storeEncryptedPayloadWithKey(cred, payload);

  const sess = getSession();
  if (sess?.activeVaultId === vaultId) {
    sess.activeVaultLabel = payload.vaults[idx]!.label;
  }
}

/**
 * switch active vault. uses `password` or, if omitted, the in-session vault key.
 */
export async function switchVault(password: string | undefined, vaultId: string): Promise<void> {
  if (getSession()) await persistVaultFromSession();

  const cred = await resolveCredentialOrUnlock(password);
  let payload = await loadVaultPayloadWithKey(cred.key);
  const target = payload.vaults.find((v) => v.id === vaultId);
  if (!target) throw new Error('Vault not found');
  payload = { ...payload, activeVaultId: vaultId };
  await storeEncryptedPayloadWithKey(cred, payload);

  setSession(await sessionStateFromRecord(target, cred));
  void kickDiscoveryForVault(vaultId);
}

// `finalizeUnlock` moved to `wallet-service-helpers.ts`; imported below alongside the other
// shared unlock/add-vault helpers.

/**
 * unlock via a WebAuthn PRF hmac-secret (popup-collected). caller supplies the envelope id +
 * the 32-byte PRF output. mirrors `unlockVault` in finalize behavior.
 */
export async function unlockVaultByPasskey(
  envelopeId: string,
  prfSecret: Uint8Array,
  autoLockMinutes?: number,
): Promise<void> {
  const r = await unlockVaultPasskeyPrf({ envelopeId, prfSecret });
  await finalizeUnlock(r, { autoLockMinutes });
}

/**
 * unlock via a deterministic wallet-standard signature (waap, seeker, walletconnect).
 * caller has already invoked the wallet (re-running login + sign personal message).
 */
export async function unlockVaultByWalletSignature(
  envelopeId: string,
  signature: Uint8Array,
  autoLockMinutes?: number,
): Promise<void> {
  const r = await unlockVaultWalletSignature({ envelopeId, signature });
  await finalizeUnlock(r, { autoLockMinutes });
}

/** unlock via a BIP39 phrase (lazor recovery, opt-in passkey/waap recovery codes). */
export async function unlockVaultByRecoveryWords(
  envelopeId: string,
  bip39Seed: Uint8Array,
  autoLockMinutes?: number,
): Promise<void> {
  const r = await unlockVaultRecoveryWordsStore({ envelopeId, bip39Seed });
  await finalizeUnlock(r, { autoLockMinutes });
}

/** public-metadata view of available unlock methods, for the unlock screen. */
export async function listVaultEnvelopes() {
  return listVaultEnvelopesStore();
}

export async function unlockVault(password: string, autoLockMinutes?: number): Promise<void> {
  const r = await unlockVaultBytes(password);
  await finalizeUnlock(r, { autoLockMinutes });

  // warm presign pools immediately on unlock so the first signing op is fast.
  // skip in `seeker_direct` ika fee mode - each presign requires phone prompts, and prompting
  // immediately on unlock (when the user just typed their password and isn't expecting their
  // phone to buzz) is a UX trap. seeker_direct does presign lazily at sign time instead.
  import('@/background/ika/presign-pool').then(({ getPresignPoolStatus, replenishPool }) => {
    getPresignPoolStatus().then(async (status) => {
      const s = getSession();
      if (!s) return;
      const { getIkaFeeSettings } = await import('@/background/ika/fee-settings');
      const settings = await getIkaFeeSettings(s.activeVaultId);
      if (settings.mode === 'seeker_direct') return;
      if (s.activeVaultBaseChain === 'solana') {
        const hasDwallet = Boolean(
          s.dwalletMeta.SECP256K1?.dwalletId || s.dwalletMeta.ED25519?.dwalletId,
        );
        if (!hasDwallet) return;
      }
      const keys = ['SECP256K1_ECDSA', 'ED25519_EDDSA'] as const;
      for (const key of keys) {
        if (status[key] < 3) void replenishPool(key, 3).catch(() => {});
      }
    }).catch(() => {});
  }).catch(() => {});
}

/**
 * cold SW restart path: rehydrate the in-memory session from the unlock cache.
 * cache stores derived AES-GCM key bytes (b64) + kdfMeta (never the password). we re-import
 * the bytes as a non-extractable CryptoKey, decrypt the vault, and rebuild SessionState.
 */
export async function ensureUnlockedSessionFromCache(): Promise<boolean> {
  if (getSession()) return true;
  const cached = await readUnlockCache();
  if (!cached) return false;
  if (Date.now() >= cached.expiresAtEpochMs) {
    await clearUnlockCache();
    return false;
  }
  try {
    const key = await importVaultKeyFromCache(cached);
    const cred: VaultCredential = { key, kdfMeta: cached.kdfMeta };
    let payload = await loadVaultPayloadWithKey(key);
    if (!payload.vaults.length) {
      await clearUnlockCache();
      return false;
    }
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
    void kickDiscoveryForVault(record.id);
    return true;
  } catch {
    await clearUnlockCache();
    return false;
  }
}

/**
 * re-encrypt the in-memory session into the vault blob using the in-session credential
 * (no password required). called before any read-modify-write of payload from a different
 * code path so live edits to dwalletMeta / ikaShareKeysB64 / label are not lost.
 */
// private-key onboarding moved to `vault-onboarding-private-key.ts`. re-exported here so
// existing callers (wallet-setup-flow, vault router) keep working unchanged.
export {
  importVaultFromSuiPrivateKey,
  addVaultImportedFromPrivateKey,
} from '@/background/vault-onboarding-private-key';


/**
 * Sui passkey vault: WebAuthn / SIP-9 owner identity, ika dWallet on Sui base, Solana addresses
 * via dWallet MPC. **PRF hmac-secret extension** is the deterministic seed source, same passkey
 * + same persisted salt = same ika `UserShareEncryptionKeys` = same dWallet across reinstalls /
 * synced devices, no local signature artifact required.
 *
 * if a vault blob already exists, falls through to `addPasskeyVault` so `password` decrypts the
 * existing payload and the new passkey lands as a sibling vault. mirrors `createInitialHardwareVault`.
 *
 * @param input.prfSecretB64       base64(32-byte PRF hmac-secret), popup-collected via WebAuthn assertion
 * @param input.publicKeyCompressedB64  base64(33-byte compressed secp256r1 pk), Sui address derives from this
 * @param input.credentialIdB64Url base64url(`credential.rawId`), constrains future assertions
 * @param input.prfSaltB64         base64(32-byte salt), persist verbatim for re-derivation on every assertion
 * @param input.rpId               WebAuthn relying party id (chrome.runtime.id)
 * @param input.recoveryWords      optional BIP39 phrase to use as the seed source instead of PRF;
 *                                 also encrypted into the record as `recoveryWordsEncryptedB64` for "show recovery code"
 */
// passkey onboarding moved to `vault-onboarding-passkey.ts`.
export { createPasskeyVault, addPasskeyVault } from '@/background/vault-onboarding-passkey';

// waap onboarding moved to `vault-onboarding-waap.ts`.
export { createWaapVault, addWaapVault } from '@/background/vault-onboarding-waap';
//

// lazor onboarding moved to `vault-onboarding-lazor.ts`.
export { createLazorVault, addLazorVault } from '@/background/vault-onboarding-lazor';
// dwallet-anchored onboarding moved to `vault-onboarding-dwallet-anchored.ts`.
export { addDwalletAnchoredVault } from '@/background/vault-onboarding-dwallet-anchored';

/** rebuild GraphQL / Solana clients after tier network mutations using the in-session credential. */
export async function refreshSessionNetworkClients(): Promise<void> {
  const s = getSession();
  if (!s) return;
  const cred: VaultCredential = { key: s.vaultKey, kdfMeta: s.vaultKdfMeta };
  const payload = await loadVaultPayloadWithKey(cred.key);
  const record = payload.vaults.find((v) => v.id === s.activeVaultId);
  if (!record) return;
  setSession(await sessionStateFromRecord(record, cred));
}
