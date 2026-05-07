/**
 * passkey onboarding paths. uses WebAuthn's hmac-secret extension (PRF) as a deterministic
 * 32-byte secret per (credential, salt). same passkey + same chromatika constant salt = same
 * PRF output across reinstalls and synced devices, which is what makes "passkey-only" the
 * sole unlock method work end-to-end.
 *
 * `createPasskeyVault`: first-vault path (or sibling-add if a blob already exists - delegates
 * to `addPasskeyVault`). password-free bootstrap is supported: the passkey envelope can be the
 * SOLE unlock method. password is OPTIONAL belt-and-suspenders.
 *
 * `addPasskeyVault`: sibling-add path. handles `passkeyEncryptionIndex` allocation for
 * multiple vaults backed by the SAME credential (BIP44-style index slots) so each sibling
 * derives a different ika seed.
 *
 * an optional `recoveryWords` 24-word phrase can replace the PRF as the seed source for the
 * cases where a credential's PRF isn't reliably accessible (some authenticators are flaky).
 * extracted from `wallet-service.ts` to keep per-method onboarding modules consistent.
 */

import { getSession, setSession } from '@/background/session';
import {
  appendPasskeyEnvelope,
  buildPasskeyPrfEnvelope,
  buildPasswordEnvelope,
  createInitialVaultBlobV4,
  loadVaultPayloadWithKey,
  readSessionMasterKeyBytes,
  storeEncryptedPayloadWithKey,
  walletExists,
} from '@/background/vault-store';
import type {
  PasskeyVaultRecord,
  VaultPayloadV3,
  VaultRecord,
} from '@/background/vault-types';
import {
  publicKeyCompressedToB64,
  suiAddressFromPasskeyPublicKey,
  validatePasskeyRegisterArtifacts,
} from '@/background/passkey/passkey-derive';
import {
  buildIkaShareKeys,
  makeSeedFromPasskeyPRF,
  makeSeedFromRecoveryWords,
  toB64,
} from '@/background/vault-keys';
import { resolveCredentialOrUnlock } from '@/background/vault-credentials';
import { sessionStateFromRecord } from '@/background/vault-session-builder';
import {
  defaultSuiNetworkForNewVault,
  finalizeUnlock,
  kickDiscoveryForVault,
  type VaultEnvelopeForCreate,
} from '@/background/wallet-service-helpers';

/**
 * first-vault passkey path. when a vault blob already exists, falls through to
 * `addPasskeyVault` so `password` decrypts the existing payload and the new passkey lands
 * as a sibling vault.
 */
export async function createPasskeyVault(
  password: string | undefined,
  input: {
    credentialIdB64Url: string;
    publicKeyCompressedB64: string;
    prfSecretB64: string;
    prfSaltB64: string;
    rpId: string;
    label?: string;
    recoveryWords?: string;
  },
): Promise<{ vaultId: string; suiAddress: string }> {
  if (await walletExists()) {
    return addPasskeyVault(password, input);
  }
  // password-free bootstrap is the v3-of-this-design point: when the user picks passkey-only,
  // the passkey envelope is the SOLE unlock method. they don't have to set a password they'll
  // never type. password is OPTIONAL, only added as a belt-and-suspenders fallback envelope
  // when the caller supplies one (8+ chars).
  const wantPassword = typeof password === 'string' && password.length > 0;
  if (wantPassword && (password as string).length < 8) {
    throw new Error('Password must be at least 8 characters (or omit it for passkey-only unlock)');
  }
  const { credentialIdRaw: _credId, publicKeyCompressed, prfSecret, prfSalt, rpId } =
    validatePasskeyRegisterArtifacts({
      credentialIdB64Url: input.credentialIdB64Url,
      publicKeyCompressedB64: input.publicKeyCompressedB64,
      prfSecretB64: input.prfSecretB64,
      prfSaltB64: input.prfSaltB64,
      rpId: input.rpId,
    });

  const seedSource: 'passkey-prf' | 'recovery-words' = input.recoveryWords ? 'recovery-words' : 'passkey-prf';
  const passkeyEncryptionIndex = 0;
  const seedFactory =
    seedSource === 'recovery-words'
      ? makeSeedFromRecoveryWords(input.recoveryWords!.trim().replace(/\s+/g, ' '))
      : makeSeedFromPasskeyPRF(prfSecret, passkeyEncryptionIndex);
  const { ikaShareKeysB64 } = await buildIkaShareKeys(seedFactory, {});

  const id = crypto.randomUUID();
  const network = defaultSuiNetworkForNewVault();
  const suiAddress = suiAddressFromPasskeyPublicKey(publicKeyCompressed);
  const record: VaultRecord = {
    id,
    label: input.label?.trim() || 'default',
    baseChain: 'sui',
    accountKind: 'passkey',
    passkeyCredentialId: input.credentialIdB64Url,
    passkeyPublicKeyB64: publicKeyCompressedToB64(publicKeyCompressed),
    passkeyRpId: rpId,
    passkeyPrfSaltB64: toB64(prfSalt),
    passkeyEncryptionIndex,
    seedSource,
    network,
    ikaShareKeysB64,
    dwalletMeta: {},
    createdAtMs: Date.now(),
  };

  const payload: VaultPayloadV3 = { v: 3, vaults: [record], activeVaultId: id };
  const created = await createInitialVaultBlobV4(
    async (mk) => {
      const envelopes: VaultEnvelopeForCreate[] = [
        await buildPasskeyPrfEnvelope(mk, prfSecret, {
          credentialIdB64Url: input.credentialIdB64Url,
          rpId,
          prfSaltB64: toB64(prfSalt),
          label: `passkey · ${(input.label?.trim() || 'default').slice(0, 24)}`,
        }),
      ];
      if (wantPassword) {
        envelopes.unshift(await buildPasswordEnvelope(mk, password as string, { label: 'password' }));
      }
      return envelopes;
    },
    payload,
  );
  // wipe PRF secret after persist. it's fetched fresh on every unlock (or every passkey-add).
  prfSecret.fill(0);
  // immediately unlock the freshly-created wallet, caller doesn't need to re-tap the passkey
  // (or type the password) to access it. master key bytes are passed straight through to
  // `finalizeUnlock`, which writes them to the unlock cache and zeros them.
  await finalizeUnlock(
    { keyBytes: created.masterKeyBytes, key: created.key, kdfMeta: created.kdfMeta, payload },
    { autoLockMinutes: 30, isFreshlyCreated: true },
  );
  return { vaultId: id, suiAddress };
}

/**
 * add a passkey vault as a sibling when a chromatika vault blob already exists. shares the
 * same `password` (decrypts the existing payload to merge the new record); becomes active iff
 * the session is currently unlocked.
 *
 * input shape matches `createPasskeyVault` since the popup-collected artifacts are identical.
 */
export async function addPasskeyVault(
  password: string | undefined,
  input: {
    credentialIdB64Url: string;
    publicKeyCompressedB64: string;
    prfSecretB64: string;
    prfSaltB64: string;
    rpId: string;
    label?: string;
    recoveryWords?: string;
  },
): Promise<{ vaultId: string; suiAddress: string }> {
  const cred = await resolveCredentialOrUnlock(password);
  const { credentialIdRaw: _credId, publicKeyCompressed, prfSecret, prfSalt, rpId } =
    validatePasskeyRegisterArtifacts({
      credentialIdB64Url: input.credentialIdB64Url,
      publicKeyCompressedB64: input.publicKeyCompressedB64,
      prfSecretB64: input.prfSecretB64,
      prfSaltB64: input.prfSaltB64,
      rpId: input.rpId,
    });

  // load the existing payload first - we need it to detect "same credential, new sibling vault"
  // and pick the next BIP44-style `passkeyEncryptionIndex`. for a brand-new credential, index 0.
  const existing = await loadVaultPayloadWithKey(cred.key);
  const sameCredentialIndices = existing.vaults
    .filter((v): v is PasskeyVaultRecord =>
      v.accountKind === 'passkey' && v.passkeyCredentialId === input.credentialIdB64Url,
    )
    .map((v) => v.passkeyEncryptionIndex ?? 0);
  const passkeyEncryptionIndex =
    sameCredentialIndices.length > 0 ? Math.max(...sameCredentialIndices) + 1 : 0;

  const seedSource: 'passkey-prf' | 'recovery-words' = input.recoveryWords ? 'recovery-words' : 'passkey-prf';
  const seedFactory =
    seedSource === 'recovery-words'
      ? makeSeedFromRecoveryWords(input.recoveryWords!.trim().replace(/\s+/g, ' '))
      : makeSeedFromPasskeyPRF(prfSecret, passkeyEncryptionIndex);
  const { ikaShareKeysB64 } = await buildIkaShareKeys(seedFactory, {});

  const id = crypto.randomUUID();
  const network = defaultSuiNetworkForNewVault();
  const suiAddress = suiAddressFromPasskeyPublicKey(publicKeyCompressed);
  const labelTrimmed = input.label?.trim() || 'passkey';
  const record: VaultRecord = {
    id,
    label: labelTrimmed,
    baseChain: 'sui',
    accountKind: 'passkey',
    passkeyCredentialId: input.credentialIdB64Url,
    passkeyPublicKeyB64: publicKeyCompressedToB64(publicKeyCompressed),
    passkeyRpId: rpId,
    passkeyPrfSaltB64: toB64(prfSalt),
    passkeyEncryptionIndex,
    seedSource,
    network,
    ikaShareKeysB64,
    dwalletMeta: {},
    createdAtMs: Date.now(),
  };

  // merge vault record into existing payload + persist
  existing.vaults.push(record);
  existing.activeVaultId = id;
  await storeEncryptedPayloadWithKey(cred, existing);

  // also append a passkey envelope so this passkey becomes a real unlock method on the wallet.
  // master key bytes come from the in-session unlock cache; envelope-add doesn't disturb the
  // existing password / other envelopes.
  const masterKeyBytes = await readSessionMasterKeyBytes();
  if (masterKeyBytes) {
    try {
      await appendPasskeyEnvelope(masterKeyBytes, prfSecret, {
        credentialIdB64Url: input.credentialIdB64Url,
        rpId,
        prfSaltB64: toB64(prfSalt),
        label: `passkey · ${labelTrimmed.slice(0, 24)}`,
      });
    } finally {
      masterKeyBytes.fill(0);
    }
  }
  prfSecret.fill(0);

  if (getSession()) {
    setSession(await sessionStateFromRecord(record, cred));
    void kickDiscoveryForVault(id);
  }
  return { vaultId: id, suiAddress };
}
