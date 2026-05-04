/**
 * onboarding path for "anchored" vaults: a sibling vault scoped to a specific dWallet object.
 * the vault still needs a hot fee key (Sui privkey or Solana keypair) to pay ika protocol
 * fees, but its dWallet discovery is restricted to the anchor object id rather than scanning
 * the fee-payer's whole owned-objects set.
 *
 * extracted from `wallet-service.ts` to keep per-method onboarding modules consistent. only
 * one entry point: `addDwalletAnchoredVault` (anchored vaults are always sibling-additions,
 * never a first vault - the anchor must already exist on chain).
 */

import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import type { BaseChain } from '@/background/ika/ika-adapter';
import { getSession, setSession } from '@/background/session';
import {
  loadVaultPayloadWithKey,
  storeEncryptedPayloadWithKey,
} from '@/background/vault-store';
import type { VaultRecord } from '@/background/vault-types';
import {
  buildIkaShareKeys,
  makeSeedFromSolanaKeypair,
  makeSeedFromSuiKeypair,
  solanaKeypairFromB64,
} from '@/background/vault-keys';
import { resolveCredentialOrUnlock } from '@/background/vault-credentials';
import { sessionStateFromRecord } from '@/background/vault-session-builder';
import {
  defaultSuiNetworkForNewVault,
  kickDiscoveryForVault,
  persistVaultFromSession,
} from '@/background/wallet-service-helpers';

export async function addDwalletAnchoredVault(
  password: string | undefined,
  input: {
    anchorDwalletId: string;
    suiPrivateKeyBech32?: string;
    solanaSecretKeyB64?: string;
    baseChain?: BaseChain;
    label?: string;
  },
): Promise<{ vaultId: string }> {
  const anchor = input.anchorDwalletId.trim();
  const baseChain = input.baseChain ?? 'sui';
  if (baseChain === 'sui') {
    if (!anchor.startsWith('0x') || anchor.length !== 66) {
      throw new Error('anchorDwalletId must be a 0x + 64 hex Sui object id');
    }
  } else if (!anchor.length) {
    throw new Error('anchorDwalletId required');
  }
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
    label: input.label?.trim() || `anchored ${payload.vaults.length + 1}`,
    baseChain,
    accountKind: 'dwalletAnchored',
    anchorDwalletId: anchor,
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
