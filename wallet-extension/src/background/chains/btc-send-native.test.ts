import { describe, expect, it } from 'vitest';
import { parseDecimalBtcToSats } from '@/background/chains/btc-send-native';

describe('parseDecimalBtcToSats', () => {
  it('parses whole and fractional btc', () => {
    expect(parseDecimalBtcToSats('1')).toBe(100_000_000n);
    expect(parseDecimalBtcToSats('0.5')).toBe(50_000_000n);
    expect(parseDecimalBtcToSats('0.00000001')).toBe(1n);
  });
});
