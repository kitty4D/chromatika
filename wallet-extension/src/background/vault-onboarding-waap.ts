/**
 * waap (`@human.tech/waap-sdk`) onboarding paths. waap provides email / phone / social auth
 * via human network 2PC, surfaced as a Sui wallet-standard wallet. ika dWallet on Sui base;
 * Solana / EVM / BTC / Aptos addresses come from the dWallet MPC layer.
 *
 * seed source depends on whether waap's Sui signatures are deterministic over a fixed input:
 *   - `waap-signature` (deterministic, verified at pairing): seed = `keccak(sig || index_le)`,
 *     same shape as the seeker MWA pattern. signature stored encrypted in the vault record.
 *   - `recovery-words` (non-deterministic): caller must supply a 24-word BIP39 phrase. seed
 *     derives via `ikaRootSeedFromRecoveryWords`.
 *
 * the determinism probe happens UI-side (sign `IKA_USK_DERIVATION_MESSAGE` twice, compare).
 * the caller posts the result here as `seedSource` + the appropriate secret.
 */

import { getSession, setSession } from '@/background/session';
import {
  appendWalletSignatureEnvelope,
  buildPasswordEnvelope,
  buildWalletSignatureEnvelope,
  createInitialVaultBlobV4,
  loadVaultPayloadWithKey,
  readSessionMasterKeyBytes,
  storeEncryptedPayloadWithKey,
  walletExists,
} from '@/background/vault-store';
import type { VaultPayloadV3, VaultRecord } from '@/background/vault-types';
import {
  buildIkaShareKeys,
  fromB64,
  makeSeedFromMwaSignature,
  makeSeedFromRecoveryWords,
  nextIkaEncryptionIndex,
} from '@/background/vault-keys';
import { resolveCredentialOrUnlock } from '@/background/vault-credentials';
import { sessionStateFromRecord } from '@/background/vault-session-builder';
import {
  defaultSuiNetworkForNewVault,
  finalizeUnlock,
  kickDiscoveryForVault,
  type VaultEnvelopeForCreate,
} from '@/background/wallet-service-helpers';

/** shared seed-source dispatch. throws on missing material. */
function waapSeedFactoryFromInput(input: {
  seedSource: 'waap-signature' | 'recovery-words';
  pairingSignatureB64?: string;
  recoveryWords?: string;
  encryptionKeyIndex?: number;
}): () => Uint8Array {
  const idx = Math.max(0, Math.floor(input.encryptionKeyIndex ?? 0));
  if (input.seedSource === 'waap-signature') {
    const sigB64 = input.pairingSignatureB64?.trim();
    if (!sigB64) {
      throw new Error(
        'waap-signature seed source requires pairingSignatureB64 from the determinism probe; '
        + 'fall back to recovery-words if waap signatures are non-deterministic on this device.',
      );
    }
    return makeSeedFromMwaSignature(fromB64(sigB64), idx);
  }
  const words = input.recoveryWords?.trim().replace(/\s+/g, ' ');
  if (!words) {
    throw new Error('recovery-words seed source requires a 24-word phrase');
  }
  return makeSeedFromRecoveryWords(words, idx);
}

export async function createWaapVault(
  password: string | undefined,
  input: {
    /** Sui address waap returned at login (e.g. "0x…"). vault's user-facing address. */
    waapSuiAddress: string;
    /** base64(33-byte compressed), wallet-standard accounts[0].publicKey, secp256k1 per waap-sdk types. */
    waapSuiPublicKeyB64: string;
    /** which login method the user picked at pairing (diagnostic only). */
    waapAuthMethod: 'email' | 'phone' | 'social';
    waapSocialProvider?: 'google' | 'discord' | 'twitter' | 'github' | 'bluesky';
    seedSource: 'waap-signature' | 'recovery-words';
    pairingSignatureB64?: string;
    recoveryWords?: string;
    label?: string;
  },
): Promise<{ vaultId: string; suiAddress: string }> {
  if (await walletExists()) {
    return addWaapVault(password, input);
  }
  const wantPassword = typeof password === 'string' && password.length > 0;
  if (wantPassword && (password as string).length < 8) {
    throw new Error('Password must be at least 8 characters (or omit it for waap-only unlock)');
  }
  // a waap-only bootstrap (no password) is only valid if the waap signature is deterministic,
  // otherwise there's no envelope at all, and a recovery-words fallback hasn't shipped yet.
  if (!wantPassword && (input.seedSource !== 'waap-signature' || !input.pairingSignatureB64)) {
    throw new Error(
      'Password is required when waap signatures are non-deterministic. set a password or retry on a device where waap is deterministic.',
    );
  }

  const seedFactory = waapSeedFactoryFromInput(input);
  const { ikaShareKeysB64 } = await buildIkaShareKeys(seedFactory, {});

  // Persist the recovery phrase inside the encrypted vault blob when seedSource is
  // 'recovery-words'. Used by the future "show recovery code" UI for backup hygiene
  // (mirror of Lazor's `lazorSeedMaterialsFromInput.recoveryWordsEncryptedB64`). The
  // outer vault blob's Argon2id + AES-GCM does the actual encryption; the field is just
  // base64 so it's safe to embed in JSON inside the blob.
  const wordsForRecord =
    input.seedSource === 'recovery-words' && input.recoveryWords
      ? input.recoveryWords.trim().replace(/\s+/g, ' ')
      : null;

  const id = crypto.randomUUID();
  const network = defaultSuiNetworkForNewVault();
  const record: VaultRecord = {
    id,
    label: input.label?.trim() || 'default',
    baseChain: 'sui',
    accountKind: 'waap',
    waapSuiAddress: input.waapSuiAddress,
    waapSuiPublicKeyB64: input.waapSuiPublicKeyB64,
    waapAuthMethod: input.waapAuthMethod,
    ...(input.waapSocialProvider ? { waapSocialProvider: input.waapSocialProvider } : {}),
    seedSource: input.seedSource,
    ...(input.seedSource === 'waap-signature' && input.pairingSignatureB64
      ? { waapPairingSignatureB64: input.pairingSignatureB64 }
      : {}),
    ...(wordsForRecord ? { recoveryWordsEncryptedB64: btoa(wordsForRecord) } : {}),
    network,
    ikaShareKeysB64,
    dwalletMeta: {},
    createdAtMs: Date.now(),
  };

  const payload: VaultPayloadV3 = { v: 3, vaults: [record], activeVaultId: id };
  const created = await createInitialVaultBlobV4(
    async (mk) => {
      const envs: VaultEnvelopeForCreate[] = [];
      if (wantPassword) {
        envs.push(await buildPasswordEnvelope(mk, password as string, { label: 'password' }));
      }
      if (input.seedSource === 'waap-signature' && input.pairingSignatureB64) {
        const sigBytes = fromB64(input.pairingSignatureB64);
        envs.push(
          await buildWalletSignatureEnvelope(mk, sigBytes, {
            source: 'waap',
            address: input.waapSuiAddress,
            label: `waap · ${(input.label?.trim() || 'default').slice(0, 24)}`,
            hint: input.waapAuthMethod,
          }),
        );
      }
      return envs;
    },
    payload,
  );
  // immediately unlock the freshly-created waap wallet, same pattern as passkey above.
  await finalizeUnlock(
    { keyBytes: created.masterKeyBytes, key: created.key, kdfMeta: created.kdfMeta, payload },
    { autoLockMinutes: 30, isFreshlyCreated: true },
  );
  return { vaultId: id, suiAddress: input.waapSuiAddress };
}

export async function addWaapVault(
  password: string | undefined,
  input: {
    waapSuiAddress: string;
    waapSuiPublicKeyB64: string;
    waapAuthMethod: 'email' | 'phone' | 'social';
    waapSocialProvider?: 'google' | 'discord' | 'twitter' | 'github' | 'bluesky';
    seedSource: 'waap-signature' | 'recovery-words';
    pairingSignatureB64?: string;
    recoveryWords?: string;
    label?: string;
    /** BIP44-style ika encryption-key index for sibling vaults from the SAME waap login. */
    ikaEncryptionIndex?: number;
  },
): Promise<{ vaultId: string; suiAddress: string; ikaEncryptionIndex: number }> {
  const cred = await resolveCredentialOrUnlock(password);

  // auto-detect: when the caller didn't pass an explicit index, pick `max(siblings) + 1` for the
  // same waap Sui address. callers can fire `runWaapAddVault` repeatedly for the same login and
  // get a clean sibling vault each time without external coordination.
  let resolvedIkaEncryptionIndex: number;
  if (typeof input.ikaEncryptionIndex === 'number') {
    resolvedIkaEncryptionIndex = Math.max(0, Math.floor(input.ikaEncryptionIndex));
  } else {
    const payloadForScan = await loadVaultPayloadWithKey(cred.key);
    resolvedIkaEncryptionIndex = nextIkaEncryptionIndex(
      payloadForScan,
      (v) => v.accountKind === 'waap' && v.waapSuiAddress === input.waapSuiAddress,
    );
  }
  const ikaEncryptionIndex = resolvedIkaEncryptionIndex;

  const seedFactory = waapSeedFactoryFromInput({ ...input, encryptionKeyIndex: ikaEncryptionIndex });
  const { ikaShareKeysB64 } = await buildIkaShareKeys(seedFactory, {});

  // Same recovery-words persistence as createWaapVault (mirror of Lazor pattern).
  const wordsForRecord =
    input.seedSource === 'recovery-words' && input.recoveryWords
      ? input.recoveryWords.trim().replace(/\s+/g, ' ')
      : null;

  const id = crypto.randomUUID();
  const network = defaultSuiNetworkForNewVault();
  const record: VaultRecord = {
    id,
    label: input.label?.trim() || 'waap',
    baseChain: 'sui',
    accountKind: 'waap',
    waapSuiAddress: input.waapSuiAddress,
    waapSuiPublicKeyB64: input.waapSuiPublicKeyB64,
    waapAuthMethod: input.waapAuthMethod,
    ...(input.waapSocialProvider ? { waapSocialProvider: input.waapSocialProvider } : {}),
    seedSource: input.seedSource,
    ...(ikaEncryptionIndex > 0 ? { ikaEncryptionIndex } : {}),
    ...(input.seedSource === 'waap-signature' && input.pairingSignatureB64
      ? { waapPairingSignatureB64: input.pairingSignatureB64 }
      : {}),
    ...(wordsForRecord ? { recoveryWordsEncryptedB64: btoa(wordsForRecord) } : {}),
    network,
    ikaShareKeysB64,
    dwalletMeta: {},
    createdAtMs: Date.now(),
  };

  const existing = await loadVaultPayloadWithKey(cred.key);
  existing.vaults.push(record);
  existing.activeVaultId = id;
  await storeEncryptedPayloadWithKey(cred, existing);

  // append wallet-signature envelope for deterministic waap so this waap account becomes a
  // real unlock method on the wallet. recovery-words variant skips this (no signature to wrap).
  if (input.seedSource === 'waap-signature' && input.pairingSignatureB64) {
    const masterKeyBytes = await readSessionMasterKeyBytes();
    if (masterKeyBytes) {
      try {
        const sigBytes = fromB64(input.pairingSignatureB64);
        await appendWalletSignatureEnvelope(masterKeyBytes, sigBytes, {
          source: 'waap',
          address: input.waapSuiAddress,
          label: `waap · ${(input.label?.trim() || 'waap').slice(0, 24)}`,
          hint: input.waapAuthMethod,
        });
      } finally {
        masterKeyBytes.fill(0);
      }
    }
  }

  if (getSession()) {
    setSession(await sessionStateFromRecord(record, cred));
    void kickDiscoveryForVault(id);
  }
  return { vaultId: id, suiAddress: input.waapSuiAddress, ikaEncryptionIndex };
}
