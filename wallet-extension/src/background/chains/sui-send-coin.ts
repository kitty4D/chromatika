/**
 * generic Sui coin transfer for any `coinType` from the HD fee-payer's owned coins (not ika MPC).
 *
 * sibling to [`sui-send-native.ts`](./sui-send-native.ts) which only handles `0x2::sui::SUI` via
 * `tx.splitCoins(tx.gas, ...)`. for non-native coins (IKA, USDC on Sui, etc.) we need to pick
 * the owned coin objects of that type via `client.core.listCoins(...)` and split them in PTB.
 *
 * the cross-chain Send tab uses this when a row's `coinType` is set and is not the native SUI
 * type. native SUI sends still route through `sendNativeSuiTransfer` so the gas-coin fast path
 * is preserved.
 */

import { Transaction } from '@mysten/sui/transactions';
import { getSession } from '@/background/session';
import { executeSuiTransaction } from '@/background/sui/execute-transaction';

const NATIVE_SUI_COIN_TYPE = '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';

function isLikelySuiAddress(s: string): boolean {
  return /^0x[a-fA-F0-9]{64}$/.test(s.trim());
}

/** decimal -> base-units bigint at the given decimals. trims trailing fractional digits. */
export function parseDecimalCoinToBaseUnits(amount: string, decimals: number): bigint {
  const t = amount.trim();
  if (!t || t === '.') return 0n;
  const neg = t.startsWith('-');
  const u = neg ? t.slice(1) : t;
  const [wholeRaw, fracRaw = ''] = u.split('.');
  const whole = wholeRaw.replace(/^0+/, '') || '0';
  const padding = '0'.repeat(decimals);
  const frac = (fracRaw + padding).slice(0, decimals);
  const base = BigInt(whole) * BigInt(10) ** BigInt(decimals) + BigInt(frac);
  return neg ? -base : base;
}

/**
 * send `baseUnits` of `coinType` from the fee-payer's owned coins. when `coinType` is the native
 * SUI type, delegate to the gas-coin fast path; otherwise build a PTB that splits the first owned
 * coin of that type, transfers the split chunk, and returns the remainder to the owner.
 */
export async function sendSuiCoinTransfer(
  coinType: string,
  to: string,
  baseUnits: bigint,
): Promise<string> {
  const s = getSession();
  if (!s) throw new Error('Wallet locked');
  const dest = to.trim();
  if (!isLikelySuiAddress(dest)) throw new Error('Invalid Sui address (expect 0x + 64 hex chars)');
  if (baseUnits <= 0n) throw new Error('Amount must be positive');

  const normalizedType = coinType.trim();
  if (!normalizedType) throw new Error('coinType is required');

  if (normalizedType === NATIVE_SUI_COIN_TYPE || normalizedType === '0x2::sui::SUI') {
    const { sendNativeSuiTransfer } = await import('./sui-send-native');
    return sendNativeSuiTransfer(dest, baseUnits);
  }

  const owner = s.suiKeypair.getPublicKey().toSuiAddress();

  // enumerate owned coin objects of this type via the base `listCoins` (matches the rest of the
  // codebase; see `wallet-extension/src/background/ika/coins.ts`). page through cursors until
  // exhausted; coin objects on Sui are typically small in count per type.
  const owned: { id: string; balance: bigint }[] = [];
  let cursor: string | null = null;
  for (;;) {
    const res = await s.suiClient.listCoins({
      owner,
      coinType: normalizedType,
      limit: 50,
      ...(cursor ? { cursor } : {}),
    });
    for (const o of res.objects) {
      owned.push({ id: o.objectId, balance: BigInt(o.balance ?? '0') });
    }
    if (!res.hasNextPage) break;
    cursor = res.cursor;
  }
  if (!owned.length) {
    throw new Error(`No owned coins of type ${normalizedType} at vault address ${owner}`);
  }

  // find a coin with enough balance, or merge enough to cover the send.
  const sorted = owned
    .filter((c) => c.balance > 0n)
    .sort((a, b) => (b.balance > a.balance ? 1 : b.balance < a.balance ? -1 : 0));

  const total = sorted.reduce((acc, c) => acc + c.balance, 0n);
  if (total < baseUnits) {
    throw new Error(
      `Insufficient balance: have ${total.toString()} base units, need ${baseUnits.toString()}`,
    );
  }

  const tx = new Transaction();
  const primaryRef = sorted[0]!;
  const primary = tx.object(primaryRef.id);

  // merge additional coins into primary until we cover the send.
  let covered = primaryRef.balance;
  const mergeIds: string[] = [];
  for (let i = 1; i < sorted.length && covered < baseUnits; i++) {
    mergeIds.push(sorted[i]!.id);
    covered += sorted[i]!.balance;
  }
  if (mergeIds.length > 0) {
    tx.mergeCoins(primary, mergeIds.map((id) => tx.object(id)));
  }

  const [sendChunk] = tx.splitCoins(primary, [baseUnits]);
  tx.transferObjects([sendChunk], dest);

  const result = await executeSuiTransaction(s, tx);
  const digest = (result as { digest?: string }).digest ?? 'unknown';

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
      console.warn('[chromatika tx-record] sui-coin-send origin record failed', e);
    }
  }

  return digest;
}
