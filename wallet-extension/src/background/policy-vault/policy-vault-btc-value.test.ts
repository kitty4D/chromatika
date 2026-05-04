/**
 * unit tests for the BTC declared-value resolver. pure-math tests on the helper directly;
 * doesn't exercise the live price service.
 */

import { describe, expect, it } from 'vitest';
import { __test__ } from './policy-vault-btc-value';

const { satsToMicroUsd, priceMicrosPerSatoshi } = __test__;

describe('satsToMicroUsd', () => {
  it('returns 0 for zero sats', () => {
    expect(satsToMicroUsd(0n, 60_000)).toBe(0n);
  });

  it('returns 0 for negative sats (defensive)', () => {
    expect(satsToMicroUsd(-1n, 60_000)).toBe(0n);
  });

  it('returns 0 when price is non-positive or non-finite', () => {
    expect(satsToMicroUsd(100_000_000n, 0)).toBe(0n);
    expect(satsToMicroUsd(100_000_000n, -10)).toBe(0n);
    expect(satsToMicroUsd(100_000_000n, NaN)).toBe(0n);
    expect(satsToMicroUsd(100_000_000n, Infinity)).toBe(0n);
  });

  it('1 BTC at $60,000 = 60_000_000_000 micro-USD', () => {
    const oneBtc = 100_000_000n; // 1e8 sats
    expect(satsToMicroUsd(oneBtc, 60_000)).toBe(60_000_000_000n);
  });

  it('0.001 BTC at $60,000 = $60 = 60_000_000 micro-USD', () => {
    const aThousandth = 100_000n;
    expect(satsToMicroUsd(aThousandth, 60_000)).toBe(60_000_000n);
  });

  it('handles fractional dollar prices', () => {
    // 1 BTC * 12345.67 USD/BTC = 12345.67 USD = 12_345_670_000 micro-USD
    const oneBtc = 100_000_000n;
    expect(satsToMicroUsd(oneBtc, 12345.67)).toBe(12_345_670_000n);
  });

  it('caps at u64 max for unrealistic values', () => {
    const U64_MAX = (1n << 64n) - 1n;
    const huge = 10n ** 20n; // way more sats than ever exist
    expect(satsToMicroUsd(huge, 1_000_000)).toBe(U64_MAX);
  });

  it('truncates fractional micro-USD (no rounding)', () => {
    // 1 sat at $60k = 60_000_000_000 / 1e8 = 600 micro-USD (integer; no truncation)
    expect(satsToMicroUsd(1n, 60_000)).toBe(600n);
    // fractional case: at price $0.5 / BTC, 1 sat should produce 0.005 micro-USD = 0n
    expect(satsToMicroUsd(1n, 0.5)).toBe(0n);
  });
});

describe('priceMicrosPerSatoshi (hard-policy BTC value resolver)', () => {
  it('zero / negative price -> 0n', () => {
    expect(priceMicrosPerSatoshi(0)).toBe(0n);
    expect(priceMicrosPerSatoshi(-1)).toBe(0n);
  });

  it('non-finite price -> 0n', () => {
    expect(priceMicrosPerSatoshi(Number.NaN)).toBe(0n);
    expect(priceMicrosPerSatoshi(Number.POSITIVE_INFINITY)).toBe(0n);
  });

  it('$50_000/BTC -> 500 micro-USD/sat', () => {
    expect(priceMicrosPerSatoshi(50_000)).toBe(500n);
  });

  it('$100_000/BTC -> 1000 micro-USD/sat', () => {
    expect(priceMicrosPerSatoshi(100_000)).toBe(1000n);
  });

  it('$30_000/BTC -> 300 micro-USD/sat', () => {
    expect(priceMicrosPerSatoshi(30_000)).toBe(300n);
  });

  it('round-trip cap arithmetic stays within rounding bounds', () => {
    // the Move-side hard decoder multiplies value_sats * priceMicrosPerSatoshi directly.
    // for 1 BTC the rounded per-sat price gives roughly the same micro-USD as the precise
    // calculation, modulo sub-cent rounding loss.
    const btcPrice = 67_432;
    const perSat = priceMicrosPerSatoshi(btcPrice);
    const oneBtc = 100_000_000n;
    const viaSat = oneBtc * perSat;
    const direct = BigInt(Math.round(btcPrice * 1_000_000));
    const diff = direct > viaSat ? direct - viaSat : viaSat - direct;
    // worst-case rounding loss < $100 USD on $67k value (under 0.15%); acceptable for a cap.
    expect(diff < 100_000_000n).toBe(true);
  });
});
