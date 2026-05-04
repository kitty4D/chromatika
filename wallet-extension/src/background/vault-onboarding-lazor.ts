/**
 * Lazor (`@lazorkit/wallet`) onboarding paths. Solana-native passkey smart wallet on the
 * Lazor anchor program. portal-hosted WebAuthn means we can't access PRF, so v1 supports
 * two seed paths:
 *   - `lazor-signature` (recommended/experimental): the Lazor passkey signs
 *     `IKA_USK_DERIVATION_MESSAGE_LAZOR_V1` at pairing; chromatika does a determinism probe
 *     client-side (sign twice + compare). when deterministic, signature is the ika seed
 *     authority + fee payer derives from the same signature.
 *   - `recovery-words`: 24-word phrase as the ika seed authority. works on any authenticator
 *     (including non-deterministic ones); fee payer derives via SLIP10 from the phrase.
 *
 * the Lazor smart-wallet PDA (returned by the portal connect dialog) is the user's
 * **user-facing Solana address**. cross-chain addresses come from the ika dWallet seeded by
 * the phrase / signature.
 */

import { Keypair } from '@solana/web3.js';
import { mnemonicToSeedSync } from '@scure/bip39';
import { getSession, setSession } from '@/background/session';
import {
  buildPasswordEnvelope,
  buildRecoveryWordsEnvelope,
  createInitialVaultBlobV4,
  loadVaultPayloadWithKey,
  storeEncryptedPayloadWithKey,
  walletExists,
} from '@/background/vault-store';
import type { VaultPayloadV3, VaultRecord } from '@/background/vault-types';
import {
  deriveSolanaKeypair,
  solanaFeeKeypairFromWalletSignature,
  validateWords,
} from '@/background/keyring/hd';
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

/** shared seed-source dispatch for createLazorVault / addLazorVault. */
function lazorSeedMaterialsFromInput(input: {
  seedSource: 'lazor-signature' | 'recovery-words';
  recoveryWords?: string;
  pairingSignatureB64?: string;
  ikaEncryptionIndex: number;
}): {
  seedFactory: () => Uint8Array;
  feePayer: Keypair;
  feePayerSecretKeyB64: string;
  bip39SeedForRecoveryEnvelope: Uint8Array | null;
  recoveryWordsEncryptedB64: string | null;
  lazorPairingSignatureB64: string | null;
} {
  if (input.seedSource === 'lazor-signature') {
    const sigB64 = input.pairingSignatureB64?.trim();
    if (!sigB64) {
      throw new Error('lazor-signature seed source requires the pairing signature from the determinism probe');
    }
    const sigBytes = fromB64(sigB64);
    const seedFactory = makeSeedFromMwaSignature(sigBytes, input.ikaEncryptionIndex);
    // fee payer derived from the same signature, different domain index (matches seeker's pattern).
    // same Lazor passkey on any device -> same signature -> same fee payer address -> SOL persists
    // across reinstalls.
    const feePayer = solanaFeeKeypairFromWalletSignature(sigBytes);
    return {
      seedFactory,
      feePayer,
      feePayerSecretKeyB64: btoa(String.fromCharCode(...feePayer.secretKey)),
      bip39SeedForRecoveryEnvelope: null,
      recoveryWordsEncryptedB64: null,
      lazorPairingSignatureB64: sigB64,
    };
  }
  const words = input.recoveryWords?.trim().replace(/\s+/g, ' ');
  if (!words) {
    throw new Error('recovery-words seed source requires a 24-word phrase');
  }
  if (!validateWords(words)) throw new Error('Invalid recovery phrase');
  const seedFactory = makeSeedFromRecoveryWords(words, input.ikaEncryptionIndex);
  const feePayer = deriveSolanaKeypair(words, 0);
  return {
    seedFactory,
    feePayer,
    feePayerSecretKeyB64: btoa(String.fromCharCode(...feePayer.secretKey)),
    bip39SeedForRecoveryEnvelope: mnemonicToSeedSync(words),
    recoveryWordsEncryptedB64: btoa(words),
    lazorPairingSignatureB64: null,
  };
}

export async function createLazorVault(
  password: string,
  input: {
    /** Lazor-portal-returned smart wallet PDA (base58). vault's user-facing Solana address. */
    lazorSmartWalletPubkeyB58: string;
    /** Lazor-portal-returned credential id (base64). */
    lazorCredentialIdB64: string;
    /** Lazor-portal-returned passkey public key (base64 of raw secp256r1 pk). */
    lazorPasskeyPubkeyB64: string;
    /** Lazor anchor program id pinned at pairing. */
    lazorProgramId: string;
    lazorNetwork: 'mainnet' | 'devnet';
    /** Lazor portal origin used at pairing (e.g. https://portal.lazor.sh). */
    lazorPortalUrl: string;
    /** wallet device PDA, links credential to smart wallet on chain (optional; lazorClient resolves it). */
    lazorWalletDevicePubkeyB58?: string;
    seedSource: 'lazor-signature' | 'recovery-words';
    recoveryWords?: string;
    pairingSignatureB64?: string;
    label?: string;
  },
): Promise<{ vaultId: string; suiAddress: string; lazorSmartWalletPubkey: string }> {
  if (!password || password.length < 8) throw new Error('Password required');
  if (await walletExists()) {
    return addLazorVault(password, input);
  }

  const materials = lazorSeedMaterialsFromInput({
    seedSource: input.seedSource,
    recoveryWords: input.recoveryWords,
    pairingSignatureB64: input.pairingSignatureB64,
    ikaEncryptionIndex: 0,
  });

  const { ikaShareKeysB64 } = await buildIkaShareKeys(materials.seedFactory, {});

  const id = crypto.randomUUID();
  const network = defaultSuiNetworkForNewVault();
  const record: VaultRecord = {
    id,
    label: input.label?.trim() || 'default',
    baseChain: 'solana',
    accountKind: 'lazor',
    lazorSmartWalletPubkeyB58: input.lazorSmartWalletPubkeyB58,
    lazorCredentialIdB64: input.lazorCredentialIdB64,
    lazorPasskeyPubkeyB64: input.lazorPasskeyPubkeyB64,
    ...(input.lazorWalletDevicePubkeyB58 ? { lazorWalletDevicePubkeyB58: input.lazorWalletDevicePubkeyB58 } : {}),
    lazorPortalUrl: input.lazorPortalUrl,
    lazorProgramId: input.lazorProgramId,
    lazorNetwork: input.lazorNetwork,
    seedSource: input.seedSource,
    ...(materials.recoveryWordsEncryptedB64
      ? { recoveryWordsEncryptedB64: materials.recoveryWordsEncryptedB64 }
      : {}),
    ...(materials.lazorPairingSignatureB64
      ? { lazorPairingSignatureB64: materials.lazorPairingSignatureB64 }
      : {}),
    lazorIkaFeePayerSolSecretKeyB64: materials.feePayerSecretKeyB64,
    network,
    ikaShareKeysB64,
    dwalletMeta: {},
    createdAtMs: Date.now(),
  };
  const payload: VaultPayloadV3 = { v: 3, vaults: [record], activeVaultId: id };
  // v4 multi-envelope: every lazor vault gets a password envelope. recovery-words path adds a
  // BIP39-phrase unlock envelope so the user can unlock by re-typing the phrase. lazor-signature
  // path skips the phrase envelope (no phrase exists) - unlock relies on password until a
  // future slice ships passkey-signature unlock for lazor.
  const created = await createInitialVaultBlobV4(
    async (mk) => {
      const envs: VaultEnvelopeForCreate[] = [await buildPasswordEnvelope(mk, password, { label: 'password' })];
      if (materials.bip39SeedForRecoveryEnvelope) {
        envs.push(
          await buildRecoveryWordsEnvelope(mk, materials.bip39SeedForRecoveryEnvelope, {
            wordCount: 24,
            label: `recovery phrase · ${(input.label?.trim() || 'default').slice(0, 24)}`,
          }),
        );
        materials.bip39SeedForRecoveryEnvelope.fill(0);
      }
      return envs;
    },
    payload,
  );
  // immediately unlock the freshly-created lazor wallet.
  await finalizeUnlock(
    { keyBytes: created.masterKeyBytes, key: created.key, kdfMeta: created.kdfMeta, payload },
    30,
  );

  return {
    vaultId: id,
    suiAddress: '', // lazor vault has no Sui-side fee payer; Sui address is exposed via dWallet MPC post-DKG.
    lazorSmartWalletPubkey: input.lazorSmartWalletPubkeyB58,
  };
}

export async function addLazorVault(
  password: string | undefined,
  input: {
    lazorSmartWalletPubkeyB58: string;
    lazorCredentialIdB64: string;
    lazorPasskeyPubkeyB64: string;
    lazorProgramId: string;
    lazorNetwork: 'mainnet' | 'devnet';
    lazorPortalUrl: string;
    lazorWalletDevicePubkeyB58?: string;
    seedSource: 'lazor-signature' | 'recovery-words';
    recoveryWords?: string;
    pairingSignatureB64?: string;
    label?: string;
    /** BIP44-style ika encryption-key index for sibling vaults from the SAME Lazor smart wallet. */
    ikaEncryptionIndex?: number;
  },
): Promise<{ vaultId: string; suiAddress: string; lazorSmartWalletPubkey: string; ikaEncryptionIndex: number }> {
  const cred = await resolveCredentialOrUnlock(password);

  // auto-detect: when the caller didn't pass an explicit index, pick `max(siblings) + 1` for the
  // same Lazor smart-wallet PDA. callers can fire `runLazorAddVault` repeatedly for the same
  // smart wallet + phrase and get a clean sibling vault each time.
  let resolvedIkaEncryptionIndex: number;
  if (typeof input.ikaEncryptionIndex === 'number') {
    resolvedIkaEncryptionIndex = Math.max(0, Math.floor(input.ikaEncryptionIndex));
  } else {
    const payloadForScan = await loadVaultPayloadWithKey(cred.key);
    resolvedIkaEncryptionIndex = nextIkaEncryptionIndex(
      payloadForScan,
      (v) => v.accountKind === 'lazor' && v.lazorSmartWalletPubkeyB58 === input.lazorSmartWalletPubkeyB58,
    );
  }
  const ikaEncryptionIndex = resolvedIkaEncryptionIndex;

  const materials = lazorSeedMaterialsFromInput({
    seedSource: input.seedSource,
    recoveryWords: input.recoveryWords,
    pairingSignatureB64: input.pairingSignatureB64,
    ikaEncryptionIndex,
  });
  // BIP39 seed for the recovery-words envelope is no longer needed at the add-vault path - the
  // primary password envelope is already attached to the wallet from the bootstrap vault.
  if (materials.bip39SeedForRecoveryEnvelope) materials.bip39SeedForRecoveryEnvelope.fill(0);

  const { ikaShareKeysB64 } = await buildIkaShareKeys(materials.seedFactory, {});

  const id = crypto.randomUUID();
  const network = defaultSuiNetworkForNewVault();
  const record: VaultRecord = {
    id,
    label: input.label?.trim() || 'lazor',
    baseChain: 'solana',
    accountKind: 'lazor',
    lazorSmartWalletPubkeyB58: input.lazorSmartWalletPubkeyB58,
    lazorCredentialIdB64: input.lazorCredentialIdB64,
    lazorPasskeyPubkeyB64: input.lazorPasskeyPubkeyB64,
    ...(input.lazorWalletDevicePubkeyB58 ? { lazorWalletDevicePubkeyB58: input.lazorWalletDevicePubkeyB58 } : {}),
    lazorPortalUrl: input.lazorPortalUrl,
    lazorProgramId: input.lazorProgramId,
    lazorNetwork: input.lazorNetwork,
    seedSource: input.seedSource,
    ...(materials.recoveryWordsEncryptedB64
      ? { recoveryWordsEncryptedB64: materials.recoveryWordsEncryptedB64 }
      : {}),
    ...(materials.lazorPairingSignatureB64
      ? { lazorPairingSignatureB64: materials.lazorPairingSignatureB64 }
      : {}),
    lazorIkaFeePayerSolSecretKeyB64: materials.feePayerSecretKeyB64,
    ...(ikaEncryptionIndex > 0 ? { ikaEncryptionIndex } : {}),
    network,
    ikaShareKeysB64,
    dwalletMeta: {},
    createdAtMs: Date.now(),
  };

  const existing = await loadVaultPayloadWithKey(cred.key);
  existing.vaults.push(record);
  existing.activeVaultId = id;
  await storeEncryptedPayloadWithKey(cred, existing);

  if (getSession()) {
    setSession(await sessionStateFromRecord(record, cred));
    void kickDiscoveryForVault(id);
  }
  return {
    vaultId: id,
    suiAddress: '',
    lazorSmartWalletPubkey: input.lazorSmartWalletPubkeyB58,
    ikaEncryptionIndex,
  };
}
