/**
 * DeSo signature wrapping. takes our compact `r||s` ECDSA output (from the ika SECP MPC path)
 * and produces the byte form DeSo's `/api/v0/submit-transaction` accepts:
 *
 *   standard DER:                  `[0x30, totLen, 0x02, rLen, R, 0x02, sLen, S]`
 *   DeSo derived-key (recovery):   `[0x30 + 1 + recoveryId, totLen, 0x02, rLen, R, 0x02, sLen, S]`
 *
 * the recovery byte is encoded by *mutating* the SEQUENCE tag in place, NOT prepended. total
 * length is unchanged. verifiers (deso-protocol/core post-PR-#380) accept both `0x30` and
 * `0x31`-`0x34` prefixes.
 *
 * spike doc: `wallet-extension/docs/DESO_SPIKE.md` section "Signature wire format".
 *
 * this is a pure-data layer with NO chain RPC + no chrome dependency, fully unit-testable.
 */

import { Point, recoverPublicKey, hashes as secpHashes } from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha2.js';

// noble-secp256k1 v3 needs sha256 injected before any hashing-dependent path runs
// (recoverPublicKey internally hashes for some operations). idempotent across imports.
secpHashes.sha256 = sha256;

const SECP256K1_ORDER_N = Point.CURVE().n;

/** double-sha256, the digest scheme DeSo uses for signed-bytes derivation. */
export function sha256x2(bytes: Uint8Array): Uint8Array {
  return sha256(sha256(bytes));
}

/** hex-encode a Uint8Array (lowercase, no `0x` prefix). */
export function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i]!.toString(16).padStart(2, '0');
  return s;
}

export function hexToBytes(hex: string): Uint8Array {
  const t = hex.replace(/^0x/i, '');
  if (t.length % 2 !== 0) throw new Error('hex length must be even');
  const out = new Uint8Array(t.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(t.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * strip leading zero bytes for DER integer representation, but keep one zero if the high bit
 * of the next byte is set (DER requires a leading zero for positive numbers when the MSB of
 * the first remaining byte is 1, to disambiguate from negative two's-complement).
 */
function derEncodeInteger(bytes: Uint8Array): Uint8Array {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start++;
  let trimmed = bytes.subarray(start);
  if ((trimmed[0]! & 0x80) !== 0) {
    const padded = new Uint8Array(trimmed.length + 1);
    padded[0] = 0x00;
    padded.set(trimmed, 1);
    trimmed = padded;
  }
  return trimmed;
}

/** build the standard DER SEQUENCE bytes from raw 32-byte r and s. */
export function encodeEcdsaDer(r: Uint8Array, s: Uint8Array): Uint8Array {
  if (r.length !== 32 || s.length !== 32) {
    throw new Error('encodeEcdsaDer expects 32-byte r and s');
  }
  const rDer = derEncodeInteger(r);
  const sDer = derEncodeInteger(s);
  const totLen = 2 + rDer.length + 2 + sDer.length;
  const out = new Uint8Array(2 + totLen);
  let i = 0;
  out[i++] = 0x30; // SEQUENCE tag
  out[i++] = totLen;
  out[i++] = 0x02; // INTEGER tag
  out[i++] = rDer.length;
  out.set(rDer, i);
  i += rDer.length;
  out[i++] = 0x02;
  out[i++] = sDer.length;
  out.set(sDer, i);
  return out;
}

/** subtract S from N when S > N/2 (BIP62 / DeSo malleability rule). returns normalized 32-byte S. */
export function lowSNormalize32(s: Uint8Array): Uint8Array {
  if (s.length !== 32) throw new Error('s must be 32 bytes');
  let sBig = 0n;
  for (let i = 0; i < 32; i++) sBig = (sBig << 8n) | BigInt(s[i]!);
  const halfN = SECP256K1_ORDER_N / 2n;
  if (sBig > halfN) {
    sBig = SECP256K1_ORDER_N - sBig;
  }
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(sBig & 0xffn);
    sBig >>= 8n;
  }
  return out;
}

export interface DeSoWrapInput {
  /** 32-byte r */
  r: Uint8Array;
  /** 32-byte s (caller may pre-normalize, we always normalize again to be safe) */
  s: Uint8Array;
  /** 0..3, picked by the caller via `recoverPublicKey` matching against the expected pubkey. */
  recoveryId: number;
}

export interface DeSoWrappedSignature {
  /** final byte form to splice into TransactionHex (after the varint-length byte). */
  signatureBytes: Uint8Array;
  /** same as `signatureBytes.length`. the varint length DeSo expects before these bytes. */
  signatureLength: number;
  /** hex-encoded for diagnostics. */
  signatureHex: string;
}

/**
 * wrap an ika MPC ECDSA output for DeSo's submit-transaction endpoint. applies low-S
 * normalization, builds the DER envelope, then mutates the SEQUENCE tag with the recovery byte
 * per upstream `signTx` (`deso-protocol/deso-js`, `crypto-utils.ts:259-291`).
 */
export function wrapEcdsaForDeSo(input: DeSoWrapInput): DeSoWrappedSignature {
  if (input.recoveryId < 0 || input.recoveryId > 3) {
    throw new Error(`recoveryId must be 0..3, got ${input.recoveryId}`);
  }
  const sNorm = lowSNormalize32(input.s);
  const der = encodeEcdsaDer(input.r, sNorm);
  // in-place mutation of the SEQUENCE tag.
  const wrapped = new Uint8Array(der);
  wrapped[0] = (wrapped[0]! + 1 + input.recoveryId) & 0xff;
  return {
    signatureBytes: wrapped,
    signatureLength: wrapped.length,
    signatureHex: bytesToHex(wrapped),
  };
}

/**
 * splice a wrapped signature into an unsigned `TransactionHex`. the unsigned hex ends in `00`
 * (uvarint signature length = 0). we drop those 2 hex chars and append
 * `<sigLenAsHex><sigBytesAsHex>`.
 *
 * only valid for v0 transactions (no v1 ExtraData tail). v1 needs the deso-js
 * `TransactionV0.fromBytes` parser to peel off the trailing buffer, we don't need it for
 * send-DeSo or simple submit-post.
 */
export function spliceSignatureIntoTransactionHex(
  unsignedHex: string,
  wrapped: DeSoWrappedSignature,
): string {
  const trimmed = unsignedHex.toLowerCase().replace(/^0x/, '');
  if (!trimmed.endsWith('00')) {
    throw new Error('unsigned TransactionHex must end with `00` (empty signature length placeholder)');
  }
  if (wrapped.signatureLength > 0x7f) {
    // varint encoding for lengths > 127 needs multi-byte representation. v0 sigs are 70-72.
    throw new Error(
      `signature length ${wrapped.signatureLength} exceeds single-byte uvarint range, multi-byte not supported`,
    );
  }
  const head = trimmed.slice(0, trimmed.length - 2);
  const sigLenHex = wrapped.signatureLength.toString(16).padStart(2, '0');
  return head + sigLenHex + wrapped.signatureHex;
}

/**
 * recover the recoveryId for a given r||s + digest + expected compressed pubkey. tries 0/1/2/3
 * and returns the first match. mirrors the EVM v-recovery loop in `evm-send.ts`.
 *
 * returns `null` when no recovery byte recovers the expected pubkey, that's a fatal error
 * indicating an ika output / pubkey mismatch.
 */
export function findRecoveryId(args: {
  r: Uint8Array;
  s: Uint8Array;
  digest: Uint8Array;
  expectedCompressedPubkey: Uint8Array;
}): number | null {
  if (args.expectedCompressedPubkey.length !== 33) {
    throw new Error('expectedCompressedPubkey must be 33-byte compressed');
  }
  // noble v3 'recovered' format = [recoveryByte (1) || r (32) || s (32)], recovery byte FIRST.
  const sigRecovered = new Uint8Array(65);
  sigRecovered.set(args.r, 1);
  sigRecovered.set(args.s, 33);
  for (let recoveryId = 0; recoveryId < 4; recoveryId++) {
    try {
      sigRecovered[0] = recoveryId;
      // recoverPublicKey returns a 33-byte compressed Uint8Array directly.
      const recovered = recoverPublicKey(sigRecovered, args.digest);
      if (
        recovered.length === args.expectedCompressedPubkey.length &&
        recovered.every((b, i) => b === args.expectedCompressedPubkey[i])
      ) {
        return recoveryId;
      }
    } catch {
      // not all recovery ids are valid for a given (r, s, digest), skip + try next
    }
  }
  return null;
}
