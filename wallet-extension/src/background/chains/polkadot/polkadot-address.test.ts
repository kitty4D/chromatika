import { describe, expect, it } from 'vitest';
import { encodeSs58Address, decodeSs58Address, isSs58Address, SS58_NETWORKS } from '@/background/chains/polkadot/polkadot-address';

const TEST_ED25519_PUBKEY = new Uint8Array(32).map((_, i) => (i * 7 + 11) & 0xff);

describe('encodeSs58Address', () => {
  it('produces a valid Polkadot mainnet address (ss58Prefix 0)', () => {
    const addr = encodeSs58Address(TEST_ED25519_PUBKEY, SS58_NETWORKS.polkadot);
    // polkadot mainnet addresses start with `1` per the standard ss58 alphabet for prefix 0.
    expect(addr.startsWith('1')).toBe(true);
    // typical polkadot address is ~46-48 chars (base58 of 35 bytes ~ 47 chars).
    expect(addr.length).toBeGreaterThanOrEqual(45);
    expect(addr.length).toBeLessThanOrEqual(48);
  });

  it('round-trips: encode -> decode yields the original pubkey + prefix', () => {
    const addr = encodeSs58Address(TEST_ED25519_PUBKEY, SS58_NETWORKS.polkadot);
    const { pubkey, prefix } = decodeSs58Address(addr);
    expect(prefix).toBe(0);
    expect(pubkey.length).toBe(32);
    expect(Array.from(pubkey)).toEqual(Array.from(TEST_ED25519_PUBKEY));
  });

  it('different network prefixes produce different addresses for the same pubkey', () => {
    const polkadot = encodeSs58Address(TEST_ED25519_PUBKEY, SS58_NETWORKS.polkadot);
    const kusama = encodeSs58Address(TEST_ED25519_PUBKEY, SS58_NETWORKS.kusama);
    const substrate = encodeSs58Address(TEST_ED25519_PUBKEY, SS58_NETWORKS.substrate);
    expect(polkadot).not.toBe(kusama);
    expect(polkadot).not.toBe(substrate);
    expect(kusama).not.toBe(substrate);
  });

  it('throws on wrong-length pubkey', () => {
    expect(() => encodeSs58Address(new Uint8Array(31), SS58_NETWORKS.polkadot)).toThrow(/32-byte/);
    expect(() => encodeSs58Address(new Uint8Array(33), SS58_NETWORKS.polkadot)).toThrow(/32-byte/);
  });

  it('throws on out-of-range network prefix', () => {
    expect(() => encodeSs58Address(TEST_ED25519_PUBKEY, { label: 'bogus', prefix: -1 })).toThrow(/out of range/);
    expect(() => encodeSs58Address(TEST_ED25519_PUBKEY, { label: 'bogus', prefix: 16384 })).toThrow(/out of range/);
  });
});

describe('decodeSs58Address', () => {
  it('rejects addresses with bad checksum', () => {
    const valid = encodeSs58Address(TEST_ED25519_PUBKEY, SS58_NETWORKS.polkadot);
    // mutate one character in the middle to break the checksum.
    const mutated = valid.slice(0, 10) + (valid[10]! === 'A' ? 'B' : 'A') + valid.slice(11);
    expect(() => decodeSs58Address(mutated)).toThrow();
  });

  it('rejects addresses that are too short', () => {
    expect(() => decodeSs58Address('short')).toThrow();
  });
});

describe('isSs58Address', () => {
  it('returns true for a valid address', () => {
    const addr = encodeSs58Address(TEST_ED25519_PUBKEY, SS58_NETWORKS.polkadot);
    expect(isSs58Address(addr)).toBe(true);
  });

  it('returns true when prefix matches the expected network', () => {
    const addr = encodeSs58Address(TEST_ED25519_PUBKEY, SS58_NETWORKS.polkadot);
    expect(isSs58Address(addr, 0)).toBe(true);
  });

  it('returns false when prefix mismatches the expected network', () => {
    const polkadot = encodeSs58Address(TEST_ED25519_PUBKEY, SS58_NETWORKS.polkadot);
    expect(isSs58Address(polkadot, 2 /* kusama */)).toBe(false);
  });

  it('returns false for non-SS58 input', () => {
    expect(isSs58Address('not-an-address')).toBe(false);
    expect(isSs58Address('')).toBe(false);
  });
});
