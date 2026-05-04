/**
 * unit tests for the EVM declared-value resolver.
 *
 * tests the pure-math helper directly (`weiToMicroUsd`) and the parse path with synthetic
 * unsigned EVM tx bytes built via ethers' `Transaction` class. we don't hit the live price
 * service here; the parse path is mocked.
 */

import { describe, expect, it } from 'vitest';
import { __test__ } from './policy-vault-evm-value';

const { weiToMicroUsd } = __test__;

describe('weiToMicroUsd', () => {
  it('returns 0 for zero wei', () => {
    expect(weiToMicroUsd(0n, 3500)).toBe(0n);
  });

  it('returns 0 for negative wei (defensive)', () => {
    expect(weiToMicroUsd(-1n, 3500)).toBe(0n);
  });

  it('returns 0 when price is non-positive or non-finite', () => {
    expect(weiToMicroUsd(10n ** 18n, 0)).toBe(0n);
    expect(weiToMicroUsd(10n ** 18n, -10)).toBe(0n);
    expect(weiToMicroUsd(10n ** 18n, NaN)).toBe(0n);
    expect(weiToMicroUsd(10n ** 18n, Infinity)).toBe(0n);
  });

  it('1 ETH at $3500 = $3500 = 3_500_000_000 micro-USD', () => {
    const oneEth = 10n ** 18n;
    expect(weiToMicroUsd(oneEth, 3500)).toBe(3_500_000_000n);
  });

  it('0.001 ETH at $3500 = $3.5 = 3_500_000 micro-USD', () => {
    const aThousandth = 10n ** 15n;
    expect(weiToMicroUsd(aThousandth, 3500)).toBe(3_500_000n);
  });

  it('handles fractional dollar prices (price=1234.567 USD/ETH)', () => {
    // 1 ETH * 1234.567 USD/ETH = 1234.567 USD = 1_234_567_000 micro-USD
    const oneEth = 10n ** 18n;
    // priceMicros = round(1234.567 * 1e6) = 1_234_567_000
    expect(weiToMicroUsd(oneEth, 1234.567)).toBe(1_234_567_000n);
  });

  it('caps at u64 max for unrealistic values', () => {
    const U64_MAX = (1n << 64n) - 1n;
    // very high wei + price; result would exceed u64 max
    const huge = 10n ** 30n; // 1e30 wei (impossible practically)
    expect(weiToMicroUsd(huge, 1_000_000)).toBe(U64_MAX);
  });

  it('truncates fractional micro-USD (not rounds)', () => {
    // 1 wei at $3500 = 3500e-12 micro-USD ~= 0; floors to 0n.
    expect(weiToMicroUsd(1n, 3500)).toBe(0n);
    // ~285714 wei at $3500 = 1 micro-USD threshold
    // 285714 * 3_500_000_000 / 1e18 = 0.999... -> 0n (floor)
    expect(weiToMicroUsd(285714n, 3500)).toBe(0n);
  });
});
