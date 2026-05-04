import {
  blobToKdfMeta,
  buildPasswordEnvelope,
  buildPasskeyPrfEnvelope,
  buildRecoveryWordsEnvelope,
  buildV4BlobFromEnvelopes,
  buildWalletSignatureEnvelope,
  decryptPayloadV4,
  decryptWithKey,
  detectVaultBlobVersion,
  deriveVaultKeyBytes,
  encryptVaultFresh,
  freshKdfMeta,
  freshMasterKeyBytes,
  hkdfDeriveKek,
  importKeyBytesToVaultKey,
  importMasterKeyBytes,
  parseVaultBlob,
  parseVaultBlobV4,
  unwrapMasterKey,
  wrapMasterKey,
  ENVELOPE_KEK_INFO_PASSKEY,
  ENVELOPE_KEK_INFO_RECOVERY,
  ENVELOPE_KEK_INFO_WALLET_SIG,
  type PasskeyPrfEnvelope,
  type PasswordEnvelope,
  type RecoveryWordsEnvelope,
  type VaultBlobV4,
  type VaultEnvelope,
  type VaultKdfMeta,
  type WalletSignatureEnvelope,
} from '@/background/vault';
import {
  assertVaultPayload,
  parseAndMigrateVaultPayload,
  type VaultPayloadV3,
  type VaultRecord,
} from '@/background/vault-types';
import type { SessionState } from '@/background/session';
import { STORAGE_KEYS } from '@/background/storage';

const VAULT_KEY = STORAGE_KEYS.VAULT_V3;
/** legacy PBKDF2 key - pre-release: just refuse to read; user clears storage. */
const LEGACY_VAULT_KEY_V2 = STORAGE_KEYS.VAULT_V2_LEGACY;

/**
 * in-session credential - held in `SessionState` while unlocked. v4 carries the master key
 * (non-extractable AES-GCM `CryptoKey`) which decrypts the vault payload directly. `kdfMeta`
 * is retained for compatibility with the legacy unlock cache rehydrate path; new sessions
 * derive nothing from it post-unlock.
 */
export interface VaultCredential {
  /** master key. v4: the random 32-byte key wrapped by every envelope. v3 (pre-migration): the argon2id-derived key. */
  key: CryptoKey;
  /** kdf params used for the LAST password unlock (or first password envelope at create). */
  kdfMeta: VaultKdfMeta;
}

async function readBlob(): Promise<string | undefined> {
  return new Promise<string | undefined>((resolve, reject) => {
    chrome.storage.local.get([VAULT_KEY], (r) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(r[VAULT_KEY] as string | undefined);
    });
  });
}

async function writeBlob(blob: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    chrome.storage.local.set({ [VAULT_KEY]: blob }, () => {
      if (chrome.runtime.lastError) {
        reject(
          new Error(
            `Could not save vault (${chrome.runtime.lastError.message ?? 'chrome.storage.local.set failed'}).`,
          ),
        );
        return;
      }
      resolve();
    });
  });
  // read-back verify so a silent set failure surfaces immediately instead of corrupting unlock.
  const verify = await readBlob();
  if (verify !== blob) {
    throw new Error(
      'Vault did not persist: chromatika_vault_v3 is missing or mismatched after save. Try again; if it keeps happening, reload the extension and check chrome://extensions storage.',
    );
  }
}

export function walletExists(): Promise<boolean> {
  return new Promise((resolve) => {
    chrome.storage.local.get([VAULT_KEY, LEGACY_VAULT_KEY_V2], (r) => {
      // legacy v2 still counts as "wallet exists" so onboarding doesn't pretend it isn't there.
      resolve(Boolean(r[VAULT_KEY] || r[LEGACY_VAULT_KEY_V2]));
    });
  });
}

/** true iff only the legacy PBKDF2 v2 blob exists (no v3/v4). UI uses this to show a "clear and re-onboard" panel. */
export function legacyVaultOnly(): Promise<boolean> {
  return new Promise((resolve) => {
    chrome.storage.local.get([VAULT_KEY, LEGACY_VAULT_KEY_V2], (r) => {
      resolve(Boolean(r[LEGACY_VAULT_KEY_V2]) && !r[VAULT_KEY]);
    });
  });
}

/**
 * pre-release recovery: nuke the legacy v2 blob (and the legacy session-cache row) so the
 * onboarding flow can run again. does not touch the v3/v4 blob if one exists.
 */
export function clearLegacyVault(): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.remove([LEGACY_VAULT_KEY_V2], () => resolve());
  });
}

const LEGACY_V2_MESSAGE =
  'Legacy PBKDF2 vault (chromatika_vault_v2) detected. Pre-release: open chrome://extensions → Chromatika → Inspect service worker → Application/Storage → clear extension storage, then re-onboard. (Or call clearLegacyVault from the SW console.)';

/** read + decrypt the vault using an in-session non-extractable `CryptoKey`. */
export async function loadVaultPayloadWithKey(key: CryptoKey): Promise<VaultPayloadV3> {
  const blobJson = await readBlob();
  if (!blobJson) throw new Error('No wallet');
  const version = detectVaultBlobVersion(blobJson);
  let raw: string;
  if (version === 4) {
    const blobV4 = parseVaultBlobV4(blobJson);
    raw = await decryptPayloadV4(key, blobV4);
  } else if (version === 3) {
    const blobV3 = parseVaultBlob(blobJson);
    raw = await decryptWithKey(key, blobV3);
  } else {
    throw new Error('Unsupported vault blob version');
  }
  const p = parseAndMigrateVaultPayload(raw);
  assertVaultPayload(p);
  return p;
}

/**
 * encrypt + persist using the in-session master key. always writes a v4 blob, preserving the
 * existing envelopes (or migrating from v3 by building a single password envelope on the fly,
 * but that path requires the password, so it lives in `unlockVaultBytesV3CompatThenMigrate`).
 *
 * for the common "wallet is unlocked → re-encrypt with same envelopes" case, we read the
 * current blob's envelopes verbatim and re-encrypt the payload under the same master key.
 */
export async function storeEncryptedPayloadWithKey(
  cred: VaultCredential,
  payload: VaultPayloadV3,
): Promise<void> {
  const existing = await readBlob();
  let envelopes: VaultEnvelope[] = [];
  if (existing) {
    const version = detectVaultBlobVersion(existing);
    if (version === 4) {
      envelopes = parseVaultBlobV4(existing).envelopes;
    } else if (version === 3) {
      // v3 → v4 in-place rewrite: callers shouldn't hit this without going through
      // `unlockVaultBytes` (which migrates), but defend against it by refusing to drop the
      // existing password envelope. force the caller to re-unlock with password to migrate.
      throw new Error(
        'Vault blob is still v3 - re-unlock with password to migrate to the multi-envelope format before saving.',
      );
    }
  }
  if (envelopes.length === 0) {
    throw new Error('Cannot save vault: no envelopes available. Re-unlock to rebuild.');
  }
  const blob = await buildV4BlobFromEnvelopes(envelopes, cred.key, JSON.stringify(payload));
  await writeBlob(blob);
}

/**
 * initial vault create with a single password envelope. returns the credential the caller
 * plants in the session + unlock cache. mirrors v3's `createInitialVaultBlob` shape so call
 * sites don't need to change.
 */
export async function createInitialVaultBlob(
  password: string,
  payload: VaultPayloadV3,
): Promise<VaultCredential> {
  const masterKeyBytes = freshMasterKeyBytes();
  let masterKey: CryptoKey;
  try {
    masterKey = await importMasterKeyBytes(masterKeyBytes);
    const envelope = await buildPasswordEnvelope(masterKeyBytes, password);
    const blob = await buildV4BlobFromEnvelopes([envelope], masterKey, JSON.stringify(payload));
    await writeBlob(blob);
    return {
      key: masterKey,
      kdfMeta: { kdf: 'argon2id', salt: envelope.salt, t: envelope.t, m: envelope.m, p: envelope.p },
    };
  } finally {
    masterKeyBytes.fill(0);
  }
}

/**
 * initial vault create with arbitrary envelope mix - generic v4 entry-point. used by passkey-/
 * waap-/lazor-only bootstrap paths (no password) and by mixed paths (password + passkey, etc.).
 * caller supplies the envelope-build callbacks; this fn handles the master key lifecycle + write.
 *
 * returns the master key bytes alongside the credential so the immediate caller can stash them
 * (e.g. into the unlock cache) before we zero them. **caller MUST zero `masterKeyBytes` after
 * use** - `Uint8Array.prototype.fill(0)` is the canonical pattern.
 */
export async function createInitialVaultBlobV4(
  buildEnvelopes: (masterKeyBytes: Uint8Array) => Promise<VaultEnvelope[]>,
  payload: VaultPayloadV3,
): Promise<VaultCredential & { masterKeyBytes: Uint8Array }> {
  const masterKeyBytes = freshMasterKeyBytes();
  const masterKey = await importMasterKeyBytes(masterKeyBytes);
  const envelopes = await buildEnvelopes(masterKeyBytes);
  if (envelopes.length === 0) {
    masterKeyBytes.fill(0);
    throw new Error('createInitialVaultBlobV4 requires at least one envelope');
  }
  const blob = await buildV4BlobFromEnvelopes(envelopes, masterKey, JSON.stringify(payload));
  await writeBlob(blob);
  // synthesise a kdfMeta-shaped row from the first password envelope if any, else zeros so the
  // session-cache rehydrate path stays type-safe (the kdfMeta is unused for non-password unlock).
  const pw = envelopes.find((e): e is PasswordEnvelope => e.kind === 'password');
  const kdfMeta: VaultKdfMeta = pw
    ? { kdf: 'argon2id', salt: pw.salt, t: pw.t, m: pw.m, p: pw.p }
    : { kdf: 'argon2id', salt: '', t: 0, m: 0, p: 0 };
  return { key: masterKey, kdfMeta, masterKeyBytes };
}

/** legacy alias - kept for callers that still reach in. zeroes masterKeyBytes internally. */
export async function createInitialVaultBlobNoPassword(
  buildEnvelopes: (masterKeyBytes: Uint8Array) => Promise<VaultEnvelope[]>,
  payload: VaultPayloadV3,
): Promise<VaultCredential> {
  const r = await createInitialVaultBlobV4(buildEnvelopes, payload);
  r.masterKeyBytes.fill(0);
  return { key: r.key, kdfMeta: r.kdfMeta };
}

/**
 * primary password-unlock entry-point. returns the master key + kdfMeta + payload. if the
 * stored blob is v3, transparently migrates it to v4 (single password envelope using the
 * same Argon2id params + salt the user already typed against) before returning.
 */
export async function unlockVaultBytes(password: string): Promise<{
  keyBytes: Uint8Array;
  key: CryptoKey;
  kdfMeta: VaultKdfMeta;
  payload: VaultPayloadV3;
}> {
  const blobJson = await readBlob();
  if (!blobJson) {
    if (await legacyVaultOnly()) throw new Error(LEGACY_V2_MESSAGE);
    throw new Error('No wallet');
  }
  const version = detectVaultBlobVersion(blobJson);
  if (version === 'unknown') throw new Error('Unsupported vault blob version');

  if (version === 3) {
    // v3 → v4 migration: do v3 unlock, lift the result into a v4 blob with one password envelope.
    return unlockV3AndMigrate(password, blobJson);
  }
  // v4 path: find a password envelope and unwrap its master key.
  const blob = parseVaultBlobV4(blobJson);
  const env = blob.envelopes.find((e): e is PasswordEnvelope => e.kind === 'password');
  if (!env) throw new Error('Wallet has no password unlock - use a different method (passkey, waap, etc.).');
  const kdfMeta: VaultKdfMeta = { kdf: 'argon2id', salt: env.salt, t: env.t, m: env.m, p: env.p };
  const kekBytes = await deriveVaultKeyBytes(password, kdfMeta);
  let kek: CryptoKey;
  let masterKeyBytes: Uint8Array;
  try {
    kek = await importKeyBytesToVaultKey(kekBytes);
    try {
      masterKeyBytes = await unwrapMasterKey(env, kek);
    } catch {
      throw new Error('Wrong password');
    }
  } finally {
    kekBytes.fill(0);
  }
  let masterKey: CryptoKey;
  try {
    masterKey = await importMasterKeyBytes(masterKeyBytes);
    const plaintext = await decryptPayloadV4(masterKey, blob);
    const p = parseAndMigrateVaultPayload(plaintext);
    assertVaultPayload(p);
    return { keyBytes: masterKeyBytes, key: masterKey, kdfMeta, payload: p };
  } catch (e) {
    masterKeyBytes.fill(0);
    throw e;
  }
}

/** convenience wrapper for callers that don't need the raw bytes (no cache write). */
export async function unlockVaultCredential(
  password: string,
): Promise<VaultCredential & { payload: VaultPayloadV3 }> {
  const r = await unlockVaultBytes(password);
  r.keyBytes.fill(0);
  return { key: r.key, kdfMeta: r.kdfMeta, payload: r.payload };
}

/**
 * Unlock via a popup-collected webauthn prf hmac-secret. caller supplies the envelope id +
 * the 32-byte prf output; we derive the KEK, unwrap the master key, decrypt the payload.
 */
export async function unlockVaultPasskeyPrf(args: {
  envelopeId: string;
  prfSecret: Uint8Array;
}): Promise<{ keyBytes: Uint8Array; key: CryptoKey; kdfMeta: VaultKdfMeta; payload: VaultPayloadV3 }> {
  const blob = await loadV4BlobOrThrow();
  const env = blob.envelopes.find(
    (e): e is PasskeyPrfEnvelope => e.kind === 'passkey-prf' && e.id === args.envelopeId,
  );
  if (!env) throw new Error(`No passkey envelope with id ${args.envelopeId}`);
  return unwrapMasterAndDecrypt(blob, env, await hkdfDeriveKek(args.prfSecret, ENVELOPE_KEK_INFO_PASSKEY));
}

/** unlock via a deterministic wallet signature (waap, seeker, walletconnect). */
export async function unlockVaultWalletSignature(args: {
  envelopeId: string;
  signature: Uint8Array;
}): Promise<{ keyBytes: Uint8Array; key: CryptoKey; kdfMeta: VaultKdfMeta; payload: VaultPayloadV3 }> {
  const blob = await loadV4BlobOrThrow();
  const env = blob.envelopes.find(
    (e): e is WalletSignatureEnvelope => e.kind === 'wallet-signature' && e.id === args.envelopeId,
  );
  if (!env) throw new Error(`No wallet-signature envelope with id ${args.envelopeId}`);
  return unwrapMasterAndDecrypt(blob, env, await hkdfDeriveKek(args.signature, ENVELOPE_KEK_INFO_WALLET_SIG));
}

/** unlock via a bip39 phrase (lazor recovery, opt-in passkey/waap recovery codes). */
export async function unlockVaultRecoveryWords(args: {
  envelopeId: string;
  bip39Seed: Uint8Array;
}): Promise<{ keyBytes: Uint8Array; key: CryptoKey; kdfMeta: VaultKdfMeta; payload: VaultPayloadV3 }> {
  const blob = await loadV4BlobOrThrow();
  const env = blob.envelopes.find(
    (e): e is RecoveryWordsEnvelope => e.kind === 'recovery-words' && e.id === args.envelopeId,
  );
  if (!env) throw new Error(`No recovery-words envelope with id ${args.envelopeId}`);
  return unwrapMasterAndDecrypt(blob, env, await hkdfDeriveKek(args.bip39Seed, ENVELOPE_KEK_INFO_RECOVERY));
}

/**
 * read the current blob and return the envelopes' public metadata for the unlock screen.
 * no secret material is returned; envelopes' wrap-iv and wrappedMasterKey stay encrypted.
 */
export async function listVaultEnvelopes(): Promise<
  Array<Pick<VaultEnvelope, 'id' | 'kind' | 'label' | 'addedAtEpochMs'> & Partial<Record<string, unknown>>>
> {
  const blobJson = await readBlob();
  if (!blobJson) return [];
  const version = detectVaultBlobVersion(blobJson);
  if (version === 3) {
    // legacy: synthesise a single password envelope so the unlock screen has something to show.
    return [{ id: 'env-pw-v3', kind: 'password', label: 'password', addedAtEpochMs: 0 }];
  }
  if (version !== 4) return [];
  const blob = parseVaultBlobV4(blobJson);
  return blob.envelopes.map((e) => {
    const base = { id: e.id, kind: e.kind, label: e.label, addedAtEpochMs: e.addedAtEpochMs };
    if (e.kind === 'passkey-prf') {
      return { ...base, credentialIdB64Url: e.credentialIdB64Url, rpId: e.rpId, prfSaltB64: e.prfSaltB64 };
    }
    if (e.kind === 'wallet-signature') {
      return { ...base, source: e.source, address: e.address, hint: e.hint };
    }
    if (e.kind === 'recovery-words') {
      return { ...base, wordCount: e.wordCount };
    }
    return base; // password envelope: id/kind/label only
  });
}

/**
 * if the in-session ika share keys diverged from what's encrypted (e.g. we just
 * derived a missing curve), re-encrypt the payload with the fresh keys.
 */
export async function maybePersistIkaKeyUpdates(
  cred: VaultCredential,
  payload: VaultPayloadV3,
  record: VaultRecord,
  ikaShareKeysB64: SessionState['ikaShareKeysB64'],
): Promise<VaultPayloadV3> {
  if (JSON.stringify(ikaShareKeysB64) === JSON.stringify(record.ikaShareKeysB64)) {
    return payload;
  }
  const idx = payload.vaults.findIndex((v) => v.id === record.id);
  if (idx === -1) return payload;
  payload.vaults[idx] = { ...payload.vaults[idx]!, ikaShareKeysB64 };
  await storeEncryptedPayloadWithKey(cred, payload);
  return payload;
}

/* =============================================================================
 * internals
 * ============================================================================= */

async function loadV4BlobOrThrow(): Promise<VaultBlobV4> {
  const blobJson = await readBlob();
  if (!blobJson) {
    if (await legacyVaultOnly()) throw new Error(LEGACY_V2_MESSAGE);
    throw new Error('No wallet');
  }
  const version = detectVaultBlobVersion(blobJson);
  if (version === 3) {
    throw new Error(
      'This wallet was created before multi-envelope unlock - log in once with your password to migrate, then non-password unlock methods become available.',
    );
  }
  if (version !== 4) throw new Error('Unsupported vault blob version');
  return parseVaultBlobV4(blobJson);
}

async function unwrapMasterAndDecrypt(
  blob: VaultBlobV4,
  envelope: VaultEnvelope,
  kek: CryptoKey,
): Promise<{ keyBytes: Uint8Array; key: CryptoKey; kdfMeta: VaultKdfMeta; payload: VaultPayloadV3 }> {
  let masterKeyBytes: Uint8Array;
  try {
    masterKeyBytes = await unwrapMasterKey(envelope, kek);
  } catch {
    throw new Error('Unlock failed: envelope unwrap rejected (wrong key material)');
  }
  let masterKey: CryptoKey;
  try {
    masterKey = await importMasterKeyBytes(masterKeyBytes);
    const plaintext = await decryptPayloadV4(masterKey, blob);
    const p = parseAndMigrateVaultPayload(plaintext);
    assertVaultPayload(p);
    // synthesise a kdfMeta from the first password envelope if any (for cache rehydrate compat).
    const pw = blob.envelopes.find((e): e is PasswordEnvelope => e.kind === 'password');
    const kdfMeta: VaultKdfMeta = pw
      ? { kdf: 'argon2id', salt: pw.salt, t: pw.t, m: pw.m, p: pw.p }
      : { kdf: 'argon2id', salt: '', t: 0, m: 0, p: 0 };
    return { keyBytes: masterKeyBytes, key: masterKey, kdfMeta, payload: p };
  } catch (e) {
    masterKeyBytes.fill(0);
    throw e;
  }
}

/**
 * v3 → v4 migration on password unlock. decrypt the v3 blob with the user's password (same
 * argon2id+aes-gcm flow as before), generate a fresh master key, wrap it under the existing
 * password's KEK + the v3 KDF params (so we don't ask the user to wait for another argon2id
 * pass), re-encrypt the payload under the master key, persist as v4.
 */
async function unlockV3AndMigrate(
  password: string,
  blobJson: string,
): Promise<{ keyBytes: Uint8Array; key: CryptoKey; kdfMeta: VaultKdfMeta; payload: VaultPayloadV3 }> {
  const blob = parseVaultBlob(blobJson);
  const kdfMeta = blobToKdfMeta(blob);
  const kekBytes = await deriveVaultKeyBytes(password, kdfMeta);
  let kek: CryptoKey;
  let plaintext: string;
  try {
    kek = await importKeyBytesToVaultKey(kekBytes);
    try {
      plaintext = await decryptWithKey(kek, blob);
    } catch {
      throw new Error('Wrong password');
    }
  } finally {
    // intentionally don't zero kekBytes yet - we reuse them to wrap the master key below.
  }
  const masterKeyBytes = freshMasterKeyBytes();
  try {
    const masterKey = await importMasterKeyBytes(masterKeyBytes);
    // build a password envelope using the SAME argon2id params + salt the user already
    // typed against, so the next unlock is cheap (no extra argon2id pass needed beyond what
    // they would have done anyway).
    const { wrapIv, wrappedMasterKey } = await wrapMasterKey(masterKeyBytes, kek);
    const env: PasswordEnvelope = {
      id: `env-pw-${Date.now()}`,
      kind: 'password',
      label: 'password',
      addedAtEpochMs: Date.now(),
      kdf: 'argon2id',
      salt: kdfMeta.salt,
      t: kdfMeta.t,
      m: kdfMeta.m,
      p: kdfMeta.p,
      wrapIv,
      wrappedMasterKey,
    };
    const v4Json = await buildV4BlobFromEnvelopes([env], masterKey, plaintext);
    await writeBlob(v4Json);
    const p = parseAndMigrateVaultPayload(plaintext);
    assertVaultPayload(p);
    return { keyBytes: masterKeyBytes, key: masterKey, kdfMeta, payload: p };
  } finally {
    kekBytes.fill(0);
  }
}

/* =============================================================================
 * envelope-add helpers (called when a user adds a non-password unlock method while unlocked)
 * ============================================================================= */

/**
 * read the in-session master key bytes from the unlock cache. required for envelope-add
 * operations because v4 master keys are imported as non-extractable `CryptoKey` (so we can't
 * recover bytes from `s.vaultKey`). the cache holds them base64-encoded in chrome.storage.session.
 *
 * **caller MUST `.fill(0)` the returned bytes after use.** returns null when the wallet is
 * locked (no cache row) or the cache is corrupt.
 */
export async function readSessionMasterKeyBytes(): Promise<Uint8Array | null> {
  // dynamic import avoids a circular dep with session-state.ts (which imports vault.ts).
  const { readUnlockCache } = await import('@/background/session-state');
  const cache = await readUnlockCache();
  if (!cache) return null;
  try {
    const bin = atob(cache.vaultKeyB64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.length === 32 ? out : null;
  } catch {
    return null;
  }
}

/**
 * append a passkey envelope to the current blob (wallet must be unlocked). master key is
 * already in `cred.key` form; we re-wrap its underlying bytes under the new KEK.
 *
 * SECURITY NOTE: webcrypto can't export the master key (it's non-extractable). to wrap it
 * under a new envelope we need either (a) the raw bytes from the unlock cache, or (b) a
 * separate "wrap" key handle that webcrypto allows. since v4 master keys are imported with
 * the `extractable: false` flag, option (a) is the path: the caller must supply the bytes
 * from the in-session unlock cache.
 */
export async function appendPasskeyEnvelope(
  masterKeyBytes: Uint8Array,
  prfSecret: Uint8Array,
  fields: { credentialIdB64Url: string; rpId: string; prfSaltB64: string; label?: string },
): Promise<void> {
  const blob = await loadV4BlobOrThrow();
  const envelope = await buildPasskeyPrfEnvelope(masterKeyBytes, prfSecret, fields);
  const next: VaultBlobV4 = { ...blob, envelopes: [...blob.envelopes, envelope] };
  await writeBlob(JSON.stringify(next));
}

export async function appendWalletSignatureEnvelope(
  masterKeyBytes: Uint8Array,
  signature: Uint8Array,
  fields: {
    source: 'waap' | 'seeker' | 'walletconnect';
    address: string;
    hint?: string;
    label?: string;
  },
): Promise<void> {
  const blob = await loadV4BlobOrThrow();
  const envelope = await buildWalletSignatureEnvelope(masterKeyBytes, signature, fields);
  const next: VaultBlobV4 = { ...blob, envelopes: [...blob.envelopes, envelope] };
  await writeBlob(JSON.stringify(next));
}

export async function appendPasswordEnvelopeBytes(
  masterKeyBytes: Uint8Array,
  password: string,
  label?: string,
): Promise<void> {
  const blob = await loadV4BlobOrThrow();
  const envelope = await buildPasswordEnvelope(masterKeyBytes, password, { label: label ?? 'password' });
  const next: VaultBlobV4 = { ...blob, envelopes: [...blob.envelopes, envelope] };
  await writeBlob(JSON.stringify(next));
}

/** remove an envelope by id (e.g. user dropped their password unlock). */
export async function removeEnvelope(envelopeId: string): Promise<void> {
  const blob = await loadV4BlobOrThrow();
  const remaining = blob.envelopes.filter((e) => e.id !== envelopeId);
  if (remaining.length === 0) {
    throw new Error('Cannot remove the last envelope - wallet would be permanently locked.');
  }
  if (remaining.length === blob.envelopes.length) {
    throw new Error(`No envelope with id ${envelopeId}`);
  }
  const next: VaultBlobV4 = { ...blob, envelopes: remaining };
  await writeBlob(JSON.stringify(next));
}

// re-exports for legacy v3 callers that still reach in (will go away after full v4 cutover).
export { encryptVaultFresh, freshKdfMeta };

// envelope-build helpers re-exported so wallet-service can compose its own envelope sets.
export {
  buildPasskeyPrfEnvelope,
  buildPasswordEnvelope,
  buildRecoveryWordsEnvelope,
  buildWalletSignatureEnvelope,
};
