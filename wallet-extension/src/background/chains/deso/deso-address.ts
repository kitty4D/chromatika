/**
 * DeSo address derivation. given a SECP256K1 compressed public key (33 bytes), produce the
 * `BC1Y...` mainnet address (or the testnet equivalent) by base58check-encoding
 * `prefix(3) || compressedPubkey(33)`.
 *
 * we accept the full 33-byte compressed form (`0x02`/`0x03` prefix + 32-byte x-coordinate). if
 * caller has the uncompressed 65-byte form, use `compressUncompressedPubkey` first.
 *
 * the brainstorm's pitch ("chromatika's existing SECP dWallet directly produces a valid DeSo
 * identity with zero new key material") is enabled by this file.
 */

import { encodeBase58Check, decodeBase58Check } from '@/background/chains/deso/deso-base58check';
import { DESO_ADDRESS_PREFIX, type DeSoNetwork } from '@/background/chains/deso/deso-constants';

/** compress an uncompressed 65-byte SECP256K1 pubkey (`0x04 || x || y`) to 33 bytes (`0x02|0x03 || x`). */
export function compressUncompressedPubkey(uncompressed: Uint8Array): Uint8Array {
  if (uncompressed.length !== 65 || uncompressed[0] !== 0x04) {
    throw new Error('compressUncompressedPubkey expects 65-byte uncompressed pubkey starting with 0x04');
  }
  const x = uncompressed.subarray(1, 33);
  const y = uncompressed.subarray(33, 65);
  // y is even - 0x02, y is odd - 0x03
  const yIsOdd = (y[31]! & 1) === 1;
  const out = new Uint8Array(33);
  out[0] = yIsOdd ? 0x03 : 0x02;
  out.set(x, 1);
  return out;
}

/** encode a 33-byte compressed SECP256K1 pubkey as a DeSo base58check address. */
export function encodeDeSoAddress(compressedPubkey: Uint8Array, network: DeSoNetwork = 'mainnet'): string {
  if (compressedPubkey.length !== 33) {
    throw new Error(`encodeDeSoAddress expects 33-byte compressed pubkey, got ${compressedPubkey.length}`);
  }
  if (compressedPubkey[0] !== 0x02 && compressedPubkey[0] !== 0x03) {
    throw new Error(`compressed pubkey must start with 0x02 or 0x03, got 0x${compressedPubkey[0]!.toString(16)}`);
  }
  const prefix = DESO_ADDRESS_PREFIX[network];
  const payload = new Uint8Array(prefix.length + compressedPubkey.length);
  payload.set(prefix, 0);
  payload.set(compressedPubkey, prefix.length);
  return encodeBase58Check(payload);
}

/** decode a DeSo address back to the compressed pubkey. throws on checksum failure or wrong prefix. */
export function decodeDeSoAddress(address: string, network: DeSoNetwork = 'mainnet'): Uint8Array {
  const payload = decodeBase58Check(address);
  const prefix = DESO_ADDRESS_PREFIX[network];
  if (payload.length !== prefix.length + 33) {
    throw new Error(`unexpected DeSo address payload length: ${payload.length}`);
  }
  for (let i = 0; i < prefix.length; i++) {
    if (payload[i] !== prefix[i]) {
      throw new Error(`address prefix does not match ${network}`);
    }
  }
  return payload.subarray(prefix.length);
}

export function isDeSoAddress(s: string, network: DeSoNetwork = 'mainnet'): boolean {
  try {
    decodeDeSoAddress(s, network);
    return true;
  } catch {
    return false;
  }
}
