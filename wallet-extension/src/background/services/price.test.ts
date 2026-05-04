import { describe, it, expect } from 'vitest';
import { getPrices } from '@/background/services/price';

describe('getPrices', () => {
  it('returns null for symbols with no price sources (no fake zero)', async () => {
    const r = await getPrices(['__NOT_A_REAL_SYMBOL_XYZ__']);
    expect(r['__NOT_A_REAL_SYMBOL_XYZ__']).toBeNull();
  });
});
