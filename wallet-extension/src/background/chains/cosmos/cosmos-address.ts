/**
 * Cosmos SDK address derivation. Given a SECP256K1 compressed public key (33 bytes), produce a
 * bech32 address `{hrp}1{base32hash}{checksum}` for any Cosmos-SDK chain that uses the standard
 * secp256k1 + ripemd160(sha256(pk)) derivation rule (the vast majority - Cosmos Hub, Osmosis,
 * Juno, Stargaze, Akash, Stride, Sei, etc.). Each chain ships its own HRP (`cosmos`, `osmo`,
 * `juno`, ...) which is the only thing that varies in the encoding.
 *
 * **the math**: `bech32.encode(hrp, toWords(ripemd160(sha256(compressed))))`. Same hash chain
 * BTC's `p2pkh` / `p2wpkh` use, just bech32-encoded with a Cosmos HRP and **no witness version
 * byte** (BTC adds `0` for v0 segwit; Cosmos addresses are unprefixed in the words array).
 *
 * Reuses `@noble/hashes` (sha256 + ripemd160) and `@scure/base` (bech32) already in chromatika
 * via the BTC module - no new deps.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { bech32 } from '@scure/base';

/** validate that `compressed` is a 33-byte SEC1 compressed secp256k1 pubkey. */
function assertCompressedPubkey(compressed: Uint8Array): void {
  if (compressed.length !== 33) {
    throw new Error(`encodeCosmosAddress expects 33-byte compressed pubkey, got ${compressed.length}`);
  }
  if (compressed[0] !== 0x02 && compressed[0] !== 0x03) {
    throw new Error(`compressed pubkey must start with 0x02 or 0x03, got 0x${compressed[0]!.toString(16)}`);
  }
}

/**
 * Encode a 33-byte compressed SECP256K1 pubkey as a Cosmos-SDK bech32 address.
 *
 * @param compressed 33-byte SEC1 compressed secp256k1 pubkey
 * @param hrp Human-readable prefix for the target chain (`cosmos` / `osmo` / `juno` / ...)
 */
export function encodeCosmosAddress(compressed: Uint8Array, hrp: string): string {
  assertCompressedPubkey(compressed);
  if (!hrp || hrp.length === 0) throw new Error('encodeCosmosAddress requires an HRP');
  const hash20 = ripemd160(sha256(compressed));
  return bech32.encode(hrp, bech32.toWords(hash20));
}

/** Inverse: parse a Cosmos bech32 address back to its 20-byte hash + verify the HRP. */
export function decodeCosmosAddress(address: string, expectedHrp: string): Uint8Array {
  const decoded = bech32.decode(address as `${string}1${string}`);
  if (decoded.prefix !== expectedHrp) {
    throw new Error(`expected hrp '${expectedHrp}', got '${decoded.prefix}'`);
  }
  const bytes = bech32.fromWords(decoded.words);
  if (bytes.length !== 20) {
    throw new Error(`unexpected Cosmos address payload length: ${bytes.length}`);
  }
  return new Uint8Array(bytes);
}

/** Quick predicate for UI validation; doesn't throw on parse failure. */
export function isCosmosAddress(address: string, expectedHrp: string): boolean {
  try {
    decodeCosmosAddress(address, expectedHrp);
    return true;
  } catch {
    return false;
  }
}
