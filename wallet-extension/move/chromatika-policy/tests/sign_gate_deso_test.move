/// Unit tests for the DeSo v0 binary tx decoder.
/// Run via `sui move test` from the package root.
///
/// Test fixtures hand-build DeSo v0 transactions matching the layout from the deso-js
/// transaction-transcoders.ts spec. The decoder needs only the TxInputs + TxOutputs
/// prefix, so fixtures stop at the first byte AFTER the outputs (no need to construct
/// metadata / pubkey / extra / signature for the parser tests).
#[test_only]
module chromatika_policy::sign_gate_deso_test;

use chromatika_policy::sign_gate_deso;

// ─── helpers ─────────────────────────────────────────────────────────────────────

fun push_zeros(out: &mut vector<u8>, count: u64) {
    let mut i: u64 = 0;
    while (i < count) {
        out.push_back(0u8);
        i = i + 1;
    };
}

/// Push a Go-style uvarint encoding of `value` into `out`.
fun push_uvarint(out: &mut vector<u8>, value: u64) {
    let mut v = value;
    loop {
        if (v < 0x80) {
            out.push_back((v & 0xff) as u8);
            break
        };
        out.push_back((((v & 0x7f) | 0x80) & 0xff) as u8);
        v = v >> 7;
    };
}

/// Build a v0 tx fixture with `n_inputs` zero-pad inputs (each TxID 32 zeros + index 0)
/// and a list of output amounts. Pads tail with the minimum valid metadata + pubkey +
/// extradata + signature placeholder (`02 00 00 00 00` = type=2 BasicTransfer, size=0,
/// pubkey-len=0, extra-len=0, sig-len=0). The decoder doesn't read tail; the padding is
/// for completeness so a future signer-side roundtrip test can use the same fixtures.
fun build_v0_fixture(n_inputs: u64, output_amounts: vector<u64>): vector<u8> {
    let mut tx = vector::empty<u8>();
    // Input count
    push_uvarint(&mut tx, n_inputs);
    let mut i: u64 = 0;
    while (i < n_inputs) {
        // TxID[32] zeroed
        push_zeros(&mut tx, 32);
        // Index varint = 0 → single 0x00 byte
        push_uvarint(&mut tx, 0);
        i = i + 1;
    };
    // Output count
    let n_out = output_amounts.length();
    push_uvarint(&mut tx, n_out);
    let mut k: u64 = 0;
    while (k < n_out) {
        // PublicKey[33] zeroed (placeholder)
        push_zeros(&mut tx, 33);
        // AmountNanos varint
        push_uvarint(&mut tx, output_amounts[k]);
        k = k + 1;
    };
    // Tail: BasicTransfer meta + empty pubkey/extra/sig (so the fixture is parseable end-to-end)
    tx.push_back(0x02); // metadata type = 2 (BasicTransfer enum value)
    tx.push_back(0x00); // metadata size = 0
    tx.push_back(0x00); // public key length = 0 (varint 0)
    tx.push_back(0x00); // extra data length = 0
    tx.push_back(0x00); // signature length = 0 (placeholder pre-sign)
    tx
}

// ─── tests ───────────────────────────────────────────────────────────────────────

#[test]
fun test_decode_basic_send_one_input_one_output() {
    // 1 input → 1 output of 1 DESO (1e9 nanos)
    let mut amounts = vector::empty<u64>();
    amounts.push_back(1_000_000_000);
    let tx = build_v0_fixture(1, amounts);
    let (sum, largest, count) = sign_gate_deso::decode_deso_v0_outputs_for_testing(tx);
    assert!(sum == 1_000_000_000, 1);
    assert!(largest == 1_000_000_000, 2);
    assert!(count == 1, 3);
}

#[test]
fun test_decode_typical_send_with_change() {
    // 1 input → 2 outputs (recipient 1 DESO + change 0.5 DESO)
    let mut amounts = vector::empty<u64>();
    amounts.push_back(1_000_000_000);
    amounts.push_back(500_000_000);
    let tx = build_v0_fixture(1, amounts);
    let (sum, largest, count) = sign_gate_deso::decode_deso_v0_outputs_for_testing(tx);
    assert!(sum == 1_500_000_000, 4);
    assert!(largest == 1_000_000_000, 5);
    assert!(count == 2, 6);
}

#[test]
fun test_decode_multi_input_aggregated() {
    // 3 inputs (UTXO consolidation) → 1 output of 5 DESO
    let mut amounts = vector::empty<u64>();
    amounts.push_back(5_000_000_000);
    let tx = build_v0_fixture(3, amounts);
    let (sum, largest, count) = sign_gate_deso::decode_deso_v0_outputs_for_testing(tx);
    assert!(sum == 5_000_000_000, 7);
    assert!(largest == 5_000_000_000, 8);
    assert!(count == 1, 9);
}

#[test]
fun test_decode_zero_inputs_zero_outputs() {
    let amounts = vector::empty<u64>();
    let tx = build_v0_fixture(0, amounts);
    let (sum, largest, count) = sign_gate_deso::decode_deso_v0_outputs_for_testing(tx);
    assert!(sum == 0, 10);
    assert!(largest == 0, 11);
    assert!(count == 0, 12);
}

#[test]
fun test_decode_dust_amounts() {
    // 2 outputs of 1 nano each
    let mut amounts = vector::empty<u64>();
    amounts.push_back(1);
    amounts.push_back(1);
    let tx = build_v0_fixture(1, amounts);
    let (sum, largest, count) = sign_gate_deso::decode_deso_v0_outputs_for_testing(tx);
    assert!(sum == 2, 13);
    assert!(largest == 1, 14);
    assert!(count == 2, 15);
}

#[test]
fun test_decode_large_amount_multibyte_varint() {
    // 100 DESO = 100_000_000_000 nanos. Encodes as a 6-byte varint.
    let mut amounts = vector::empty<u64>();
    amounts.push_back(100_000_000_000);
    let tx = build_v0_fixture(1, amounts);
    let (sum, _, _) = sign_gate_deso::decode_deso_v0_outputs_for_testing(tx);
    assert!(sum == 100_000_000_000, 16);
}

#[test]
fun test_decode_max_u64_amount() {
    // 10 outputs each at u64 max → sum saturates at u64 max
    let max_u64: u64 = 18_446_744_073_709_551_615;
    let mut amounts = vector::empty<u64>();
    let mut i: u64 = 0;
    while (i < 10) {
        amounts.push_back(max_u64);
        i = i + 1;
    };
    let tx = build_v0_fixture(1, amounts);
    let (sum, largest, count) = sign_gate_deso::decode_deso_v0_outputs_for_testing(tx);
    assert!(sum == max_u64, 17); // saturated
    assert!(largest == max_u64, 18);
    assert!(count == 10, 19);
}

#[test]
#[expected_failure(abort_code = 301, location = chromatika_policy::sign_gate_deso)]
fun test_decode_truncated_inputs_aborts() {
    // Build: claims 1 input but provides only the count varint + 10 zero bytes (need 32 + idx)
    let mut tx = vector::empty<u8>();
    tx.push_back(0x01); // 1 input
    push_zeros(&mut tx, 10);
    sign_gate_deso::decode_deso_v0_outputs_for_testing(tx);
}

#[test]
#[expected_failure(abort_code = 300, location = chromatika_policy::sign_gate_deso)]
fun test_decode_too_small_aborts() {
    let mut tx = vector::empty<u8>();
    tx.push_back(0x00); // 1 byte; need ≥7
    sign_gate_deso::decode_deso_v0_outputs_for_testing(tx);
}

// ─── price conversion tests ──────────────────────────────────────────────────────

#[test]
fun test_nanos_to_micros_at_30_usd_per_deso() {
    // 1 DESO at $30 = 30_000_000 micro-USD
    let micros = sign_gate_deso::nanos_to_micros_usd_for_testing(1_000_000_000, 30_000_000);
    assert!(micros == 30_000_000, 20);
}

#[test]
fun test_nanos_to_micros_at_50_usd_per_deso() {
    // 0.5 DESO at $50 = $25 = 25_000_000 micro-USD
    let micros = sign_gate_deso::nanos_to_micros_usd_for_testing(500_000_000, 50_000_000);
    assert!(micros == 25_000_000, 21);
}

#[test]
fun test_nanos_to_micros_dust() {
    // 1 nano at $30/DESO = 30_000_000 / 1e9 = 0.03 micro-USD = 0 (floor)
    let micros = sign_gate_deso::nanos_to_micros_usd_for_testing(1, 30_000_000);
    assert!(micros == 0, 22);
}

#[test]
fun test_nanos_to_micros_zero_inputs() {
    let zero1 = sign_gate_deso::nanos_to_micros_usd_for_testing(0, 30_000_000);
    let zero2 = sign_gate_deso::nanos_to_micros_usd_for_testing(1_000_000_000, 0);
    assert!(zero1 == 0, 23);
    assert!(zero2 == 0, 24);
}

#[test]
fun test_nanos_to_micros_saturates() {
    let max_u64: u64 = 18_446_744_073_709_551_615;
    let micros = sign_gate_deso::nanos_to_micros_usd_for_testing(max_u64, max_u64);
    assert!(micros == max_u64, 25);
}
