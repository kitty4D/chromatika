import { describe, it, expect } from 'vitest';
import { normalizeEcdsaLowS } from './ecdsa-lows';

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const HALF = N >> 1n;

function be32(x: bigint): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}
function sFromSig(sig: Uint8Array): bigint {
  let s = 0n;
  for (let i = 32; i < 64; i++) s = (s << 8n) | BigInt(sig[i]);
  return s;
}
function mkSig(r: bigint, s: bigint): Uint8Array {
  const out = new Uint8Array(64);
  out.set(be32(r), 0);
  out.set(be32(s), 32);
  return out;
}

describe('normalizeEcdsaLowS', () => {
  const r = 0x1234abcdn;

  it('passes a low-S signature through unchanged (same reference)', () => {
    const lowS = HALF - 1n;
    const sig = mkSig(r, lowS);
    const out = normalizeEcdsaLowS(sig);
    expect(out).toBe(sig); // returns the input ref when already low-S
    expect(sFromSig(out)).toBe(lowS);
  });

  it('keeps s == N/2 (the boundary) unchanged', () => {
    const sig = mkSig(r, HALF);
    expect(sFromSig(normalizeEcdsaLowS(sig))).toBe(HALF);
  });

  it('flips a high-S signature to N - s, leaves r intact, and is idempotent', () => {
    const highS = HALF + 1n;
    const sig = mkSig(r, highS);
    const out = normalizeEcdsaLowS(sig);
    const outS = sFromSig(out);
    expect(outS).toBe(N - highS);
    expect(outS <= HALF).toBe(true);
    expect(Array.from(out.slice(0, 32))).toEqual(Array.from(sig.slice(0, 32)));
    // re-normalizing a now-low-S sig is a no-op
    expect(sFromSig(normalizeEcdsaLowS(out))).toBe(outS);
  });

  it('flips the maximum high-S value (N - 1) correctly', () => {
    const sig = mkSig(r, N - 1n);
    const out = normalizeEcdsaLowS(sig);
    expect(sFromSig(out)).toBe(1n);
  });

  it('throws on a wrong-length input', () => {
    expect(() => normalizeEcdsaLowS(new Uint8Array(63))).toThrow(/64-byte/);
    expect(() => normalizeEcdsaLowS(new Uint8Array(65))).toThrow(/64-byte/);
  });
});
