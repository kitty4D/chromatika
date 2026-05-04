import type { Transaction } from '@mysten/sui/transactions';
import type { SessionState } from '@/background/session';
import { getSuiFeePayerSigningContext } from '@/background/sui/sui-fee-payer-signing';

/** Mysten puts `ExecutionStatus` on `Transaction.status`; `effects.status` can be missing depending on include flags. */
function transactionExecutionStatus(node: {
  status?: { success: boolean; error?: unknown };
  effects?: { status?: { success: boolean; error?: unknown } };
}): { success: boolean; error?: unknown } | undefined {
  return node.status ?? node.effects?.status;
}

/** best-effort string for MoveAbort / command index / generic RPC wording. */
function describeExecutionError(err: unknown): string {
  if (err == null) return 'unknown error';
  if (typeof err !== 'object') return String(err);
  const e = err as Record<string, unknown>;
  const msg = typeof e.message === 'string' ? e.message : '';
  const kind = e.$kind;
  if (kind === 'MoveAbort' && e.MoveAbort && typeof e.MoveAbort === 'object') {
    const ma = e.MoveAbort as Record<string, unknown>;
    const abortCode = ma.abortCode;
    const loc = ma.location as Record<string, unknown> | undefined;
    const pkg = loc?.package != null ? String(loc.package) : '';
    const mod = loc?.module != null ? String(loc.module) : '';
    const fn = loc?.functionName != null ? String(loc.functionName) : '';
    const where = pkg && mod ? `${pkg}::${mod}${fn ? `::${fn}` : ''}` : '';
    const extra = where ? ` — ${where} (abort ${String(abortCode)})` : ` — abort ${String(abortCode)}`;
    return (msg || 'MoveAbort') + extra;
  }
  if (typeof e.command === 'number') {
    return msg ? `${msg} (command ${e.command})` : `execution error in command ${e.command}`;
  }
  return msg || JSON.stringify(err);
}

export type DryRunOptions = {
  /** GraphQL `simulateTransaction.checksEnabled` (default true). */
  checksEnabled?: boolean;
};

/**
 * run GraphQL simulateTransaction before signAndExecute; returns human-readable lines for UI/logs.
 *
 * Mysten's `signAndExecuteTransaction` calls `setSenderIfNotSet(signer)` before build, but
 * `simulateTransaction` only runs `prepareForSerialization`: without an explicit sender the RPC
 * can treat the signer as `0x0...` and reject inputs owned by the real fee address.
 */
export async function dryRunSuiTransaction(
  session: SessionState,
  transaction: Transaction,
  dryOpts?: DryRunOptions,
): Promise<{ ok: true; summaryLines: string[] } | { ok: false; summaryLines: string[] }> {
  const { feePayerAddress } = getSuiFeePayerSigningContext(session);
  transaction.setSenderIfNotSet(feePayerAddress);
  const sim = await session.suiClient.simulateTransaction({
    transaction,
    include: { effects: true, balanceChanges: true },
    checksEnabled: dryOpts?.checksEnabled ?? true,
  });

  const node = sim.$kind === 'Transaction' ? sim.Transaction : sim.FailedTransaction;
  const st = transactionExecutionStatus(node);

  if (!st || st.success !== true) {
    const msg =
      st && !st.success && st.error
        ? describeExecutionError(st.error)
        : 'simulation failed';
    return { ok: false, summaryLines: [msg] };
  }

  const lines: string[] = ['dry-run: success'];
  const bc = node.balanceChanges;
  if (bc?.length) {
    lines.push('balance changes (preview):');
    for (const c of bc.slice(0, 14)) {
      lines.push(`  ${c.amount} ${c.coinType}`.trim());
    }
    if (bc.length > 14) lines.push(`  … +${bc.length - 14} more`);
  }

  return { ok: true, summaryLines: lines };
}
