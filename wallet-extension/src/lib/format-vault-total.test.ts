import { describe, it, expect } from 'vitest';
import { formatVaultTotalUsd } from './format-vault-total';

describe('formatVaultTotalUsd', () => {
  it('exact mode shows two decimals with commas', () => {
    expect(formatVaultTotalUsd({ usdMicros: 1_234_560_000n, partial: false }, 'exact')).toBe('$1,234.56');
  });

  it('exact mode rounds to 2 decimals', () => {
    expect(formatVaultTotalUsd({ usdMicros: 1_234_565_000n, partial: false }, 'exact')).toBe('$1,234.57');
  });

  it('compact mode uses k / M abbreviations', () => {
    expect(formatVaultTotalUsd({ usdMicros: 1_234_560_000n, partial: false }, 'compact')).toBe('$1.2K');
    expect(formatVaultTotalUsd({ usdMicros: 12_500_000_000n, partial: false }, 'compact')).toBe('$12.5K');
    expect(formatVaultTotalUsd({ usdMicros: 1_500_000_000_000n, partial: false }, 'compact')).toBe('$1.5M');
  });

  it('compact mode shows raw $ for sub-1k values', () => {
    expect(formatVaultTotalUsd({ usdMicros: 999_990_000n, partial: false }, 'compact')).toBe('$999.99');
    expect(formatVaultTotalUsd({ usdMicros: 1_000_000n, partial: false }, 'compact')).toBe('$1.00');
  });

  it('zero shows $0.00 in either mode', () => {
    expect(formatVaultTotalUsd({ usdMicros: 0n, partial: false }, 'exact')).toBe('$0.00');
    expect(formatVaultTotalUsd({ usdMicros: 0n, partial: false }, 'compact')).toBe('$0.00');
  });

  it('partial prepends a tilde', () => {
    expect(formatVaultTotalUsd({ usdMicros: 1_234_560_000n, partial: true }, 'compact')).toBe('~$1.2K');
    expect(formatVaultTotalUsd({ usdMicros: 1_234_560_000n, partial: true }, 'exact')).toBe('~$1,234.56');
  });
});
