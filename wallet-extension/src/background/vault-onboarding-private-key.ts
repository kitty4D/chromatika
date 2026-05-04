/**
 * onboarding paths for vaults whose root identity is a raw private key (Sui `suiprivkey…`
 * bech32 or Solana 64-byte secret key base64). extracted from `wallet-service.ts` so the
 * per-method onboarding modules don't share that file's monolith.
 *
 * two functions:
 *   - `importVaultFromSuiPrivateKey`: first-vault path. creates the encrypted blob from
 *     scratch under a fresh password.
 *   - `addVaultImportedFromPrivateKey`: sibling-vault path. requires unlocked session OR
 *     password to decrypt the existing blob, then appends the new vault.
 *
 * Sui-base needs `suiPrivateKeyBech32`. Solana-base needs `solanaSecretKeyB64`. when both
 * are supplied, only the active base chain's key is used; the other is validated for shape
 * but otherwise ignored. ika `UserShareEncryptionKeys` are derived from the chosen key
 * via `buildIkaShareKeys` + `makeSeedFromSuiKeypair` / `makeSeedFromSolanaKeypair`.
 */

import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import type { BaseChain } from '@/background/ika/ika-adapter';
import { getSession, setSession } from '@/background/session';
import {
  createInitialVaultBlob,
  loadVaultPayloadWithKey,
  storeEncryptedPayloadWithKey,
} from '@/background/vault-store';
import type { VaultPayloadV3, VaultRecord } from '@/background/vault-types';
import {
  buildIkaShareKeys,
  makeSeedFromSolanaKeypair,
  makeSeedFromSuiKeypair,
  solanaKeypairFromB64,
} from '@/background/vault-keys';
import { resolveCredentialOrUnlock } from '@/background/vault-credentials';
import { sessionStateFromRecord } from '@/background/vault-session-builder';
import {
  kickDiscoveryForVault,
  persistVaultFromSession,
  defaultSuiNetworkForNewVault,
} from '@/background/wallet-service-helpers';

/**
 * first vault from a hot privkey. Sui base requires `suiPrivateKeyBech32`; Solana base requires
 * `solanaSecretKeyB64` (and Sui privkey is unused, ignored if also provided).
 */
export async function importVaultFromSuiPrivateKey(
  password: string,
  input: {
    suiPrivateKeyBech32?: string;
    solanaSecretKeyB64?: string;
    baseChain?: BaseChain;
    label?: string;
  },
): Promise<{ vaultId: string }> {
  const baseChain = input.baseChain ?? 'sui';
  const trimmedSui = input.suiPrivateKeyBech32?.trim();
  const trimmedSol = input.solanaSecretKeyB64?.trim();
  let seedFactory: () => Uint8Array;
  if (baseChain === 'solana') {
    if (!trimmedSol) throw new Error('Solana ika base requires solanaSecretKeyB64 (64-byte keypair, base64)');
    const solKp = solanaKeypairFromB64(trimmedSol);
    if (trimmedSui) Ed25519Keypair.fromSecretKey(trimmedSui);
    seedFactory = makeSeedFromSolanaKeypair(solKp);
  } else {
    if (!trimmedSui) throw new Error('Sui ika base requires suiPrivateKeyBech32 (suiprivkey…)');
    const suiKp = Ed25519Keypair.fromSecretKey(trimmedSui);
    seedFactory = makeSeedFromSuiKeypair(suiKp);
  }
  const id = crypto.randomUUID();
  const network = defaultSuiNetworkForNewVault();
  const { ikaShareKeysB64 } = await buildIkaShareKeys(seedFactory, {});
  const record: VaultRecord = {
    id,
    label: input.label?.trim() || 'imported',
    baseChain,
    accountKind: 'importedKey',
    suiPrivateKeyBech32: trimmedSui,
    solanaSecretKeyB64: trimmedSol,
    network,
    ikaShareKeysB64,
    dwalletMeta: {},
    createdAtMs: Date.now(),
  };
  const payload: VaultPayloadV3 = { v: 3, vaults: [record], activeVaultId: id };
  await createInitialVaultBlob(password, payload);
  return { vaultId: id };
}

/** add imported-key vault while unlocked or locked (password). same input rules as `importVaultFromSuiPrivateKey`. */
export async function addVaultImportedFromPrivateKey(
  password: string | undefined,
  input: {
    suiPrivateKeyBech32?: string;
    solanaSecretKeyB64?: string;
    baseChain?: BaseChain;
    label?: string;
  },
): Promise<{ vaultId: string }> {
  const baseChain = input.baseChain ?? 'sui';
  const trimmedSui = input.suiPrivateKeyBech32?.trim();
  const trimmedSol = input.solanaSecretKeyB64?.trim();
  let seedFactory: () => Uint8Array;
  if (baseChain === 'solana') {
    if (!trimmedSol) throw new Error('Solana ika base requires solanaSecretKeyB64');
    const solKp = solanaKeypairFromB64(trimmedSol);
    if (trimmedSui) Ed25519Keypair.fromSecretKey(trimmedSui);
    seedFactory = makeSeedFromSolanaKeypair(solKp);
  } else {
    if (!trimmedSui) throw new Error('Sui ika base requires suiPrivateKeyBech32');
    const suiKp = Ed25519Keypair.fromSecretKey(trimmedSui);
    seedFactory = makeSeedFromSuiKeypair(suiKp);
  }
  if (getSession()) await persistVaultFromSession();
  const cred = await resolveCredentialOrUnlock(password);
  const payload = await loadVaultPayloadWithKey(cred.key);
  const id = crypto.randomUUID();
  const network = defaultSuiNetworkForNewVault();
  const { ikaShareKeysB64 } = await buildIkaShareKeys(seedFactory, {});
  const record: VaultRecord = {
    id,
    label: input.label?.trim() || `vault ${payload.vaults.length + 1}`,
    baseChain,
    accountKind: 'importedKey',
    suiPrivateKeyBech32: trimmedSui,
    solanaSecretKeyB64: trimmedSol,
    network,
    ikaShareKeysB64,
    dwalletMeta: {},
    createdAtMs: Date.now(),
  };
  payload.vaults.push(record);
  payload.activeVaultId = id;
  await storeEncryptedPayloadWithKey(cred, payload);
  if (getSession()) {
    setSession(await sessionStateFromRecord(record, cred));
    void kickDiscoveryForVault(id);
  }
  return { vaultId: id };
}
