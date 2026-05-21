/**
 * Sui fee estimate.
 *
 * Sui's reference gas price (RGP) is network-wide - all txs in an epoch pay the same per
 * gas unit. there's no Fast/Normal/Slow tiering on Sui (suiKER's Android wallet also exposes
 * Sui as a single tier). This helper returns a single estimate; the FeeTierPicker UI will
 * render it as one line (`supportsTiers: false` on the wire) instead of three pills.
 *
 * approach:
 *  - getReferenceGasPrice() returns MIST-per-gas-unit for the current epoch.
 *  - for the gas-units side, we use a conservative budget estimate. A plain transfer is
 *    ~1.5M MIST budget in practice; we set 2M to leave headroom for storage cost +
 *    rebate. If the user wants precision, a future iteration can dryRun the actual PTB
 *    via `client.simulateTransaction()` and read `effects.gasUsed`.
 *
 * for parity with `evm-fee-tiers.ts` shape, we still return a `slow`/`normal`/`fast`
 * triple - all three slots hold the same value, and we set `supportsTiers: false` on
 * the wrapper so the picker degrades to a single line.
 */

import type { SuiGraphQLClient } from '@mysten/sui/graphql';

export type SuiFeeEstimate = {
  /** total MIST the user would pay (gasUnits * RGP). bigint as string. */
  totalMist: string;
  /** formatted display value, e.g. "0.001500 SUI". */
  totalFormatted: string;
  /** USD-equivalent when a SUI price is provided; null otherwise. */
  totalUsd: number | null;
  /** RGP in MIST/gas. bigint as string. */
  refGasPrice: string;
  /** gas units used for the multiplication. bigint as string. */
  gasUnits: string;
};

/** typical gas units for a plain SUI transfer with headroom. Sui actuals run ~1.0-1.3M MIST
 * for vanilla splitCoins+transferObjects; 2M leaves margin for storage cost calc + rebate. */
const SUI_DEFAULT_GAS_UNITS = 2_000_000n;

function formatMistAsSui(mist: bigint): string {
  const whole = mist / 1_000_000_000n;
  const frac = mist % 1_000_000_000n;
  const fracPadded = frac.toString().padStart(9, '0').slice(0, 6).replace(/0+$/, '');
  const fracStr = fracPadded.length > 0 ? `.${fracPadded}` : '';
  return `${whole.toString()}${fracStr} SUI`;
}

export async function fetchSuiFeeEstimate(
  client: SuiGraphQLClient,
  suiUsdPrice: number | null,
  gasUnitsOverride?: bigint,
): Promise<SuiFeeEstimate> {
  let rgp = 1000n; // long-standing Sui default RGP (1000 MIST/gas)
  try {
    const v = await client.getReferenceGasPrice();
    if (typeof v === 'bigint') rgp = v;
    else if (typeof v === 'number') rgp = BigInt(Math.trunc(v));
    else if (typeof v === 'string') rgp = BigInt(v);
    if (rgp <= 0n) rgp = 1000n;
  } catch (e) {
    console.warn('[sui-fee-estimate] getReferenceGasPrice failed; using 1000 MIST/gas default', e);
  }

  const gasUnits = gasUnitsOverride ?? SUI_DEFAULT_GAS_UNITS;
  const totalMist = rgp * gasUnits;
  const totalSui = Number(totalMist) / 1e9;
  const totalUsd = suiUsdPrice != null && suiUsdPrice > 0 ? totalSui * suiUsdPrice : null;
  return {
    totalMist: totalMist.toString(),
    totalFormatted: formatMistAsSui(totalMist),
    totalUsd,
    refGasPrice: rgp.toString(),
    gasUnits: gasUnits.toString(),
  };
}
