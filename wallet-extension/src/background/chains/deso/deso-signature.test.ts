/**
 * unit tests for DeSo signature wrapping. we don't have a public DeSo golden vector (privkey +
 * unsigned hex + signed hex from upstream test fixtures, none published), so we synthesize a
 * vector locally via `@noble/secp256k1` `sign` and verify chromatika's wrapping produces the
 * exact bytes the upstream `signTx` would (recovery-byte mutation, low-S normalization, DER
 * shape).
 *
 * see `wallet-extension/docs/DESO_SPIKE.md` for the wire-format spec.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { sign, getPublicKey, hashes as secpHashes } from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';
import {
  bytesToHex,
  encodeEcdsaDer,
  findRecoveryId,
  hexToBytes,
  lowSNormalize32,
  sha256x2,
  spliceSignatureIntoTransactionHex,
  wrapEcdsaForDeSo,
} from '@/background/chains/deso/deso-signature';

beforeAll(() => {
  secpHashes.sha256 = sha256;
  // sign() needs RFC-6979 deterministic nonce, HMAC-SHA256 driven, verify/recover only need sha256.
  secpHashes.hmacSha256 = (key: Uint8Array, msg: Uint8Array) => hmac(sha256, key, msg);
});

// deterministic 32-byte privkey (NOT a real key, fixed for reproducibility)
const TEST_PRIVKEY = hexToBytes('0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20');
// a sample unsigned tx hex ending in `00` (the empty signature length placeholder).
// this shape mirrors what /api/v0/send-deso returns, the bytes themselves don't need to be
// semantically valid for the wrapper test, we only care about the splice mechanics.
const SAMPLE_UNSIGNED_HEX = '0102030405060708090a0b0c00';

describe('sha256x2', () => {
  it('produces 32 bytes', () => {
    const out = sha256x2(new TextEncoder().encode('hello'));
    expect(out.length).toBe(32);
  });

  it('matches sha256(sha256(x)) byte-for-byte', () => {
    const input = new TextEncoder().encode('test message');
    const expected = sha256(sha256(input));
    expect(sha256x2(input)).toEqual(expected);
  });
});

describe('lowSNormalize32', () => {
  it('returns S unchanged when S < N/2', () => {
    const s = new Uint8Array(32); // all zeros = small
    s[31] = 1;
    const out = lowSNormalize32(s);
    expect(out).toEqual(s);
  });

  it('subtracts from N when S > N/2', () => {
    // set S = N - 1 (which is > N/2). result should be 1.
    const s = hexToBytes('fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140');
    const out = lowSNormalize32(s);
    const expected = new Uint8Array(32);
    expected[31] = 1;
    expect(out).toEqual(expected);
  });
});

describe('encodeEcdsaDer', () => {
  it('produces a valid DER SEQUENCE for canonical r,s', () => {
    const r = new Uint8Array(32);
    r[31] = 1; // r = 1
    const s = new Uint8Array(32);
    s[31] = 1; // s = 1
    const der = encodeEcdsaDer(r, s);
    // expected: 30 06 02 01 01 02 01 01
    expect(bytesToHex(der)).toBe('3006020101020101');
  });

  it('pads high-bit values with leading zero', () => {
    const r = new Uint8Array(32);
    r[0] = 0x80; // high bit set, r is 32 bytes => DER must prepend 0x00 to disambiguate
    const s = new Uint8Array(32);
    s[31] = 1;
    const der = encodeEcdsaDer(r, s);
    // r should have a 0x00 prepended in the DER form (33 bytes)
    expect(der[3]).toBe(33); // r length byte
    expect(der[4]).toBe(0x00); // padding
  });
});

describe('wrapEcdsaForDeSo', () => {
  it('mutates the SEQUENCE tag to 0x31 for recovery 0', () => {
    const r = new Uint8Array(32);
    r[31] = 1;
    const s = new Uint8Array(32);
    s[31] = 1;
    const wrapped = wrapEcdsaForDeSo({ r, s, recoveryId: 0 });
    expect(wrapped.signatureBytes[0]).toBe(0x31);
  });

  it('cycles 0..3 → 0x31..0x34', () => {
    const r = new Uint8Array(32);
    r[31] = 1;
    const s = new Uint8Array(32);
    s[31] = 1;
    for (let recoveryId = 0; recoveryId < 4; recoveryId++) {
      const w = wrapEcdsaForDeSo({ r, s, recoveryId });
      expect(w.signatureBytes[0]).toBe(0x30 + 1 + recoveryId);
    }
  });

  it('rejects recovery > 3', () => {
    const r = new Uint8Array(32);
    r[31] = 1;
    const s = new Uint8Array(32);
    s[31] = 1;
    expect(() => wrapEcdsaForDeSo({ r, s, recoveryId: 4 })).toThrow(/recoveryId/);
  });

  it('low-S normalizes high S before wrapping', () => {
    const r = new Uint8Array(32);
    r[31] = 1;
    const sHigh = hexToBytes('fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140');
    const w = wrapEcdsaForDeSo({ r, s: sHigh, recoveryId: 0 });
    // the wrapped DER should embed the normalized (low) S = 1, not the original high S.
    // the last byte of the DER should be 0x01 (low S).
    expect(w.signatureBytes[w.signatureBytes.length - 1]).toBe(0x01);
  });
});

describe('findRecoveryId (round-trip with @noble/secp256k1)', () => {
  it('finds the correct recoveryId for a synthetic ECDSA signature', () => {
    const digest = sha256(new TextEncoder().encode('chromatika test message'));
    const expectedPub = getPublicKey(TEST_PRIVKEY, true); // compressed
    // noble v3 'recovered' format = [recoveryByte (1) || r (32) || s (32)], 65 bytes total.
    const recovered = sign(digest, TEST_PRIVKEY, { format: 'recovered' });
    const expectedRecovery = recovered[0]!;
    const r = recovered.subarray(1, 33);
    const s = recovered.subarray(33, 65);
    const found = findRecoveryId({ r, s, digest, expectedCompressedPubkey: expectedPub });
    expect(found).not.toBeNull();
    expect(found).toBe(expectedRecovery);
  });

  it('returns null when no recovery byte recovers the pubkey', () => {
    const digest = sha256(new TextEncoder().encode('test'));
    const wrongPriv = hexToBytes('0202020202020202020202020202020202020202020202020202020202020202');
    const wrongPub = getPublicKey(wrongPriv, true);
    // sign with TEST_PRIVKEY, expect findRecoveryId to NOT recover wrongPub for any recoveryId.
    const recovered = sign(digest, TEST_PRIVKEY, { format: 'recovered' });
    const r = recovered.subarray(1, 33);
    const s = recovered.subarray(33, 65);
    const found = findRecoveryId({ r, s, digest, expectedCompressedPubkey: wrongPub });
    expect(found).toBeNull();
  });
});

describe('spliceSignatureIntoTransactionHex', () => {
  it('replaces the trailing 00 with sigLen + sigBytes', () => {
    const r = new Uint8Array(32);
    r[31] = 1;
    const s = new Uint8Array(32);
    s[31] = 1;
    const wrapped = wrapEcdsaForDeSo({ r, s, recoveryId: 0 });
    const spliced = spliceSignatureIntoTransactionHex(SAMPLE_UNSIGNED_HEX, wrapped);
    // should drop the trailing 00 and append the varint sig length + sig hex.
    const head = SAMPLE_UNSIGNED_HEX.slice(0, -2);
    const sigLenHex = wrapped.signatureLength.toString(16).padStart(2, '0');
    expect(spliced).toBe(head + sigLenHex + wrapped.signatureHex);
  });

  it('rejects unsigned hex that does not end in 00', () => {
    const r = new Uint8Array(32);
    r[31] = 1;
    const s = new Uint8Array(32);
    s[31] = 1;
    const wrapped = wrapEcdsaForDeSo({ r, s, recoveryId: 0 });
    expect(() => spliceSignatureIntoTransactionHex('010203ff', wrapped)).toThrow(/empty signature length placeholder/);
  });
});
