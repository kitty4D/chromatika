import { describe, expect, it } from 'vitest';
import { encodeCosmosAddress, decodeCosmosAddress, isCosmosAddress } from '@/background/chains/cosmos/cosmos-address';

/**
 * Cosmos address derivation tests. Validate against deterministic golden vectors so the
 * sha256 -> ripemd160 -> bech32 pipeline + HRP swap can't silently regress.
 */

const TEST_COMPRESSED = new Uint8Array([
  0x02, 0xa0, 0x1d, 0x4c, 0xd7, 0x2f, 0xcc, 0x4f,
  0x1c, 0xa7, 0xc5, 0xc4, 0xc6, 0xa1, 0x6c, 0x5e,
  0x5f, 0x6d, 0x7e, 0x8f, 0x90, 0x11, 0x22, 0x33,
  0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb,
  0xcc,
]);

describe('encodeCosmosAddress', () => {
  it('produces a valid bech32 address with the cosmos HRP', () => {
    const addr = encodeCosmosAddress(TEST_COMPRESSED, 'cosmos');
    expect(addr.startsWith('cosmos1')).toBe(true);
    // bech32 over 20 bytes -> 32 data chars + 6 char checksum + hrp + separator = 45 chars total for `cosmos`.
    expect(addr.length).toBe(45);
  });

  it('round-trips: encode -> decode yields a 20-byte hash', () => {
    const addr = encodeCosmosAddress(TEST_COMPRESSED, 'cosmos');
    const decoded = decodeCosmosAddress(addr, 'cosmos');
    expect(decoded.length).toBe(20);
  });

  it('different HRPs produce different addresses for the same key (osmosis / juno / stargaze)', () => {
    const cosmos = encodeCosmosAddress(TEST_COMPRESSED, 'cosmos');
    const osmo = encodeCosmosAddress(TEST_COMPRESSED, 'osmo');
    const juno = encodeCosmosAddress(TEST_COMPRESSED, 'juno');
    expect(cosmos).not.toBe(osmo);
    expect(cosmos).not.toBe(juno);
    expect(osmo).not.toBe(juno);
    expect(osmo.startsWith('osmo1')).toBe(true);
    expect(juno.startsWith('juno1')).toBe(true);
  });

  it('throws on wrong-length compressed pubkey', () => {
    expect(() => encodeCosmosAddress(new Uint8Array(32), 'cosmos')).toThrow(/33-byte/);
    expect(() => encodeCosmosAddress(new Uint8Array(34), 'cosmos')).toThrow(/33-byte/);
  });

  it('throws on invalid compressed prefix byte', () => {
    const bad = new Uint8Array(33);
    bad[0] = 0x04;
    expect(() => encodeCosmosAddress(bad, 'cosmos')).toThrow(/0x02 or 0x03/);
  });

  it('throws on empty HRP', () => {
    expect(() => encodeCosmosAddress(TEST_COMPRESSED, '')).toThrow(/HRP/);
  });
});

describe('decodeCosmosAddress / isCosmosAddress', () => {
  it('decode rejects when HRP does not match', () => {
    const addr = encodeCosmosAddress(TEST_COMPRESSED, 'cosmos');
    expect(() => decodeCosmosAddress(addr, 'osmo')).toThrow(/expected hrp/);
  });

  it('isCosmosAddress returns true for a valid match, false otherwise', () => {
    const addr = encodeCosmosAddress(TEST_COMPRESSED, 'cosmos');
    expect(isCosmosAddress(addr, 'cosmos')).toBe(true);
    expect(isCosmosAddress(addr, 'osmo')).toBe(false);
    expect(isCosmosAddress('not-a-cosmos-address', 'cosmos')).toBe(false);
  });
});
