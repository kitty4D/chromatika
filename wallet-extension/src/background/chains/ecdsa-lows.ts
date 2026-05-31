// low-S normalization for compact secp256k1 ECDSA sigs. ika's MPC sign output (via the wasm
// `parse_signature_from_sign_output` that `IkaClient.getSign` runs on Completed sessions) is
// *almost certainly* already low-S - EVM sends are proof, since ethers' `recoverAddress` throws
// "non-canonical s" on a high-S value and our EVM path works. but BTC is fail-OPEN: bitcoinjs
// `script.signature.encode` happily DER-encodes a high-S sig, and relays reject non-low-S txs
// (BIP-62 / BIP-146 malleability standardness). so we normalize defensively at the DER-encode
// chokepoint - same thing the ika `@ika.xyz/plugins` bitcoin destination does - so we never lean
// on unverified wasm behavior for whether a BTC tx is even relayable.

/** secp256k1 group order N. */
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
/** floor(N / 2). s values strictly above this are "high-S" and get flipped to N - s. */
const SECP256K1_HALF_N = SECP256K1_N >> 1n;

/**
 * normalize a 64-byte compact `r || s` ECDSA signature to low-S form. returns the input array
 * unchanged when it's already low-S, otherwise a fresh array with `s' = N - s`. `r` is left
 * untouched and the signature stays valid (low-S is just the canonical of the two malleable s
 * values for the same message + key). idempotent.
 */
export function normalizeEcdsaLowS(sig64: Uint8Array): Uint8Array {
  if (sig64.length !== 64) {
    throw new Error(`normalizeEcdsaLowS: expected 64-byte r||s, got ${sig64.length}`);
  }
  let s = 0n;
  for (let i = 32; i < 64; i++) s = (s << 8n) | BigInt(sig64[i]);
  if (s <= SECP256K1_HALF_N) return sig64;
  let low = SECP256K1_N - s;
  const out = new Uint8Array(sig64);
  for (let i = 63; i >= 32; i--) {
    out[i] = Number(low & 0xffn);
    low >>= 8n;
  }
  return out;
}
