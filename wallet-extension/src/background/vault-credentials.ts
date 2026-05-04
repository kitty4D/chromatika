/**
 * shared credential resolver used by every "add vault" / mutate-vault path. extracted from
 * `wallet-service.ts` so per-method onboarding modules (passkey, waap, lazor, hardware,
 * private-key, dwallet-anchored) can import it without circular paths through wallet-service.
 *
 * the function prefers the in-session credential when the wallet is unlocked (skipping the
 * slow Argon2id KDF). when locked, it requires a password and runs the full unlock to derive
 * a fresh credential.
 */

import { getSession } from '@/background/session';
import { unlockVaultCredential, type VaultCredential } from '@/background/vault-store';

export async function resolveCredentialOrUnlock(password: string | undefined): Promise<VaultCredential> {
  const s = getSession();
  if (s) return { key: s.vaultKey, kdfMeta: s.vaultKdfMeta };
  if (!password || password.length < 8) {
    throw new Error(
      'Wallet exists and is locked. Unlock it first (password / passkey / waap / seeker - whichever method this wallet has registered) before adding another vault.',
    );
  }
  const r = await unlockVaultCredential(password);
  return { key: r.key, kdfMeta: r.kdfMeta };
}
