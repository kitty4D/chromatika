import { describe, expect, it } from 'vitest';
import { generateMcpTokenHex, verifyMcpToken } from './mcp-auth';

describe('generateMcpTokenHex', () => {
  it('generates a 64-character lowercase hex string (32 bytes)', () => {
    const t = generateMcpTokenHex();
    expect(t).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces unique values across calls (sanity, not a true uniqueness proof)', () => {
    const a = generateMcpTokenHex();
    const b = generateMcpTokenHex();
    expect(a).not.toBe(b);
  });
});

describe('verifyMcpToken', () => {
  it('returns true for matching tokens', () => {
    const t = generateMcpTokenHex();
    expect(verifyMcpToken(t, t)).toBe(true);
  });

  it('returns false for differing tokens of equal length', () => {
    const t = generateMcpTokenHex();
    const u = generateMcpTokenHex();
    expect(verifyMcpToken(t, u)).toBe(false);
  });

  it('returns false for empty inputs', () => {
    expect(verifyMcpToken('', '')).toBe(false);
    expect(verifyMcpToken('a', '')).toBe(false);
    expect(verifyMcpToken('', 'a')).toBe(false);
  });

  it('returns false when one side is non-string (defensive against malformed callers)', () => {
    expect(verifyMcpToken(null as unknown as string, 'abcd')).toBe(false);
    expect(verifyMcpToken('abcd', undefined as unknown as string)).toBe(false);
    expect(verifyMcpToken(123 as unknown as string, '123')).toBe(false);
  });

  it('returns false on length mismatch (cannot match without lengths agreeing)', () => {
    expect(verifyMcpToken('abcd', 'abcdef')).toBe(false);
    expect(verifyMcpToken('abcdef', 'abcd')).toBe(false);
  });

  it('detects single-character mismatches anywhere in the token', () => {
    const baseline = '0'.repeat(64);
    for (const idx of [0, 1, 31, 32, 62, 63]) {
      const tampered = baseline.slice(0, idx) + '1' + baseline.slice(idx + 1);
      expect(verifyMcpToken(tampered, baseline)).toBe(false);
    }
  });
});
