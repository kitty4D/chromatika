/**
 * unit tests for the DeSo declared-value resolver.
 */

import { describe, expect, it } from 'vitest';
import { __test__ } from './policy-vault-deso-value';

const { nanosToMicroUsd, priceMicrosPerDeso } = __test__;

describe('nanosToMicroUsd', () => {
  it('returns 0 for zero nanos', () => {
    expect(nanosToMicroUsd(0n, 25)).toBe(0n);
  });

  it('returns 0 for negative nanos (defensive)', () => {
    expect(nanosToMicroUsd(-1n, 25)).toBe(0n);
  });

  it('returns 0 when price is non-positive or non-finite', () => {
    expect(nanosToMicroUsd(10n ** 9n, 0)).toBe(0n);
    expect(nanosToMicroUsd(10n ** 9n, -10)).toBe(0n);
    expect(nanosToMicroUsd(10n ** 9n, NaN)).toBe(0n);
    expect(nanosToMicroUsd(10n ** 9n, Infinity)).toBe(0n);
  });

  it('1 DESO at $25 = 25_000_000 micro-USD', () => {
    const oneDeso = 1_000_000_000n; // 1e9 nanos
    expect(nanosToMicroUsd(oneDeso, 25)).toBe(25_000_000n);
  });

  it('0.001 DESO at $25 = $0.025 = 25_000 micro-USD', () => {
    const aThousandth = 1_000_000n;
    expect(nanosToMicroUsd(aThousandth, 25)).toBe(25_000n);
  });

  it('handles fractional dollar prices', () => {
    // 1 DESO * 12.345 USD = 12.345 USD = 12_345_000 micro-USD
    const oneDeso = 1_000_000_000n;
    expect(nanosToMicroUsd(oneDeso, 12.345)).toBe(12_345_000n);
  });

  it('caps at u64 max for unrealistic values', () => {
    const U64_MAX = (1n << 64n) - 1n;
    const huge = 10n ** 30n;
    expect(nanosToMicroUsd(huge, 1_000_000)).toBe(U64_MAX);
  });

  it('truncates fractional micro-USD (no rounding)', () => {
    // 1 nano at $25 = 25 / 1e9 micro-USD = 0n (truncated)
    expect(nanosToMicroUsd(1n, 25)).toBe(0n);
  });
});

describe('priceMicrosPerDeso (hard-policy DeSo value resolver)', () => {
  it('zero / negative price -> 0n', () => {
    expect(priceMicrosPerDeso(0)).toBe(0n);
    expect(priceMicrosPerDeso(-1)).toBe(0n);
  });

  it('non-finite price -> 0n', () => {
    expect(priceMicrosPerDeso(Number.NaN)).toBe(0n);
    expect(priceMicrosPerDeso(Number.POSITIVE_INFINITY)).toBe(0n);
  });

  it('$30/DESO -> 30_000_000 micro-USD/DESO', () => {
    expect(priceMicrosPerDeso(30)).toBe(30_000_000n);
  });

  it('$50/DESO -> 50_000_000 micro-USD/DESO', () => {
    expect(priceMicrosPerDeso(50)).toBe(50_000_000n);
  });

  it('fractional price rounds nearest', () => {
    // $12.345/DESO -> 12_345_000 micro-USD/DESO
    expect(priceMicrosPerDeso(12.345)).toBe(12_345_000n);
  });

  it('matches Move-side math: 1 DESO * priceMicrosPerDeso / 1e9 == declared micros', () => {
    const desoPrice = 25;
    const perDeso = priceMicrosPerDeso(desoPrice);
    // Move: value_micros = (1e9 nanos * 25_000_000) / 1e9 = 25_000_000 = $25
    const oneDesoNanos = 1_000_000_000n;
    const movesideMicros = (oneDesoNanos * perDeso) / 1_000_000_000n;
    expect(movesideMicros).toBe(25_000_000n);
  });
});
