/**
 * Bitcoin Fast / Normal / Slow fee tiers derived from Esplora's `/fee-estimates` endpoint.
 *
 * Esplora returns `{ '1': sat/vB, '2': sat/vB, ..., '144': sat/vB }` - a map of
 * confirmation target (in blocks) to estimated fee rate. We pick:
 *   - Fast   = target  1 block  (next block)
 *   - Normal = target  3 blocks (~30 min on mainnet)
 *   - Slow   = target  6 blocks (~60 min)
 *
 * the BTC tx's vbytes (computed during PSBT build) multiplied by the chosen sat/vB gives
 * the final satoshi fee. UI shows all three tiers with token + fiat per tier (parity with
 * the EVM picker shape).
 */

export type BtcFeeTier = {
  tier: 'slow' | 'normal' | 'fast';
  /** sat/vB rate from Esplora at the tier's target. */
  satPerVbyte: number;
  /** target confirmation in blocks (1 = fast, 3 = normal, 6 = slow). */
  targetBlocks: number;
  /** total satoshis the user would pay (satPerVbyte * vbytes). bigint as string. */
  totalSats: string;
  /** formatted display value, e.g. "0.00005400 BTC". */
  totalFormatted: string;
  /** USD-equivalent when a BTC price is provided; null otherwise. */
  totalUsd: number | null;
  /** vbytes used for the multiplication. bigint as string. */
  vbytes: string;
};

export type BtcFeeTiersResult = {
  fromRealData: boolean;
  slow: BtcFeeTier;
  normal: BtcFeeTier;
  fast: BtcFeeTier;
};

function formatSatsAsBtc(sats: bigint): string {
  const whole = sats / 100_000_000n;
  const frac = sats % 100_000_000n;
  const fracPadded = frac.toString().padStart(8, '0').replace(/0+$/, '');
  const fracStr = fracPadded.length > 0 ? `.${fracPadded}` : '';
  return `${whole.toString()}${fracStr} BTC`;
}

function buildTier(opts: {
  tier: BtcFeeTier['tier'];
  satPerVbyte: number;
  targetBlocks: number;
  vbytes: bigint;
  btcUsdPrice: number | null;
}): BtcFeeTier {
  // sat/vB can be a float (Esplora returns fractional rates like "1.234"); round UP so we
  // always cover the network's minimum-relay-fee minimum-mempool-fee floor.
  const ratePerByteCeil = Math.max(1, Math.ceil(opts.satPerVbyte));
  const totalSats = BigInt(ratePerByteCeil) * opts.vbytes;
  const totalBtc = Number(totalSats) / 1e8;
  const totalUsd = opts.btcUsdPrice != null && opts.btcUsdPrice > 0 ? totalBtc * opts.btcUsdPrice : null;
  return {
    tier: opts.tier,
    satPerVbyte: opts.satPerVbyte,
    targetBlocks: opts.targetBlocks,
    totalSats: totalSats.toString(),
    totalFormatted: formatSatsAsBtc(totalSats),
    totalUsd,
    vbytes: opts.vbytes.toString(),
  };
}

/**
 * fetch Fast/Normal/Slow fee tiers from an Esplora `/fee-estimates` endpoint.
 *
 * @param esploraBase the chain's Esplora base URL (e.g. `https://blockstream.info/api`).
 * @param vbytes the transaction's virtual byte size (caller-supplied; computed during PSBT build).
 * @param btcUsdPrice spot USD price of BTC; null disables the USD column.
 */
export async function fetchBtcFeeTiers(
  esploraBase: string,
  vbytes: bigint,
  btcUsdPrice: number | null,
): Promise<BtcFeeTiersResult> {
  let estimates: Record<string, number> = {};
  let fromRealData = true;

  try {
    const url = `${esploraBase.replace(/\/$/, '')}/fee-estimates`;
    const r = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = (await r.json()) as Record<string, number | string>;
    for (const [k, v] of Object.entries(j)) {
      const n = typeof v === 'number' ? v : Number(v);
      if (Number.isFinite(n) && n > 0) estimates[k] = n;
    }
    if (Object.keys(estimates).length === 0) throw new Error('empty fee-estimates');
  } catch (e) {
    fromRealData = false;
    console.warn('[btc-fee-tiers] Esplora /fee-estimates failed; using mainnet baseline', e);
    // baseline: 1/3/6-block targets at static rates - 20 sat/vB for fast, 8 normal, 3 slow.
    // mempool-empty days run lower; this gives a safe-side estimate for the preview.
    estimates = { '1': 20, '3': 8, '6': 3 };
  }

  // helper to pick the rate for a target, with a fallback search if the exact key is missing.
  // Esplora's response is usually keyed by every target Bitcoin Core supports (1, 2, 3, 4, 5,
  // 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 144, 504, 1008)
  // but if any are missing, find the next-shorter target's rate (Esplora rates are monotonic
  // non-increasing as target grows, so a shorter target is a safe upper-bound).
  function rateForTarget(target: number): number {
    if (estimates[String(target)] != null) return estimates[String(target)]!;
    for (let t = target - 1; t >= 1; t--) {
      if (estimates[String(t)] != null) return estimates[String(t)]!;
    }
    for (let t = target + 1; t <= 1008; t++) {
      if (estimates[String(t)] != null) return estimates[String(t)]!;
    }
    return 5; // emergency fallback
  }

  return {
    fromRealData,
    slow: buildTier({ tier: 'slow', satPerVbyte: rateForTarget(6), targetBlocks: 6, vbytes, btcUsdPrice }),
    normal: buildTier({ tier: 'normal', satPerVbyte: rateForTarget(3), targetBlocks: 3, vbytes, btcUsdPrice }),
    fast: buildTier({ tier: 'fast', satPerVbyte: rateForTarget(1), targetBlocks: 1, vbytes, btcUsdPrice }),
  };
}
