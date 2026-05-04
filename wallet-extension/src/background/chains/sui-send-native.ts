/**
 * simple native SUI transfer from the HD fee-payer gas coin (not ika MPC).
 */

import { Transaction } from '@mysten/sui/transactions';
import { getSession } from '@/background/session';
import { executeSuiTransaction } from '@/background/sui/execute-transaction';

function isLikelySuiAddress(s: string): boolean {
  return /^0x[a-fA-F0-9]{64}$/.test(s.trim());
}

/** parse decimal SUI string to MIST (bigint). */
export function parseDecimalSuiToMist(amount: string): bigint {
  const t = amount.trim();
  if (!t || t === '.') return 0n;
  const neg = t.startsWith('-');
  const u = neg ? t.slice(1) : t;
  const [wholeRaw, fracRaw = ''] = u.split('.');
  const whole = wholeRaw.replace(/^0+/, '') || '0';
  const frac = (fracRaw + '000000000').slice(0, 9);
  const mist = BigInt(whole) * 1_000_000_000n + BigInt(frac);
  return neg ? -mist : mist;
}

export async function sendNativeSuiTransfer(to: string, mistAmount: bigint): Promise<string> {
  const s = getSession();
  if (!s) throw new Error('Wallet locked');
  const dest = to.trim();
  if (!isLikelySuiAddress(dest)) throw new Error('Invalid Sui address (expect 0x + 64 hex chars)');
  if (mistAmount <= 0n) throw new Error('Amount must be positive');

  const tx = new Transaction();
  const [coin] = tx.splitCoins(tx.gas, [mistAmount]);
  tx.transferObjects([coin], dest);
  const result = await executeSuiTransaction(s, tx);
  const digest = (result as { digest?: string }).digest ?? 'unknown';

  // wallet-UI Sui send, tx-record with origin null (no dapp).
  if (digest !== 'unknown') {
    try {
      const { recordSignedTx } = await import('@/background/services/tx-record');
      await recordSignedTx({
        txHash: digest,
        origin: null,
        chainId: 'sui-' + s.network,
        vaultId: s.activeVaultId,
        timestampMs: Date.now(),
        kind: 'sui-send',
      });
    } catch (e) {
      console.warn('[chromatika tx-record] sui-send origin record failed', e);
    }
  }

  return digest;
}
