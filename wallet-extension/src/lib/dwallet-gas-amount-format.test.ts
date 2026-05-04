import { describe, expect, it } from 'vitest';
import { formatUnits } from 'ethers';
import { formatNativeGasAmountDisplay } from '@/lib/dwallet-gas-amount-format';

describe('formatNativeGasAmountDisplay', () => {
  it('does not round tiny wei balances to zero like toFixed(5) did', () => {
    const wei = 1_000_000_000_000_000n; // 0.001 eth
    const s = formatUnits(wei, 18);
    expect(s.startsWith('0.001')).toBe(true);
    const d = formatNativeGasAmountDisplay(s);
    expect(d).not.toMatch(/^0\.0{4,}0$/);
    expect(Number(d.replace(/,/g, ''))).toBeGreaterThan(0);
  });

  it('formats 1 wei without collapsing to 0.00000', () => {
    const s = formatUnits(1n, 18);
    const d = formatNativeGasAmountDisplay(s);
    expect(d).not.toBe('0.00000');
  });
});
