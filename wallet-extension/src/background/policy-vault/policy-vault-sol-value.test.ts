/**
 * pure-math tests for the Solana declared-value resolver (mirrors EVM/BTC value tests).
 */

import { describe, expect, it } from 'vitest';
import { __test__ } from './policy-vault-sol-value';

const { lamportsToMicroUsd } = __test__;

describe('lamportsToMicroUsd', () => {
  it('returns 0 for zero lamports', () => {
    expect(lamportsToMicroUsd(0n, 200)).toBe(0n);
  });

  it('returns 0 for negative lamports (defensive)', () => {
    expect(lamportsToMicroUsd(-1n, 200)).toBe(0n);
  });

  it('returns 0 when price is non-positive or non-finite', () => {
    expect(lamportsToMicroUsd(1_000_000_000n, 0)).toBe(0n);
    expect(lamportsToMicroUsd(1_000_000_000n, -10)).toBe(0n);
    expect(lamportsToMicroUsd(1_000_000_000n, NaN)).toBe(0n);
    expect(lamportsToMicroUsd(1_000_000_000n, Infinity)).toBe(0n);
  });

  it('1 SOL at $200 = 200_000_000 micro-USD', () => {
    expect(lamportsToMicroUsd(1_000_000_000n, 200)).toBe(200_000_000n);
  });

  it('0.001 SOL at $200 = $0.20 = 200_000 micro-USD', () => {
    expect(lamportsToMicroUsd(1_000_000n, 200)).toBe(200_000n);
  });

  it('handles fractional dollar prices', () => {
    expect(lamportsToMicroUsd(1_000_000_000n, 123.456)).toBe(123_456_000n);
  });

  it('caps at u64 max for unrealistic values', () => {
    const U64_MAX = (1n << 64n) - 1n;
    expect(lamportsToMicroUsd(10n ** 30n, 1_000_000)).toBe(U64_MAX);
  });

  it('truncates fractional micro-USD (no rounding)', () => {
    expect(lamportsToMicroUsd(1n, 200)).toBe(0n);
  });
});
