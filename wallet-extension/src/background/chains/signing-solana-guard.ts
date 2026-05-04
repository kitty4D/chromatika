import type { SessionState } from '@/background/session';
import { IKA_SOLANA_SECP_SIGNING_IMPLEMENTED } from '@/background/ika/solana-secp-signing';

/**
 * ika Solana base has no Sui PTB path for secp256k1 signing - call before takePresign on EVM/BTC paths.
 */
export function assertNotSolanaBaseForSecpSigning(
  session: SessionState | null | undefined,
  context: 'evm' | 'btc',
): void {
  if (IKA_SOLANA_SECP_SIGNING_IMPLEMENTED) return;
  if (session?.activeVaultBaseChain !== 'solana') return;
  const doc = 'wallet-extension/docs/SOLANA_IKA_LIMITS.md';
  if (context === 'evm') {
    throw new Error(
      `EVM signing with ika Solana base is not wired - secp256k1 uses Sui ika PTBs today. Switch ika base to Sui for EVM, or see ${doc}.`,
    );
  }
  throw new Error(
    `Bitcoin signing with ika Solana base is not wired - secp256k1 uses Sui ika PTBs today. Switch ika base to Sui for BTC, or see ${doc}.`,
  );
}
