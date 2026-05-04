import type { IkaClient } from '@ika.xyz/sdk';

/**
 * query the ika coordinator's on-chain pricing map and return the minimum
 * IKA + SUI amounts a coin split must provide for a given operation.
 *
 * the pricing map is keyed by { curve: u32, signature_algorithm: Option<u32>, protocol: u32 }.
 * different protocols (DKG round 1, DKG round 2, presign, sign, re-encrypt, ...)
 * may have different fees for the same curve. since we don't always know which
 * protocol enum value the Move function will look up internally, we take the
 * **max** across all protocols for the requested curve, safe because coins are
 * passed by `&mut` reference and any excess stays in the coin.
 *
 * a 10% buffer is added on top to absorb rounding or mid-epoch price changes.
 */
export async function getRequiredCoinAmounts(
  ikaClient: IkaClient,
  curveNumber?: number,
): Promise<{ ikaAmount: bigint; suiAmount: bigint }> {
  const { coordinatorInner } = await ikaClient.ensureInitialized();
  const entries = coordinatorInner.pricing_and_fee_manager.current.pricing_map.contents;

  let maxIka = 0n;
  let maxSui = 0n;

  for (const entry of entries) {
    // if a specific curve was requested, filter to only that curve's entries
    if (curveNumber !== undefined && entry.key.curve !== curveNumber) continue;

    const feeIka = BigInt(entry.value.fee_ika);
    const gasSui =
      BigInt(entry.value.gas_fee_reimbursement_sui) +
      BigInt(entry.value.gas_fee_reimbursement_sui_for_system_calls);

    if (feeIka > maxIka) maxIka = feeIka;
    if (gasSui > maxSui) maxSui = gasSui;
  }

  if (maxIka === 0n && maxSui === 0n) {
    // fallback if the pricing map is empty or the curve has no entries
    return { ikaAmount: 10_000_000n, suiAmount: 10_000_000n };
  }

  // 10% buffer
  const ikaAmount = maxIka + maxIka / 10n;
  const suiAmount = maxSui + maxSui / 10n;

  return { ikaAmount, suiAmount };
}
