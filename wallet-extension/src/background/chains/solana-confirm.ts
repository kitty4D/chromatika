/**
 * polling-based replacement for `Connection.confirmTransaction(...)`.
 *
 * `@solana/web3.js@1.x` `confirmTransaction` opens a websocket subscription via `rpc-websockets`.
 * in the MV3 service worker context, the browser-targeted bundle of that lib references
 * `window` (`new Rge` at `index.browser.mjs:15:23`), which is undefined in a SW. the subscribe
 * fails to land, the 30s timeout fires with the famous "Transaction was not confirmed in 30.00
 * seconds. It is unknown if it succeeded or failed." message, and the cleanup path then throws
 * `ReferenceError: window is not defined` from `abortConfirmation` ->
 * `_unsubscribeClientSubscription` -> `webSocketFactory`.
 *
 * polling `getSignatureStatus` is pure HTTP, has no websocket dependency, and works identically
 * in the popup / side panel / SW. the tradeoff is a small per-poll round-trip cost (we default
 * to 1s intervals) instead of push-style notifications.
 *
 * use this everywhere we used to call `connection.confirmTransaction(...)`.
 */

import type { Connection } from '@solana/web3.js';
import { updateCurrentOperationStage } from '@/background/progress/operation-progress';

type Commitment = 'processed' | 'confirmed' | 'finalized';

const COMMITMENT_RANK: Record<Commitment, number> = {
  processed: 0,
  confirmed: 1,
  finalized: 2,
};

export interface ConfirmSolanaTxOptions {
  /** minimum commitment level required for the resolve. defaults to `'confirmed'`. */
  commitment?: Commitment;
  /** total time to wait before giving up. defaults to 60s. */
  timeoutMs?: number;
  /** poll interval between status checks. defaults to 1s. */
  intervalMs?: number;
  /**
   * when set, push this label into the operation-progress banner at the start of the wait so
   * the user sees what we're waiting on. only fires when an operation is already in flight,
   * see `updateCurrentOperationStage` for the no-op fallthrough rules.
   */
  progressLabel?: string;
  /** stable id for the progress stage. defaults to `'solana-confirm'`. */
  progressStageId?: string;
}

export async function confirmSolanaTxByPolling(
  connection: Connection,
  signature: string,
  options: ConfirmSolanaTxOptions = {},
): Promise<void> {
  const commitment = options.commitment ?? 'confirmed';
  const timeoutMs = options.timeoutMs ?? 60_000;
  const intervalMs = options.intervalMs ?? 1_000;
  const requiredRank = COMMITMENT_RANK[commitment];
  const start = Date.now();

  if (options.progressLabel) {
    await updateCurrentOperationStage(options.progressStageId ?? 'solana-confirm', options.progressLabel);
  }

  while (Date.now() - start < timeoutMs) {
    const { value } = await connection.getSignatureStatus(signature, {
      searchTransactionHistory: false,
    });
    if (value?.err) {
      throw new Error(`Solana tx ${signature} failed: ${JSON.stringify(value.err)}`);
    }
    const got = value?.confirmationStatus;
    if (got && COMMITMENT_RANK[got] !== undefined && COMMITMENT_RANK[got] >= requiredRank) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(
    `Solana tx ${signature} not ${commitment} after ${Math.round(timeoutMs / 1000)}s. Check Solana Explorer or CLI for final status.`,
  );
}
