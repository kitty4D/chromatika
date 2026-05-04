/**
 * Encrypt.xyz hooks are Solana-program + gRPC only. they must not run on Sui ika-base
 * hot paths so Sui unlock, balances, Sui dapps, and ika Sui PTBs stay unchanged.
 */

import { getSession } from '@/background/session';

export function assertEncryptSolanaIkaBase(): void {
  const s = getSession();
  if (!s) throw new Error('Wallet locked');
  if (s.activeVaultBaseChain !== 'solana') {
    throw new Error(
      'Encrypt lab and gRPC helpers require ika base = Solana for this vault. Switch ika base in settings, or use Encrypt only from a Solana-base vault.',
    );
  }
}

export function isEncryptAllowedForSession(): boolean {
  const s = getSession();
  return Boolean(s && s.activeVaultBaseChain === 'solana');
}
