/// Unit tests for the BTC BIP143 witness-v0 sighash preimage decoder.
/// Run via `sui move test` from the package root.
///
/// Test fixtures hand-build BIP143 preimages with known `amount` values, plus a couple
/// of edge cases (varint > single-byte, zero amount, max amount). All preimages are
/// constructed bottom-up from the BIP143 spec rather than captured from a real tx, so the
/// test is self-contained (no external bitcoinjs / signer dependency).
#[test_only]
module chromatika_policy::sign_gate_btc_test;

use chromatika_policy::sign_gate_btc;

// ─── helpers ─────────────────────────────────────────────────────────────────────

/// Push `count` zero bytes into `out`.
fun push_zeros(out: &mut vector<u8>, count: u64) {
    let mut i: u64 = 0;
    while (i < count) {
        out.push_back(0u8);
        i = i + 1;
    };
}

/// Push the 8-byte little-endian encoding of `value` into `out`.
fun push_u64_le(out: &mut vector<u8>, value: u64) {
    let mut i: u64 = 0;
    while (i < 8) {
        let shift: u8 = (i as u8) * 8;
        let b: u8 = ((value >> shift) & 0xff) as u8;
        out.push_back(b);
        i = i + 1;
    };
}

/// Build a BIP143 witness-v0 preimage with the given scriptCode length + amount.
/// All fixed-size fields (nVersion, hashPrevouts, hashSequence, outpoint, nSequence,
/// hashOutputs, nLocktime, nHashType) are filled with zeros — the decoder doesn't read
/// them; only the amount field at the right offset matters for the test.
///
/// scriptCodeLen MUST fit in a CompactSize. We support len in 0..0xfc (single-byte) and
/// 0xfd..0xffff (3-byte 0xfd-prefixed) for these tests.
fun build_preimage(script_len: u64, amount_sats: u64): vector<u8> {
    let mut p = vector::empty<u8>();
    // nVersion(4) + hashPrevouts(32) + hashSequence(32) = 68 bytes
    push_zeros(&mut p, 68);
    // outpoint(36)
    push_zeros(&mut p, 36);
    // scriptCodeLen as CompactSize varint
    if (script_len < 0xfd) {
        p.push_back((script_len as u8));
    } else {
        // 0xfd prefix + 2-byte LE u16
        p.push_back(0xfd);
        p.push_back((script_len & 0xff) as u8);
        p.push_back(((script_len >> 8) & 0xff) as u8);
    };
    // scriptCode bytes (zeroed)
    push_zeros(&mut p, script_len);
    // amount(8) LE
    push_u64_le(&mut p, amount_sats);
    // nSequence(4) + hashOutputs(32) + nLocktime(4) + nHashType(4) = 44 bytes
    push_zeros(&mut p, 44);
    p
}

// ─── tests ───────────────────────────────────────────────────────────────────────

#[test]
fun test_decode_p2wpkh_typical_amount() {
    // P2WPKH scriptCode is 26 bytes: OP_DUP OP_HASH160 0x14 <20-byte-pkh> OP_EQUALVERIFY OP_CHECKSIG
    let preimage = build_preimage(26, 100_000_000); // exactly 1 BTC
    let amount = sign_gate_btc::decode_btc_witness_v0_value_for_testing(preimage);
    assert!(amount == 100_000_000, 1);
}

#[test]
fun test_decode_zero_amount() {
    let preimage = build_preimage(26, 0);
    let amount = sign_gate_btc::decode_btc_witness_v0_value_for_testing(preimage);
    assert!(amount == 0, 2);
}

#[test]
fun test_decode_dust_amount() {
    // 546 sats (typical dust threshold for P2WPKH outputs)
    let preimage = build_preimage(26, 546);
    let amount = sign_gate_btc::decode_btc_witness_v0_value_for_testing(preimage);
    assert!(amount == 546, 3);
}

#[test]
fun test_decode_large_amount() {
    // 21 million BTC in sats — the entire supply. Won't fit in real txs but exercises
    // the u64-shaped read path.
    let preimage = build_preimage(26, 2_100_000_000_000_000);
    let amount = sign_gate_btc::decode_btc_witness_v0_value_for_testing(preimage);
    assert!(amount == 2_100_000_000_000_000, 4);
}

#[test]
fun test_decode_p2wsh_long_script_code() {
    // P2WSH redeemScript can be longer (e.g. 2-of-3 multisig is ~71 bytes). Use 100 bytes.
    let preimage = build_preimage(100, 50_000_000);
    let amount = sign_gate_btc::decode_btc_witness_v0_value_for_testing(preimage);
    assert!(amount == 50_000_000, 5);
}

#[test]
fun test_decode_three_byte_varint() {
    // scriptCode of 300 bytes triggers the 0xfd-prefixed varint encoding.
    let preimage = build_preimage(300, 12_345_678);
    let amount = sign_gate_btc::decode_btc_witness_v0_value_for_testing(preimage);
    assert!(amount == 12_345_678, 6);
}

#[test]
#[expected_failure(abort_code = 201, location = chromatika_policy::sign_gate_btc)]
fun test_decode_truncated_aborts() {
    // Build a truncated preimage: PREFIX + OUTPOINT only, no scriptCode + amount.
    let mut p = vector::empty<u8>();
    push_zeros(&mut p, 68 + 36); // 104 bytes; minimum valid is 157
    sign_gate_btc::decode_btc_witness_v0_value_for_testing(p);
}

#[test]
#[expected_failure(abort_code = 200, location = chromatika_policy::sign_gate_btc)]
fun test_decode_too_small_aborts() {
    // Build an obviously too-small preimage to hit the EBadPreimage early-exit.
    let mut p = vector::empty<u8>();
    push_zeros(&mut p, 50);
    sign_gate_btc::decode_btc_witness_v0_value_for_testing(p);
}

// ─── price conversion tests ──────────────────────────────────────────────────────

#[test]
fun test_sats_to_micros_at_50k_per_btc() {
    // At $50k/BTC: 1 sat = $0.0005 = 500 micro-USD
    // 1 BTC (1e8 sats) = 50_000_000_000 micro-USD ($50k)
    let micros = sign_gate_btc::sats_to_micros_usd_for_testing(100_000_000, 500);
    assert!(micros == 50_000_000_000, 10);
}

#[test]
fun test_sats_to_micros_at_100k_per_btc() {
    // At $100k/BTC: 1 sat = 1000 micro-USD; 0.5 BTC = $50k = 50_000_000_000 micros
    let micros = sign_gate_btc::sats_to_micros_usd_for_testing(50_000_000, 1000);
    assert!(micros == 50_000_000_000, 11);
}

#[test]
fun test_sats_to_micros_dust() {
    // 546 sats at $50k/BTC: 546 * 500 = 273_000 micro-USD = $0.273
    let micros = sign_gate_btc::sats_to_micros_usd_for_testing(546, 500);
    assert!(micros == 273_000, 12);
}

#[test]
fun test_sats_to_micros_zero_value() {
    let micros = sign_gate_btc::sats_to_micros_usd_for_testing(0, 500);
    assert!(micros == 0, 13);
}

#[test]
fun test_sats_to_micros_zero_price() {
    let micros = sign_gate_btc::sats_to_micros_usd_for_testing(100_000_000, 0);
    assert!(micros == 0, 14);
}

#[test]
fun test_sats_to_micros_saturates_on_overflow() {
    // u64 max sats * u64 max price would overflow u128 but fits in u256. The fn saturates.
    let max_u64: u64 = 18_446_744_073_709_551_615;
    let micros = sign_gate_btc::sats_to_micros_usd_for_testing(max_u64, max_u64);
    assert!(micros == max_u64, 15);
}
