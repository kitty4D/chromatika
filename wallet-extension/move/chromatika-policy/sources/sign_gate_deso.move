/// chromatika_policy::sign_gate_deso
///
/// Hard-policy variant of `sign_gate` for DeSo transactions. Decodes the v0 DeSo binary
/// transaction layout on-chain in Move, summing output `AmountNanos` to determine the value
/// being authorized. Replaces the soft-policy `declared_value_micros` arg with a chain-derived
/// value. Lying caller can no longer bypass the cap; the chain enforces.
///
/// v1 scope: DeSo v0 transactions (no v1 ExtraData splice). Covers `BasicTransfer` (the only
/// txn-type chromatika emits today via `/api/v0/send-deso`). Other v0 txn types (SubmitPost,
/// Like, Follow, etc.) decode the same way for the value field — their TxnMeta layout differs
/// but the TxOutputs section we cap on is identical.
///
/// Architecture: this module wraps the `sign_gate::PolicyVault` shared object (caller passes
/// `&mut PolicyVault` + the same `presign_cap` as soft-policy `sign_with_policy`). It swaps
/// the soft-policy `declared_value_micros` for an on-chain `(decoded_value_nanos *
/// price_micros_per_nano)` call. The price is supplied by the caller (chromatika resolves
/// DESO/USD via the price service before building the PTB) and is logged in the
/// `DeSoDecoded` event for off-chain audit.
///
/// **Cap is enforced on the SUM of TxOutputs (= input value - fee).** This includes any
/// change output going back to the sender. For typical 2-output txs (recipient + change),
/// the cap is at worst slightly over-conservative — it counts the user's own change against
/// their daily ceiling. Trade-off is "safe and simple" vs "perfectly precise but parses
/// PublicKey identity too." Chromatika's send flow specifies a single AmountNanos per send,
/// so the over-count typically equals the sender's full balance minus their send amount —
/// which is fine because the cap is denominated in dollars / day and most users won't
/// exceed it from changes alone. The `largest_output_nanos` field on the event lets
/// off-chain auditors reconstruct the "real" send amount when needed.
///
/// Honesty model: HARD on output sum (decoded from on-chain bytes), SOFT on price
/// (caller-supplied; emitted on-chain so any lie is auditable). Hackathon ship; v2 closes
/// the price gap.
///
/// References:
///   - DeSo v0 layout (deso-protocol/deso-js transaction-transcoders.ts):
///       Inputs(varint-count + N×(TxID[32] + uvarint(Index)))
///       Outputs(varint-count + N×(PublicKey[33] + uvarint(AmountNanos)))
///       Metadata: uvarint(type) + uvarint(size) + metaBytes
///       PublicKey: VarBuffer (uvarint-len + bytes)
///       ExtraData: VarBuffer (uvarint-len + bytes)
///       Signature: VarBuffer (uvarint-len + bytes; usually `00` placeholder pre-sign)
///   - chromatika docs/DESO_SPIKE.md "Sign-bytes derivation" matches.
module chromatika_policy::sign_gate_deso;

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

const EBadTxn: u64 = 300;
const ETxnTooShort: u64 = 301;
const EVarIntTooLarge: u64 = 302;

// ─── constants ───────────────────────────────────────────────────────────────────

/// Fixed-size DeSo TxInput fields: TxID(32) + uvarint(Index, up to 10 bytes max).
const INPUT_TXID_LEN: u64 = 32;

/// Fixed-size DeSo TxOutput PublicKey: compressed secp256k1, always 33 bytes.
const OUTPUT_PUBKEY_LEN: u64 = 33;

/// 1 DESO = 10^9 nanos. Used to convert nanos → DESO-denominated micro-USD.
const NANOS_PER_DESO: u256 = 1_000_000_000;
const U64_MAX_AS_U256: u256 = 18_446_744_073_709_551_615;

// ─── events ──────────────────────────────────────────────────────────────────────

public struct DeSoDecoded has copy, drop {
    vault_id: ID,
    /// Sum of all TxOutputs.AmountNanos. Cap is enforced on this value.
    output_sum_nanos: u64,
    /// Largest single TxOutput.AmountNanos. Off-chain auditors can subtract this from
    /// `output_sum_nanos` to recover the change going back to the sender (assuming the
    /// recipient output is the largest, which is the typical case).
    largest_output_nanos: u64,
    /// Number of outputs in the tx. Useful audit signal: > 2 implies multi-recipient
    /// (split-send), v0 chromatika doesn't emit this today but the decoder doesn't reject
    /// it either.
    output_count: u64,
    /// Computed micro-USD value using the caller's supplied price.
    value_micros: u64,
    /// Caller-supplied price (micro-USD per nano). At $30/DESO = 30 * 1e6 / 1e9 = 0.03
    /// micro-USD/nano which rounds to 0; we can't represent sub-micro per nano. Caller
    /// passes a scaled-up integer: we expect it at micro-USD per BILLION nanos
    /// (= micro-USD per 1 DESO), and the math divides accordingly. Reference helper
    /// `reference_price_micros_per_nano_at_30_usd_per_deso` returns the right shape.
    price_micros_per_deso: u64,
}

// ─── public entry points ─────────────────────────────────────────────────────────

/// Sign a DeSo tx through the Policy Vault with on-chain output-sum extraction. Caller
/// passes the unsigned DeSo TransactionHex bytes (with trailing `00` signature placeholder)
/// as `message`, plus the current DESO/USD price in micro-USD per DESO. The module sums
/// outputs, computes USD value, and delegates to soft sign_with_policy with the chain
/// value (overriding caller's claim).
public fun sign_deso_with_policy(
    self: &mut PolicyVault,
    coordinator: &mut DWalletCoordinator,
    presign_cap: UnverifiedPresignCap,
    message: vector<u8>,
    price_micros_per_deso: u64,
    hash_scheme: u32,
    message_centralized_signature: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
): ID {
    let (output_sum_nanos, largest_output_nanos, output_count) = decode_deso_v0_outputs(&message);
    let value_micros = nanos_to_micros_usd(output_sum_nanos, price_micros_per_deso);

    event::emit(DeSoDecoded {
        vault_id: object::id(self),
        output_sum_nanos,
        largest_output_nanos,
        output_count,
        value_micros,
        price_micros_per_deso,
    });

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

// ─── decoding (DeSo v0 byte parser) ──────────────────────────────────────────────

/// Read a Go-style uvarint (LEB128-with-continuation-bit) at `offset`. Returns
/// `(value, bytes_consumed)`.
///
/// Encoding: each byte's low 7 bits contribute to the value; high bit (0x80) means "more
/// bytes follow." Aborts EVarIntTooLarge if the varint exceeds 10 bytes (max for u64).
///
/// This matches Go's `encoding/binary.Uvarint` and DeSo's `EncodeUvarint`.
fun read_uvarint(bytes: &vector<u8>, offset: u64): (u64, u64) {
    let total = bytes.length();
    let mut value: u64 = 0;
    let mut shift: u8 = 0;
    let mut i: u64 = 0;
    loop {
        assert!(offset + i < total, ETxnTooShort);
        assert!(i < 10, EVarIntTooLarge);
        let b = bytes[offset + i];
        let low7 = (b & 0x7f) as u64;
        value = value | (low7 << shift);
        i = i + 1;
        if (b < 0x80) break;
        shift = shift + 7;
    };
    (value, i)
}

/// Skip exactly one DeSo TxInput at `offset`. TxInput layout:
///   TxID[32] + uvarint(Index)
fun skip_tx_input(bytes: &vector<u8>, offset: u64): u64 {
    let total = bytes.length();
    assert!(offset + INPUT_TXID_LEN <= total, ETxnTooShort);
    let after_txid = offset + INPUT_TXID_LEN;
    let (_idx, idx_size) = read_uvarint(bytes, after_txid);
    after_txid + idx_size
}

/// Read a single DeSo TxOutput at `offset` and return `(amount_nanos, bytes_consumed)`.
/// TxOutput layout:
///   PublicKey[33] + uvarint(AmountNanos)
fun read_tx_output(bytes: &vector<u8>, offset: u64): (u64, u64) {
    let total = bytes.length();
    assert!(offset + OUTPUT_PUBKEY_LEN <= total, ETxnTooShort);
    let after_pubkey = offset + OUTPUT_PUBKEY_LEN;
    let (amount, amount_size) = read_uvarint(bytes, after_pubkey);
    (amount, OUTPUT_PUBKEY_LEN + amount_size)
}

/// Decode a DeSo v0 transaction's TxOutputs section and return:
///   - `output_sum_nanos`: SUM of all output AmountNanos (saturated at u64 max)
///   - `largest_output_nanos`: MAX of all output AmountNanos
///   - `output_count`: number of outputs
///
/// Walks the inputs (skipping each), then iterates outputs and accumulates.
///
/// Aborts EBadTxn / ETxnTooShort on truncated or malformed input.
fun decode_deso_v0_outputs(message: &vector<u8>): (u64, u64, u64) {
    let total = message.length();
    // Smallest valid v0 tx: empty inputs (varint 0 = 1 byte) + empty outputs (varint 0) +
    // empty meta (uvarint type=0 + uvarint size=0) + empty pubkey (1 byte) + empty extra
    // (1 byte) + empty signature placeholder (1 byte) = 7 bytes. Real txs are larger.
    assert!(total >= 7, EBadTxn);

    // Inputs: uvarint(count) + count × TxInput
    let (input_count, ic_size) = read_uvarint(message, 0);
    let mut cursor = ic_size;
    let mut k: u64 = 0;
    while (k < input_count) {
        cursor = skip_tx_input(message, cursor);
        k = k + 1;
    };

    // Outputs: uvarint(count) + count × TxOutput
    let (output_count, oc_size) = read_uvarint(message, cursor);
    cursor = cursor + oc_size;

    let mut sum: u256 = 0;
    let mut largest: u64 = 0;
    let mut j: u64 = 0;
    while (j < output_count) {
        let (amount, used) = read_tx_output(message, cursor);
        cursor = cursor + used;
        sum = sum + (amount as u256);
        if (amount > largest) largest = amount;
        j = j + 1;
    };

    let sum_u64: u64 = if (sum > U64_MAX_AS_U256) {
        U64_MAX_AS_U256 as u64
    } else {
        sum as u64
    };

    (sum_u64, largest, output_count)
}

/// Convert nanos to micro-USD using the caller-supplied per-DESO price.
///
/// Math: `value_micros = floor(value_nanos * price_micros_per_deso / 1e9)`.
/// Uses u256 to avoid overflow. Saturates at u64 max for impractical inputs.
fun nanos_to_micros_usd(value_nanos: u64, price_micros_per_deso: u64): u64 {
    if (value_nanos == 0) return 0;
    if (price_micros_per_deso == 0) return 0;
    let v: u256 = (value_nanos as u256);
    let p: u256 = (price_micros_per_deso as u256);
    let result: u256 = (v * p) / NANOS_PER_DESO;
    if (result > U64_MAX_AS_U256) return U64_MAX_AS_U256 as u64;
    result as u64
}

// ─── public for tests / inspection ───────────────────────────────────────────────

/// Test-only entry point so Move test harnesses can verify the decoder in isolation.
public fun decode_deso_v0_outputs_for_testing(message: vector<u8>): (u64, u64, u64) {
    decode_deso_v0_outputs(&message)
}

/// Test-only entry point exposing the price helper.
public fun nanos_to_micros_usd_for_testing(value_nanos: u64, price_micros_per_deso: u64): u64 {
    nanos_to_micros_usd(value_nanos, price_micros_per_deso)
}

/// Convenience reference: at $30/DESO, micro-USD per DESO = 30 * 1e6 = 30_000_000.
/// Caller passes this as `price_micros_per_deso`.
public fun reference_price_micros_per_deso_at_30_usd(): u64 {
    30_000_000
}
