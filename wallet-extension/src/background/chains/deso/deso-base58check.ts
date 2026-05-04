/**
 * base58check encoder/decoder. DeSo addresses are `base58check(prefix(3) || compressedPubkey(33))`,
 * same encoding family as Bitcoin addresses + WIF privkeys. we hand-roll instead of pulling
 * `bs58check` because chromatika doesn't already depend on it and the algorithm is ~50 lines.
 *
 * algorithm:
 *   encode(payload): base58(payload || sha256(sha256(payload))[0..4])
 *   decode(s): bytes = base58_decode(s), split last 4 bytes as checksum, verify sha256(sha256(payload)) starts with checksum
 *
 * pure functions. standard base58 alphabet (Bitcoin):
 *   "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
 */

import { sha256 } from '@noble/hashes/sha2.js';

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_INDEX_MAP = new Map<string, number>();
for (let i = 0; i < BASE58_ALPHABET.length; i++) {
  BASE58_INDEX_MAP.set(BASE58_ALPHABET[i]!, i);
}

function sha256x2(bytes: Uint8Array): Uint8Array {
  return sha256(sha256(bytes));
}

/** encode raw bytes to base58 (no checksum). */
export function encodeBase58(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';
  // count leading zero bytes, each becomes a leading '1' in the output.
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;

  // convert byte array to a big-endian integer represented as a base-58 digit array.
  // we process bytes in order, each byte is added into a running base-58 representation.
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i]!;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j]! * 256;
      digits[j] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }

  let out = '';
  for (let i = 0; i < zeros; i++) out += '1';
  for (let i = digits.length - 1; i >= 0; i--) out += BASE58_ALPHABET[digits[i]!];
  return out;
}

export function decodeBase58(s: string): Uint8Array {
  if (s.length === 0) return new Uint8Array(0);
  let zeros = 0;
  while (zeros < s.length && s[zeros] === '1') zeros++;

  const bytes: number[] = [];
  for (let i = zeros; i < s.length; i++) {
    const digit = BASE58_INDEX_MAP.get(s[i]!);
    if (digit === undefined) throw new Error(`invalid base58 char: ${s[i]}`);
    let carry = digit;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j]! * 58;
      bytes[j] = carry & 0xff;
      carry >>>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>>= 8;
    }
  }

  const out = new Uint8Array(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) out[zeros + i] = bytes[bytes.length - 1 - i]!;
  return out;
}

/** base58check: append `sha256(sha256(payload))[0..4]` then base58-encode. */
export function encodeBase58Check(payload: Uint8Array): string {
  const checksum = sha256x2(payload).subarray(0, 4);
  const combined = new Uint8Array(payload.length + 4);
  combined.set(payload, 0);
  combined.set(checksum, payload.length);
  return encodeBase58(combined);
}

/** verify + strip checksum. throws on mismatch. */
export function decodeBase58Check(s: string): Uint8Array {
  const decoded = decodeBase58(s);
  if (decoded.length < 4) throw new Error('base58check input too short');
  const payload = decoded.subarray(0, decoded.length - 4);
  const supplied = decoded.subarray(decoded.length - 4);
  const expected = sha256x2(payload).subarray(0, 4);
  for (let i = 0; i < 4; i++) {
    if (supplied[i] !== expected[i]) throw new Error('base58check checksum mismatch');
  }
  return new Uint8Array(payload);
}
