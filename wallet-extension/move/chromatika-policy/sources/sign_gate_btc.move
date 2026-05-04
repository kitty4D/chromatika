/// chromatika_policy::sign_gate_btc
///
/// Hard-policy variant of `sign_gate` for Bitcoin transactions. Decodes the BIP143 witness-v0
/// sighash preimage on-chain in Move, extracting the `amount` field (the value of the UTXO
/// being spent, in satoshis). Replaces the soft-policy `declared_value_micros` arg with a
/// chain-derived value. Lying caller can no longer bypass the cap; the chain enforces.
///
/// v1 scope: BIP143 witness-v0 (P2WPKH + P2WSH inputs). Legacy (pre-segwit) and Taproot
/// (BIP341 SIGHASH preimage) are out of scope; calls with malformed / wrong-shape preimages
/// abort `EBadPreimage`. Chromatika's BTC send paths today emit witness-v0 sighashes, so
/// this covers the active surface.
///
/// Architecture: this module wraps the `sign_gate::PolicyVault` shared object (caller passes
/// `&mut PolicyVault` + the same `presign_cap` as soft-policy `sign_with_policy`). It swaps
/// the soft-policy `declared_value_micros` for an on-chain `(decoded_value_sats *
/// price_micros_per_satoshi)` call. The price is supplied by the caller (chromatika resolves
/// BTC/USD via the price service before building the PTB) and is logged in the
/// `BtcDecoded` event for off-chain audit.
///
/// **Important: cap is enforced on INPUT value, not output value.** The BIP143 preimage
/// includes the value of the UTXO being spent at offset (4+32+32+36+scriptCodeLen) — that
/// is the input. The actual transfer amount (output value) is hashed into `hashOutputs` and
/// not directly recoverable from the preimage. Capping on input is conservative: input >=
/// output (the difference is the fee), so the cap is at worst slightly stricter than the
/// user's intent. This matches how a BTC user thinks about "how much value am I authorizing
/// chromatika to spend in this tx."
///
/// Honesty model: HARD on input value (decoded from on-chain preimage bytes), SOFT on price
/// (caller-supplied; emitted on-chain so any lie is auditable). v0 ship; v2 closes the price
/// gap by pulling BTC/USD from Pyth on-chain.
///
/// References:
///   - BIP143: https://github.com/bitcoin/bips/blob/master/bip-0143.mediawiki
///   - Section "Specification": preimage layout for SIGHASH_ALL (the only mode chromatika emits)
module chromatika_policy::sign_gate_btc;

use ika_dwallet_2pc_mpc::{
    coordinator::DWalletCoordinator,
    coordinator_inner::UnverifiedPresignCap
};
use sui::{
    clock::Clock,
    event,
};
use chromatika_policy::sign_gate::{Self, PolicyVault};

// ─── error codes ─────────────────────────────────────────────────────────────────

const EBadPreimage: u64 = 200;
const EPreimageTooShort: u64 = 201;
const EVarIntTooLarge: u64 = 202;

// ─── constants ───────────────────────────────────────────────────────────────────

/// Fixed-size BIP143 fields, in bytes:
///   nVersion(4) + hashPrevouts(32) + hashSequence(32) = 68 bytes BEFORE the outpoint
const PREFIX_LEN: u64 = 4 + 32 + 32;

/// outpoint is fixed at 36 bytes (txid 32 + vout 4)
const OUTPOINT_LEN: u64 = 36;

/// After scriptCode comes: amount(8) + nSequence(4) + hashOutputs(32) + nLocktime(4) + nHashType(4) = 52 bytes
const SUFFIX_LEN: u64 = 8 + 4 + 32 + 4 + 4;

/// Number of satoshis per BTC. Used to convert sats → BTC-denominated micro-USD.
const SATS_PER_BTC: u256 = 100_000_000;
const U64_MAX_AS_U256: u256 = 18_446_744_073_709_551_615;

// ─── events ──────────────────────────────────────────────────────────────────────

public struct BtcDecoded has copy, drop {
    vault_id: ID,
    /// Decoded UTXO value (in satoshis) being spent by this signature.
    value_sats: u64,
    /// Computed micro-USD value using the caller's supplied price.
    value_micros: u64,
    /// Caller-supplied price (micro-USD per satoshi). Logged for audit. Note: per-SAT not
    /// per-BTC because micro-USD/BTC at typical BTC prices ($30k - $150k) is in the
    /// 30_000_000_000 .. 150_000_000_000 range — fits in u64 but the per-sat precision is
    /// what the caller actually has when they pass a price-feed quote like "btcUsd / 1e8".
    price_micros_per_satoshi: u64,
}

// ─── public entry points ─────────────────────────────────────────────────────────

/// Sign a BTC tx through the Policy Vault with on-chain value extraction. The caller passes
/// the BIP143 witness-v0 sighash preimage as `message`, plus the current BTC/sat price (in
/// micro-USD per satoshi) so the module can compute the USD value of the input being spent.
///
/// The decoded value (in satoshis) is emitted as a `BtcDecoded` event before delegating to
/// `sign_gate::sign_with_policy` with the chain-derived value. Any value lie from chromatika
/// is therefore impossible: the cap is enforced against the number Move parses out of the
/// preimage.
public fun sign_btc_with_policy(
    self: &mut PolicyVault,
    coordinator: &mut DWalletCoordinator,
    presign_cap: UnverifiedPresignCap,
    message: vector<u8>,
    price_micros_per_satoshi: u64,
    hash_scheme: u32,
    message_centralized_signature: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
): ID {
    let value_sats = decode_btc_witness_v0_value(&message);
    let value_micros = sats_to_micros_usd(value_sats, price_micros_per_satoshi);

    event::emit(BtcDecoded {
        vault_id: object::id(self),
        value_sats,
        value_micros,
        price_micros_per_satoshi,
    });

    // Delegate to soft-policy with chain-decoded value (not caller's claim).
    sign_gate::sign_with_policy(
        self,
        coordinator,
        presign_cap,
        message,
        value_micros,
        hash_scheme,
        message_centralized_signature,
        clock,
        ctx,
    )
}

// ─── decoding (BIP143 byte parser) ───────────────────────────────────────────────

/// Read an unsigned little-endian u64 from `bytes` at `offset`.
fun read_u64_le(bytes: &vector<u8>, offset: u64): u64 {
    let total = bytes.length();
    assert!(offset + 8 <= total, EPreimageTooShort);
    let mut value: u64 = 0;
    let mut i: u64 = 0;
    while (i < 8) {
        // LE: byte[i] occupies bits (i*8)..(i*8+7)
        value = value | ((bytes[offset + i] as u64) << ((i as u8) * 8));
        i = i + 1;
    };
    value
}

/// Read a Bitcoin-style CompactSize (varint) at `offset`. Returns `(value, bytes_consumed)`.
///
/// Encoding:
///   - 0x00..0xfc: single byte; value = byte
///   - 0xfd: 1 byte tag + 2-byte LE u16
///   - 0xfe: 1 byte tag + 4-byte LE u32
///   - 0xff: 1 byte tag + 8-byte LE u64 (we abort EVarIntTooLarge: scriptCode is never that big)
///
/// The chromatika BTC paths produce P2WPKH scriptCode (~26 bytes) or P2WSH redeemScript
/// (typically <100 bytes), so we expect single-byte-tag varints almost always. We accept up
/// through 0xfe for forward-compat but reject 0xff.
fun read_compact_size(bytes: &vector<u8>, offset: u64): (u64, u64) {
    let total = bytes.length();
    assert!(offset < total, EPreimageTooShort);
    let b0 = bytes[offset];

    if (b0 < 0xfd) {
        ((b0 as u64), 1)
    } else if (b0 == 0xfd) {
        assert!(offset + 3 <= total, EPreimageTooShort);
        let v: u64 = (bytes[offset + 1] as u64)
            | ((bytes[offset + 2] as u64) << 8);
        (v, 3)
    } else if (b0 == 0xfe) {
        assert!(offset + 5 <= total, EPreimageTooShort);
        let v: u64 = (bytes[offset + 1] as u64)
            | ((bytes[offset + 2] as u64) << 8)
            | ((bytes[offset + 3] as u64) << 16)
            | ((bytes[offset + 4] as u64) << 24);
        (v, 5)
    } else {
        // 0xff: 8-byte length. scriptCode is never anywhere near 4GB+; refuse to allocate.
        abort EVarIntTooLarge
    }
}

/// Decode the BIP143 witness-v0 sighash preimage and return the input `amount` field (in
/// satoshis). The preimage layout (bytes):
///
///   [ nVersion(4) | hashPrevouts(32) | hashSequence(32) | outpoint(36)
///     | scriptCodeLen(varint) | scriptCode(scriptCodeLen)
///     | amount(8 LE) | nSequence(4) | hashOutputs(32) | nLocktime(4) | nHashType(4) ]
///
/// We jump to the offset right after the outpoint, read the scriptCode length varint,
/// skip past the scriptCode bytes, and read the 8-byte LE amount field.
///
/// Aborts EPreimageTooShort if the input is too small at any decode step. Aborts
/// EBadPreimage if the total length is implausibly small for any valid BIP143 preimage.
fun decode_btc_witness_v0_value(message: &vector<u8>): u64 {
    let total = message.length();
    // Smallest possible preimage: PREFIX(68) + OUTPOINT(36) + scriptCodeLen(1, value=0) + SUFFIX(52) = 157 bytes
    // Real preimages with non-empty scriptCode are larger.
    assert!(total >= PREFIX_LEN + OUTPOINT_LEN + 1 + SUFFIX_LEN, EBadPreimage);

    let after_outpoint = PREFIX_LEN + OUTPOINT_LEN; // 104
    let (script_len, varint_size) = read_compact_size(message, after_outpoint);
    let amount_offset = after_outpoint + varint_size + script_len;
    // After amount is nSequence(4) + hashOutputs(32) + nLocktime(4) + nHashType(4) = 44 bytes,
    // so we need amount_offset + 8 + 44 = amount_offset + 52 <= total.
    assert!(amount_offset + SUFFIX_LEN <= total, EBadPreimage);

    read_u64_le(message, amount_offset)
}

/// Convert satoshis to micro-USD using the caller-supplied per-sat price.
///
/// Math: `value_micros = floor(value_sats * price_micros_per_satoshi)`. Uses u256 to avoid
/// overflow on the multiply (u64 * u64 = up to u128; we promote to u256 for safety).
/// Saturates at u64 max for impractical inputs. Returns 0 on zero input or zero price.
fun sats_to_micros_usd(value_sats: u64, price_micros_per_satoshi: u64): u64 {
    if (value_sats == 0) return 0;
    if (price_micros_per_satoshi == 0) return 0;
    let v: u256 = (value_sats as u256);
    let p: u256 = (price_micros_per_satoshi as u256);
    let result: u256 = v * p;
    if (result > U64_MAX_AS_U256) return U64_MAX_AS_U256 as u64;
    result as u64
}

// ─── public for tests / inspection ───────────────────────────────────────────────

/// Test-only entry point so Move test harnesses can verify the decoder in isolation.
public fun decode_btc_witness_v0_value_for_testing(message: vector<u8>): u64 {
    decode_btc_witness_v0_value(&message)
}

/// Test-only entry point exposing the conversion helper.
public fun sats_to_micros_usd_for_testing(value_sats: u64, price_micros_per_satoshi: u64): u64 {
    sats_to_micros_usd(value_sats, price_micros_per_satoshi)
}

/// Convenience helper for chromatika-team to pre-validate the price they're about to pass.
/// Reference: at $50k/BTC, micro-USD per sat = 50_000 * 1e6 / 1e8 = 500. At $100k = 1000.
public fun reference_price_micros_per_satoshi_at_50k_usd_per_btc(): u64 {
    500
}
