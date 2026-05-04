/**
 * Polkadot / Substrate SS58 address derivation.
 *
 * SS58 encoding (per the substrate spec):
 *   1. ss58Prefix:  1 byte for prefixes 0-63 (most chains), 2 bytes for 64-16383
 *      (encoded as `0b01xxxxxx | 0b1xxxxxxx` weighted: `((prefix & 0x3F) << 8) | (prefix >> 6) | 0x4000`)
 *   2. payload:     32-byte ed25519 (or sr25519) public key
 *   3. checksum:    first 2 bytes of `blake2b("SS58PRE" || prefix || payload, dkLen=64)`
 *   4. base58 encode the concatenation
 *
 * **chromatika uses ed25519** (the same scheme that drives Solana / Sui / Aptos derivations
 * already in chromatika). Polkadot wallets like polkadot.js / Talisman / Nova default to
 * sr25519 - users who created their account in those wallets will see a DIFFERENT chromatika
 * address from their "real" polkadot one. recovery via SS58 only works when the user
 * deliberately picked ed25519 in their wallet, OR uses chromatika's mnemonic exclusively
 * for polkadot. surfaced in the registry comment + the scan results note.
 *
 * standard polkadot ss58Prefix values: 0=Polkadot, 2=Kusama, 42=Generic-Substrate.
 *
 * Reuses chromatika's existing base58 implementation (`encodeBase58` from the deso module)
 * and `@noble/hashes/blake2.js` already in the BTC + passkey paths. zero new deps.
 */

import { blake2b } from '@noble/hashes/blake2.js';
import { encodeBase58, decodeBase58 } from '@/background/chains/deso/deso-base58check';

const SS58PRE = new Uint8Array([0x53, 0x53, 0x35, 0x38, 0x50, 0x52, 0x45]); // "SS58PRE"

export type Ss58Network = {
  /** human-readable label, e.g. 'Polkadot' / 'Kusama'. */
  label: string;
  /** SS58 network id - 0 polkadot mainnet, 2 kusama, 42 generic substrate. */
  prefix: number;
};

export const SS58_NETWORKS = {
  polkadot: { label: 'Polkadot', prefix: 0 } as const,
  kusama: { label: 'Kusama', prefix: 2 } as const,
  substrate: { label: 'Substrate', prefix: 42 } as const,
} satisfies Record<string, Ss58Network>;

/** encode the prefix as 1 or 2 bytes per the SS58 weighted format. */
function encodePrefix(prefix: number): Uint8Array {
  if (prefix < 0 || prefix > 16383) {
    throw new Error(`SS58 prefix out of range: ${prefix}`);
  }
  if (prefix < 64) {
    return new Uint8Array([prefix]);
  }
  // weighted 2-byte form
  const lo = (prefix & 0xff) | 0x40;
  const hi = (prefix >> 8) & 0xff;
  return new Uint8Array([0x40 | hi | ((prefix & 0xff) >> 2), lo]);
}

/** encode a 32-byte ed25519 (or sr25519) pubkey as an SS58 address for the given network. */
export function encodeSs58Address(pubkey32: Uint8Array, network: Ss58Network): string {
  if (pubkey32.length !== 32) {
    throw new Error(`encodeSs58Address expects a 32-byte pubkey, got ${pubkey32.length}`);
  }
  const prefixBytes = encodePrefix(network.prefix);
  const payload = new Uint8Array(prefixBytes.length + pubkey32.length);
  payload.set(prefixBytes, 0);
  payload.set(pubkey32, prefixBytes.length);

  const hashInput = new Uint8Array(SS58PRE.length + payload.length);
  hashInput.set(SS58PRE, 0);
  hashInput.set(payload, SS58PRE.length);
  const checksumFull = blake2b(hashInput, { dkLen: 64 });
  const checksum = checksumFull.subarray(0, 2);

  const out = new Uint8Array(payload.length + 2);
  out.set(payload, 0);
  out.set(checksum, payload.length);
  return encodeBase58(out);
}

/** decode an SS58 address back to its 32-byte pubkey + network prefix. */
export function decodeSs58Address(address: string): { pubkey: Uint8Array; prefix: number } {
  const decoded = decodeBase58(address);
  if (decoded.length < 35) {
    throw new Error(`SS58 address too short: ${decoded.length} bytes`);
  }
  // detect prefix length from the leading byte's upper bits.
  const lead = decoded[0]!;
  let prefixLen: number;
  let prefix: number;
  if (lead < 64) {
    prefixLen = 1;
    prefix = lead;
  } else if ((lead & 0xC0) === 0x40) {
    prefixLen = 2;
    const hi = decoded[1]! & 0x3F;
    const lo = ((decoded[0]! & 0x3F) << 2) | (decoded[1]! >> 6);
    prefix = (hi << 8) | lo;
  } else {
    throw new Error('SS58 address has invalid prefix encoding');
  }

  const expectedLen = prefixLen + 32 + 2;
  if (decoded.length !== expectedLen) {
    throw new Error(`SS58 address length mismatch: ${decoded.length} vs ${expectedLen}`);
  }

  const payload = decoded.subarray(0, prefixLen + 32);
  const checksum = decoded.subarray(prefixLen + 32);
  const hashInput = new Uint8Array(SS58PRE.length + payload.length);
  hashInput.set(SS58PRE, 0);
  hashInput.set(payload, SS58PRE.length);
  const expected = blake2b(hashInput, { dkLen: 64 }).subarray(0, 2);
  if (expected[0] !== checksum[0] || expected[1] !== checksum[1]) {
    throw new Error('SS58 checksum mismatch');
  }
  return { pubkey: decoded.subarray(prefixLen, prefixLen + 32), prefix };
}

export function isSs58Address(address: string, expectedPrefix?: number): boolean {
  try {
    const { prefix } = decodeSs58Address(address);
    if (typeof expectedPrefix === 'number' && prefix !== expectedPrefix) return false;
    return true;
  } catch {
    return false;
  }
}
