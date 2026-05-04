/**
 * helper that wraps the four-step ika coin pattern (resolve owner -> look up dynamic pricing
 * -> pick + split SUI/IKA coins -> stage transferObjects-back) into one call. signing,
 * presign, and DKG flows used to inline this and the most-common bug was forgetting the
 * `transferObjects` line at the end - PTB simulation then fails with the cryptic "Unused
 * result without the drop ability".
 *
 * usage:
 *   const tx = new Transaction();
 *   const ikaTx = new IkaTransaction({ ... });
 *   const alloc = await allocateIkaCoinsForOperation(session, adapter, tx);
 *   await ikaTx.requestSign({ ..., ikaCoin: alloc.ikaCoin, suiCoin: alloc.suiCoin });
 *   alloc.finalize();
 *
 * the `&mut` rule (see CLAUDE.md "ika coin arguments are `&mut` references"): the moveCall
 * mutates the split coin in place, the coin survives the call, and we must transfer the
 * remainder back to the fee-payer afterward. `finalize()` adds that `transferObjects` PTB
 * command - call it once after the moveCall is staged.
 */

import type { Transaction } from '@mysten/sui/transactions';
import type { SessionState } from '@/background/session';
import type { IkaAdapter } from '@/background/ika/ika-adapter';
import { getSuiFeePayerSuiAddress } from '@/background/sui/sui-fee-payer-signing';
import { requireSuiAndIkaCoins } from '@/background/ika/coins';
import { getRequiredCoinAmounts } from '@/background/ika/pricing';

/**
 * shape returned by `allocateIkaCoinsForOperation`. `ikaCoin` / `suiCoin` are
 * `TransactionResult`-indexed handles (effectively the `NestedResult` variant of
 * `splitCoins(...)[0]`); we leave the type to inference rather than picking one of the
 * `Argument` extracts so callers can pass them straight into `IkaTransaction.requestSign`
 * without a cast.
 */
export type IkaCoinAllocation = Awaited<ReturnType<typeof allocateIkaCoinsForOperation>>;

export async function allocateIkaCoinsForOperation(
  session: SessionState,
  adapter: IkaAdapter,
  tx: Transaction,
) {
  const owner = getSuiFeePayerSuiAddress(session);
  const { ikaAmount, suiAmount } = await getRequiredCoinAmounts(adapter.ikaClient);
  const { suiCoinId, ikaCoinId } = await requireSuiAndIkaCoins(
    session.suiClient,
    adapter.ikaClient.ikaConfig,
    owner,
    {
      minSuiProtocolSplitMist: suiAmount,
      session,
    },
  );
  const splitIka = tx.splitCoins(tx.object(ikaCoinId), [ikaAmount]);
  const splitSui = tx.splitCoins(tx.object(suiCoinId), [suiAmount]);
  return {
    /** split IKA coin handle to pass into ika moveCall args (e.g. `requestSign`'s `ikaCoin`). */
    ikaCoin: splitIka[0],
    /** split SUI coin handle to pass into ika moveCall args (e.g. `requestSign`'s `suiCoin`). */
    suiCoin: splitSui[0],
    /** sui address that owns the source coins; transferObjects sends remainders back here. */
    owner,
    /** the picked source coin object ids - rarely needed, useful for diagnostics. */
    sourceCoinIds: { sui: suiCoinId, ika: ikaCoinId },
    /** the resolved required amounts (already split into the coins above). */
    amounts: { ikaAmount, suiAmount },
    /**
     * stage the `transferObjects([splitIka[0], splitSui[0]], owner)` PTB command so the
     * remainders flow back to the fee-payer after the ika moveCall. MUST be called after the
     * ika moveCall is staged on the same `Transaction` (the moveCall takes `&mut` refs and
     * leaves the coins in PTB scope; without `finalize()` the PTB has unused values and
     * simulation aborts).
     */
    finalize: () => {
      tx.transferObjects([splitIka[0], splitSui[0]], owner);
    },
  };
}
