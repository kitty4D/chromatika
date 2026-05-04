/// chromatika_policy::sign_gate_evm
///
/// Hard-policy variant of `sign_gate` for EVM transactions. Decodes the message bytes
/// (which for EVM is the RLP-encoded unsigned tx that gets KECCAK256-hashed once before
/// signing) on-chain in Move, extracting `to` + `value`. Replaces the soft-policy
/// `declared_value_micros` arg with values pulled directly from the message. Lying caller
/// can no longer bypass the cap; the chain enforces.
///
/// v1 scope: Legacy + EIP-1559 + EIP-2930 EVM tx shapes. EIP-4844 (blob) and EIP-7702 are
/// out of scope; calls to those abort `EUnsupportedTxType`.
///
/// Architecture: this module wraps the `sign_gate::PolicyVault` shared object (caller passes
/// `&mut PolicyVault` + the same `presign_cap` as soft-policy `sign_with_policy`). It swaps
/// the soft-policy `declared_value_micros` for an on-chain `(decoded_value_wei *
/// price_micros_per_eth / 1e18)` call. The price is supplied by the caller (chromatika
/// resolves ETH/USD via the price service before building the PTB) and is logged in the
/// `EvmDecoded` event for off-chain audit. v2 may push price resolution on-chain via Pyth.
///
/// Honesty model: HARD on value (decoded from on-chain bytes), SOFT on price (caller-supplied;
/// emitted on-chain so any lie is auditable). v0 ship; v2 closes the price gap.
///
/// References:
///   - Ethereum yellow paper appendix B (RLP)
///   - EIP-2718 (typed transactions): legacy = no prefix; type 1 = 0x01; type 2 = 0x02
///   - EIP-1559: tx fields are [chainId, nonce, maxPriorityFee, maxFee, gasLimit, to, value, data, accessList]
///   - EIP-2930: tx fields are [chainId, nonce, gasPrice, gasLimit, to, value, data, accessList]
///   - Legacy: tx fields are [nonce, gasPrice, gasLimit, to, value, data, chainId, 0, 0]
module chromatika_policy::sign_gate_evm;

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

const EBadRlpPrefix: u64 = 100;
const EUnsupportedTxType: u64 = 101;
const ETxTooShort: u64 = 102;
const EValueOverflow: u64 = 103;
const ENotAList: u64 = 104;

// EIP-2718 type bytes
const TX_TYPE_LEGACY: u8 = 0xff; // sentinel: "no leading type byte"
const TX_TYPE_EIP1559: u8 = 0x02;
const TX_TYPE_EIP2930: u8 = 0x01;

// 1e18 wei per ETH; used to convert wei -> ETH-denominated micro-USD.
const WEI_PER_ETH: u256 = 1_000_000_000_000_000_000;
const U64_MAX_AS_U256: u256 = 18_446_744_073_709_551_615;

// ─── events ──────────────────────────────────────────────────────────────────────

public struct EvmDecoded has copy, drop {
    vault_id: ID,
    /// 0xff = legacy, 0x01 = EIP-2930, 0x02 = EIP-1559.
    tx_type: u8,
    /// Decoded `to` address bytes (20 bytes for normal sends, empty for contract-creation).
    to: vector<u8>,
    /// Decoded value field (wei) capped at u128 (2^128 wei is enough for ~3.4e20 USD even at
    /// extreme ETH prices; practical txs don't approach this).
    value_wei: u128,
    /// Computed micro-USD value using the caller's supplied price.
    value_micros: u64,
    /// Caller-supplied price (micro-USD per ETH). Logged for audit.
    price_micros_per_eth: u64,
}

// ─── public entry points ─────────────────────────────────────────────────────────

/// Sign an EVM tx through the Policy Vault with on-chain value extraction. The caller
/// passes the raw RLP-encoded tx as `message`, plus the current ETH/USD price (in
/// micro-USD per ETH) so the module can compute the USD value of the tx.
///
/// The decoded `to` field + value are emitted as an `EvmDecoded` event before delegating
/// to `sign_gate::sign_with_policy` with the chain-derived value (not the caller's claim).
/// Any value lie from chromatika is therefore impossible: the cap is enforced against the
/// number Move parses out of the bytes.
public fun sign_evm_with_policy(
    self: &mut PolicyVault,
    coordinator: &mut DWalletCoordinator,
    presign_cap: UnverifiedPresignCap,
    message: vector<u8>,
    price_micros_per_eth: u64,
    hash_scheme: u32,
    message_centralized_signature: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
): ID {
    let (tx_type, to, value_wei) = decode_eth_tx(&message);
    let value_micros = wei_to_micros_usd(value_wei, price_micros_per_eth);

    event::emit(EvmDecoded {
        vault_id: object::id(self),
        tx_type,
        to,
        value_wei,
        value_micros,
        price_micros_per_eth,
    });

    // Delegate to the soft-policy sign path with the chain-decoded value (not the caller's
    // claim). All other policy checks (panic, cool-down, actuator, presign pool) reuse the
    // same code path; we just substitute on-chain decoded value for declared value.
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

// ─── decoding (RLP byte parser) ──────────────────────────────────────────────────

/// Read the RLP item header at `offset`. Returns `(is_list, content_length, content_offset)`.
/// For single-byte literals (0x00..0x7f), `content_length = 1` and `content_offset = offset`
/// (the byte itself IS the content; caller must NOT skip a header byte).
fun read_rlp_header(bytes: &vector<u8>, offset: u64): (bool, u64, u64) {
    let total = bytes.length();
    assert!(offset < total, ETxTooShort);
    let b0 = bytes[offset];

    if (b0 < 0x80) {
        // Single-byte literal.
        (false, 1, offset)
    } else if (b0 < 0xb8) {
        // Short string of length (b0 - 0x80), 0..55 bytes.
        let len = (b0 as u64) - 0x80;
        (false, len, offset + 1)
    } else if (b0 < 0xc0) {
        // Long string: length-of-length is (b0 - 0xb7) bytes following, then content.
        let lol = (b0 as u64) - 0xb7;
        assert!(offset + 1 + lol <= total, ETxTooShort);
        let mut sz: u64 = 0;
        let mut i: u64 = 0;
        while (i < lol) {
            sz = (sz << 8) | (bytes[offset + 1 + i] as u64);
            i = i + 1;
        };
        (false, sz, offset + 1 + lol)
    } else if (b0 < 0xf8) {
        // Short list of total content length (b0 - 0xc0), 0..55 bytes.
        let len = (b0 as u64) - 0xc0;
        (true, len, offset + 1)
    } else {
        // Long list: length-of-length is (b0 - 0xf7) bytes following.
        let lol = (b0 as u64) - 0xf7;
        assert!(offset + 1 + lol <= total, ETxTooShort);
        let mut sz: u64 = 0;
        let mut i: u64 = 0;
        while (i < lol) {
            sz = (sz << 8) | (bytes[offset + 1 + i] as u64);
            i = i + 1;
        };
        (true, sz, offset + 1 + lol)
    }
}

/// Skip exactly one RLP item starting at `offset`, return offset of the next item.
/// Handles single-byte literals where content overlaps the "header" byte.
fun skip_rlp_item(bytes: &vector<u8>, offset: u64): u64 {
    let total = bytes.length();
    assert!(offset < total, ETxTooShort);
    let b0 = bytes[offset];
    if (b0 < 0x80) {
        // Single-byte literal: just advance by one.
        offset + 1
    } else {
        let (_, content_len, content_off) = read_rlp_header(bytes, offset);
        content_off + content_len
    }
}

/// Read an RLP string item at `offset` and return its content as a freshly allocated vector.
/// Aborts ENotAList if the item is actually a list. Single-byte literals return a 1-byte vec.
fun read_rlp_string(bytes: &vector<u8>, offset: u64): vector<u8> {
    let total = bytes.length();
    assert!(offset < total, ETxTooShort);
    let b0 = bytes[offset];

    if (b0 < 0x80) {
        // Single-byte literal: content is the byte itself.
        let mut out = vector::empty<u8>();
        out.push_back(b0);
        out
    } else {
        let (is_list, content_len, content_off) = read_rlp_header(bytes, offset);
        assert!(!is_list, ENotAList);
        assert!(content_off + content_len <= total, ETxTooShort);
        let mut out = vector::empty<u8>();
        let mut i: u64 = 0;
        while (i < content_len) {
            out.push_back(bytes[content_off + i]);
            i = i + 1;
        };
        out
    }
}

/// Read an RLP-encoded big-endian unsigned integer (≤16 bytes -> u128).
fun read_rlp_uint128(bytes: &vector<u8>, offset: u64): u128 {
    let s = read_rlp_string(bytes, offset);
    let len = s.length();
    assert!(len <= 16, EValueOverflow);
    let mut value: u128 = 0;
    let mut i: u64 = 0;
    while (i < len) {
        value = (value << 8) | (s[i] as u128);
        i = i + 1;
    };
    value
}

/// Decode an EVM transaction (legacy / EIP-1559 / EIP-2930) and return:
///   - `tx_type` (0xff legacy / 0x02 EIP-1559 / 0x01 EIP-2930)
///   - `to` (20 bytes for normal sends, empty for contract-creation)
///   - `value_wei` as u128
///
/// Aborts EBadRlpPrefix on malformed input, EUnsupportedTxType on EIP-4844+ etc.,
/// ETxTooShort on truncation, EValueOverflow if value field exceeds 16 bytes.
fun decode_eth_tx(message: &vector<u8>): (u8, vector<u8>, u128) {
    let total = message.length();
    assert!(total >= 1, ETxTooShort);
    let b0 = message[0];

    // Detect tx type. EIP-2718: typed envelope is byte 0 in 0x00..0x7f. Specifically:
    //   0x01 = EIP-2930
    //   0x02 = EIP-1559
    //   0x03 = EIP-4844 (blob; unsupported)
    //   0xc0..0xff = legacy RLP list (no envelope byte)
    let (tx_type, body_offset, to_index, value_index) = if (b0 == TX_TYPE_EIP1559) {
        // 0x02 || RLP([chainId, nonce, maxPriorityFee, maxFee, gasLimit, to, value, data, accessList])
        (TX_TYPE_EIP1559, 1u64, 5u64, 6u64)
    } else if (b0 == TX_TYPE_EIP2930) {
        // 0x01 || RLP([chainId, nonce, gasPrice, gasLimit, to, value, data, accessList])
        (TX_TYPE_EIP2930, 1u64, 4u64, 5u64)
    } else if (b0 >= 0xc0) {
        // Legacy: RLP([nonce, gasPrice, gasLimit, to, value, data, chainId, 0, 0])
        (TX_TYPE_LEGACY, 0u64, 3u64, 4u64)
    } else if (b0 >= 0x01 && b0 < 0x80) {
        // Typed envelope but type we don't support (EIP-4844 etc.).
        abort EUnsupportedTxType
    } else {
        abort EBadRlpPrefix
    };

    // Outer list header.
    let (is_list, _list_content_len, list_content_off) = read_rlp_header(message, body_offset);
    assert!(is_list, EBadRlpPrefix);

    // Walk to the `to` field, read it, then to `value`.
    let mut cursor = list_content_off;
    let mut i: u64 = 0;
    while (i < to_index) {
        cursor = skip_rlp_item(message, cursor);
        i = i + 1;
    };
    let to_bytes = read_rlp_string(message, cursor);

    cursor = skip_rlp_item(message, cursor);
    i = to_index + 1;
    while (i < value_index) {
        cursor = skip_rlp_item(message, cursor);
        i = i + 1;
    };
    let value_wei = read_rlp_uint128(message, cursor);

    (tx_type, to_bytes, value_wei)
}

/// Convert wei to micro-USD using the caller-supplied price.
///
/// Math: `value_micros = floor(value_wei * price_micros_per_eth / 1e18)`. Uses u256 to avoid
/// overflow on the multiply (u128 * u64 fits in u192 but we promote to u256 for safety).
/// Saturates at u64 max for impractical inputs. Returns 0 on zero input or zero price.
fun wei_to_micros_usd(value_wei: u128, price_micros_per_eth: u64): u64 {
    if (value_wei == 0) return 0;
    if (price_micros_per_eth == 0) return 0;
    let v: u256 = (value_wei as u256);
    let p: u256 = (price_micros_per_eth as u256);
    let result: u256 = (v * p) / WEI_PER_ETH;
    if (result > U64_MAX_AS_U256) return U64_MAX_AS_U256 as u64;
    result as u64
}

// ─── public for tests / inspection ───────────────────────────────────────────────

/// Test-only entry point so Move test harnesses can verify the decoder in isolation.
public fun decode_eth_tx_for_testing(message: vector<u8>): (u8, vector<u8>, u128) {
    decode_eth_tx(&message)
}

public fun wei_to_micros_usd_for_testing(value_wei: u128, price_micros_per_eth: u64): u64 {
    wei_to_micros_usd(value_wei, price_micros_per_eth)
}
