/**
 * tests for DeSo address derivation. verify:
 *   1. compressed pubkey + mainnet prefix to base58check produces a `BC1...` address shape
 *   2. round-trip (encode to decode to match original pubkey)
 *   3. rejects invalid inputs (wrong length, wrong leading byte, bad checksum)
 */

import { describe, it, expect } from 'vitest';
import {
  compressUncompressedPubkey,
  decodeDeSoAddress,
  encodeDeSoAddress,
  isDeSoAddress,
} from '@/background/chains/deso/deso-address';
import { decodeBase58Check, encodeBase58Check } from '@/background/chains/deso/deso-base58check';

// deterministic compressed pubkey for tests (NOT a real key).
const TEST_COMPRESSED = new Uint8Array(33);
TEST_COMPRESSED[0] = 0x02;
for (let i = 1; i < 33; i++) TEST_COMPRESSED[i] = i;

const TEST_UNCOMPRESSED = new Uint8Array(65);
TEST_UNCOMPRESSED[0] = 0x04;
for (let i = 1; i < 33; i++) TEST_UNCOMPRESSED[i] = i; // x
for (let i = 33; i < 65; i++) TEST_UNCOMPRESSED[i] = i - 32; // y (last byte = 32, even, y is even, 0x02 prefix when compressed)

describe('base58check round-trip', () => {
  it('encode → decode preserves the payload', () => {
    const payload = new Uint8Array([0xcd, 0x14, 0x00, ...TEST_COMPRESSED]);
    const encoded = encodeBase58Check(payload);
    const decoded = decodeBase58Check(encoded);
    expect(decoded).toEqual(payload);
  });

  it('rejects checksum mismatch', () => {
    const payload = new Uint8Array([0xcd, 0x14, 0x00, ...TEST_COMPRESSED]);
    const encoded = encodeBase58Check(payload);
    // flip a character in the body
    const tampered = encoded.slice(0, -1) + (encoded[encoded.length - 1] === '1' ? '2' : '1');
    expect(() => decodeBase58Check(tampered)).toThrow(/checksum/);
  });
});

describe('encodeDeSoAddress', () => {
  it('produces a mainnet address starting with BC1', () => {
    const address = encodeDeSoAddress(TEST_COMPRESSED, 'mainnet');
    expect(address.startsWith('BC1')).toBe(true);
  });

  it('round-trips: encode → decode returns the same compressed pubkey', () => {
    const address = encodeDeSoAddress(TEST_COMPRESSED, 'mainnet');
    const recovered = decodeDeSoAddress(address, 'mainnet');
    expect(recovered).toEqual(TEST_COMPRESSED);
  });

  it('rejects pubkey with wrong length', () => {
    expect(() => encodeDeSoAddress(new Uint8Array(32), 'mainnet')).toThrow(/33-byte/);
  });

  it('rejects pubkey with wrong leading byte', () => {
    const bad = new Uint8Array(33);
    bad[0] = 0x05; // not 02 or 03
    expect(() => encodeDeSoAddress(bad, 'mainnet')).toThrow(/0x02 or 0x03/);
  });

  it('mainnet vs testnet prefixes produce different addresses', () => {
    const main = encodeDeSoAddress(TEST_COMPRESSED, 'mainnet');
    const test = encodeDeSoAddress(TEST_COMPRESSED, 'testnet');
    expect(main).not.toBe(test);
  });
});

describe('compressUncompressedPubkey', () => {
  it('detects y parity correctly', () => {
    const compressed = compressUncompressedPubkey(TEST_UNCOMPRESSED);
    expect(compressed.length).toBe(33);
    // last byte of y in TEST_UNCOMPRESSED was 32, even, 0x02 prefix
    expect(compressed[0]).toBe(0x02);
    expect(compressed.subarray(1)).toEqual(TEST_UNCOMPRESSED.subarray(1, 33));
  });

  it('rejects non-uncompressed input', () => {
    expect(() => compressUncompressedPubkey(new Uint8Array(33))).toThrow(/65-byte/);
  });
});

describe('isDeSoAddress', () => {
  it('returns true for a valid encoded address', () => {
    const address = encodeDeSoAddress(TEST_COMPRESSED, 'mainnet');
    expect(isDeSoAddress(address, 'mainnet')).toBe(true);
  });

  it('returns false for garbage', () => {
    expect(isDeSoAddress('not a valid address', 'mainnet')).toBe(false);
  });

  it('returns false for testnet address checked against mainnet', () => {
    const test = encodeDeSoAddress(TEST_COMPRESSED, 'testnet');
    expect(isDeSoAddress(test, 'mainnet')).toBe(false);
  });
});
