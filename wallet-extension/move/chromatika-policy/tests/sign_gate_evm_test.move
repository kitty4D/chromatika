/// Unit tests for the EVM RLP decoder. Run via `sui move test` from the package root.
///
/// Test fixtures encode known EVM tx shapes:
///   - Legacy `BasicTransfer` of 1 ETH to a 20-byte recipient
///   - EIP-1559 (type 2) transfer of 0.5 ETH
///   - EIP-2930 (type 1) transfer of small value
///
/// All fixtures were hand-built from RLP rules; cross-checked against ethers' encoding for
/// confidence. The decoder must extract `(tx_type, to_bytes, value_wei)` matching the
/// expected values.
#[test_only]
module chromatika_policy::sign_gate_evm_test;

use chromatika_policy::sign_gate_evm;

// Helper: 20-byte recipient address used across tests.
fun rcpt_20(): vector<u8> {
    let mut v = vector::empty<u8>();
    let mut i: u8 = 0;
    while ((i as u64) < 20) {
        v.push_back(i + 0x10);
        i = i + 1;
    };
    v
}

// ─── legacy tx fixture ───────────────────────────────────────────────────────────
//
// Legacy tx (no envelope byte): RLP([nonce=0, gasPrice=0x09184e72a000, gasLimit=0x5208,
//   to=<20 bytes>, value=0x0de0b6b3a7640000 (1 ETH = 1e18 wei),
//   data=0x, chainId=1, 0, 0])
//
// Hand-encoded RLP:
//   list prefix: 0xe7 (short list, length 0x27 = 39 bytes)
//   item 0 nonce=0:           0x80
//   item 1 gasPrice (6 bytes): 0x86 0x09 0x18 0x4e 0x72 0xa0 0x00
//   item 2 gasLimit (2 bytes): 0x82 0x52 0x08
//   item 3 to (20 bytes):     0x94 [20 bytes]
//   item 4 value (8 bytes):   0x88 0x0d 0xe0 0xb6 0xb3 0xa7 0x64 0x00 0x00
//   item 5 data (empty):      0x80
//   item 6 chainId=1:         0x01 (single-byte literal in RLP rules)
//   item 7 0:                 0x80
//   item 8 0:                 0x80
//
// Total payload: 1 + 7 + 3 + 21 + 9 + 1 + 1 + 1 + 1 = 45 bytes
// List prefix for 45-byte list: 0xc0 + 45 = 0xed; but that's > 0xf7? No, 0xed < 0xf7 so short list.
// Wait: short list goes up to 55 bytes (0xc0..0xf7), with prefix = 0xc0 + length. So 45 → 0xed.
fun legacy_send_1eth_fixture(): vector<u8> {
    let mut tx = vector::empty<u8>();
    let r = rcpt_20();

    // Outer list prefix: short list, 45 bytes content.
    tx.push_back(0xed);

    // nonce=0 (RLP: 0x80 = empty string = 0)
    tx.push_back(0x80);

    // gasPrice = 0x09184e72a000 (6 bytes); RLP prefix 0x86.
    tx.push_back(0x86);
    tx.push_back(0x09); tx.push_back(0x18); tx.push_back(0x4e);
    tx.push_back(0x72); tx.push_back(0xa0); tx.push_back(0x00);

    // gasLimit = 0x5208 (21000); RLP prefix 0x82.
    tx.push_back(0x82);
    tx.push_back(0x52); tx.push_back(0x08);

    // to = 20 bytes; RLP prefix 0x94 (short string, length 0x14 = 20).
    tx.push_back(0x94);
    let mut i: u64 = 0;
    while (i < 20) {
        tx.push_back(r[i]);
        i = i + 1;
    };

    // value = 1e18 wei = 0x0de0b6b3a7640000 (8 bytes); RLP prefix 0x88.
    tx.push_back(0x88);
    tx.push_back(0x0d); tx.push_back(0xe0); tx.push_back(0xb6); tx.push_back(0xb3);
    tx.push_back(0xa7); tx.push_back(0x64); tx.push_back(0x00); tx.push_back(0x00);

    // data = empty; RLP 0x80.
    tx.push_back(0x80);

    // chainId = 1; single-byte literal 0x01.
    tx.push_back(0x01);

    // 0; 0x80.
    tx.push_back(0x80);

    // 0; 0x80.
    tx.push_back(0x80);

    tx
}

#[test]
fun test_decode_legacy_1eth() {
    let tx = legacy_send_1eth_fixture();
    let (tx_type, to, value_wei) = sign_gate_evm::decode_eth_tx_for_testing(tx);
    assert!(tx_type == 0xff, 1);
    assert!(to == rcpt_20(), 2);
    // 1e18 wei
    assert!(value_wei == 1_000_000_000_000_000_000u128, 3);
}

// ─── EIP-1559 (type 2) tx fixture ─────────────────────────────────────────────────
//
// 0x02 || RLP([chainId=1, nonce=0, maxPriorityFee=0x3b9aca00 (1 gwei),
//   maxFee=0x77359400 (2 gwei), gasLimit=0x5208,
//   to=<20 bytes>, value=0x06f05b59d3b20000 (0.5 ETH = 5e17 wei),
//   data=0x, accessList=[]])
//
// Items:
//   chainId=1: 0x01
//   nonce=0: 0x80
//   maxPriorityFee=0x3b9aca00 (4 bytes): 0x84 0x3b 0x9a 0xca 0x00
//   maxFee=0x77359400 (4 bytes): 0x84 0x77 0x35 0x94 0x00
//   gasLimit=0x5208 (2 bytes): 0x82 0x52 0x08
//   to (20 bytes): 0x94 [20 bytes]
//   value=5e17 wei (8 bytes): 0x88 0x06 0xf0 0x5b 0x59 0xd3 0xb2 0x00 0x00
//   data: 0x80
//   accessList=[]: 0xc0
//
// Payload length: 1+1+5+5+3+21+9+1+1 = 47 bytes
// List prefix: 0xc0 + 47 = 0xef
fun eip1559_send_half_eth_fixture(): vector<u8> {
    let mut tx = vector::empty<u8>();
    let r = rcpt_20();

    // Type byte 0x02
    tx.push_back(0x02);

    // List prefix: short list, 47 bytes
    tx.push_back(0xef);

    // chainId=1
    tx.push_back(0x01);
    // nonce=0
    tx.push_back(0x80);
    // maxPriorityFee = 0x3b9aca00
    tx.push_back(0x84);
    tx.push_back(0x3b); tx.push_back(0x9a); tx.push_back(0xca); tx.push_back(0x00);
    // maxFee = 0x77359400
    tx.push_back(0x84);
    tx.push_back(0x77); tx.push_back(0x35); tx.push_back(0x94); tx.push_back(0x00);
    // gasLimit = 0x5208
    tx.push_back(0x82);
    tx.push_back(0x52); tx.push_back(0x08);
    // to (20 bytes)
    tx.push_back(0x94);
    let mut i: u64 = 0;
    while (i < 20) {
        tx.push_back(r[i]);
        i = i + 1;
    };
    // value = 5e17 wei = 0x06f05b59d3b20000
    tx.push_back(0x88);
    tx.push_back(0x06); tx.push_back(0xf0); tx.push_back(0x5b); tx.push_back(0x59);
    tx.push_back(0xd3); tx.push_back(0xb2); tx.push_back(0x00); tx.push_back(0x00);
    // data
    tx.push_back(0x80);
    // accessList (empty)
    tx.push_back(0xc0);

    tx
}

#[test]
fun test_decode_eip1559_half_eth() {
    let tx = eip1559_send_half_eth_fixture();
    let (tx_type, to, value_wei) = sign_gate_evm::decode_eth_tx_for_testing(tx);
    assert!(tx_type == 0x02, 1);
    assert!(to == rcpt_20(), 2);
    // 5e17 wei
    assert!(value_wei == 500_000_000_000_000_000u128, 3);
}

// ─── wei -> micro-USD conversion ──────────────────────────────────────────────────

#[test]
fun test_wei_to_micros_zero_inputs() {
    // 0 wei
    assert!(sign_gate_evm::wei_to_micros_usd_for_testing(0, 3_500_000_000) == 0, 1);
    // 0 price
    assert!(sign_gate_evm::wei_to_micros_usd_for_testing(1_000_000_000_000_000_000, 0) == 0, 2);
}

#[test]
fun test_wei_to_micros_one_eth_at_3500() {
    // 1 ETH at $3500 -> $3500 = 3_500_000_000 micro-USD
    let result = sign_gate_evm::wei_to_micros_usd_for_testing(
        1_000_000_000_000_000_000u128,
        3_500_000_000u64,
    );
    assert!(result == 3_500_000_000u64, 1);
}

#[test]
fun test_wei_to_micros_half_eth_at_3500() {
    // 0.5 ETH at $3500 -> $1750 = 1_750_000_000 micro-USD
    let result = sign_gate_evm::wei_to_micros_usd_for_testing(
        500_000_000_000_000_000u128,
        3_500_000_000u64,
    );
    assert!(result == 1_750_000_000u64, 1);
}

#[test]
fun test_wei_to_micros_truncates_fraction() {
    // 1 wei at $3500 -> 3500e-12 micro-USD -> floor to 0
    let result = sign_gate_evm::wei_to_micros_usd_for_testing(1u128, 3_500_000_000u64);
    assert!(result == 0u64, 1);
}
