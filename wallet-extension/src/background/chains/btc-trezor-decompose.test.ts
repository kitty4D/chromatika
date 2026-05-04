/**
 * unit tests for the PSBT -> Trezor decomposition. pure parser tests, no hardware required.
 *
 * live device tests (sign + broadcast) require a real Trezor One/Model T against regtest
 * or testnet, documented as a manual smoke in `docs/STATUS.md`.
 */

import { describe, expect, it } from 'vitest';
import { Psbt, networks, address } from 'bitcoinjs-lib';
import {
  __test__,
  decomposeBtcPsbtForTrezor,
  decodeRawTxToRefTransaction,
  parseBip44PathToNumbers,
} from './btc-trezor-decompose';

const { detectInputScriptType, detectOutputScriptType, bytesToHex, bytesToHexBe } = __test__;

describe('parseBip44PathToNumbers', () => {
  it("parses m/84'/0'/0'/0/0 (BIP84 segwit)", () => {
    const out = parseBip44PathToNumbers("m/84'/0'/0'/0/0");
    expect(out).toEqual([2147483732, 2147483648, 2147483648, 0, 0]);
  });

  it("accepts 'h' as hardened marker", () => {
    expect(parseBip44PathToNumbers("84h/0h/0h/0/0")).toEqual([2147483732, 2147483648, 2147483648, 0, 0]);
  });

  it('handles plain numbers', () => {
    expect(parseBip44PathToNumbers('0/0')).toEqual([0, 0]);
  });

  it('strips the leading m/', () => {
    expect(parseBip44PathToNumbers("m/0'")).toEqual([2147483648]);
  });

  it('throws on negative', () => {
    expect(() => parseBip44PathToNumbers("-1'")).toThrow();
  });

  it('returns empty for empty path', () => {
    expect(parseBip44PathToNumbers('m/')).toEqual([]);
    expect(parseBip44PathToNumbers('')).toEqual([]);
  });
});

describe('detectInputScriptType', () => {
  it('detects P2WPKH from 22-byte 0x00 0x14 prefix', () => {
    const bytes = new Uint8Array(22);
    bytes[0] = 0x00;
    bytes[1] = 0x14;
    // remaining 20 zero bytes
    expect(detectInputScriptType(bytes)).toBe('SPENDWITNESS');
  });

  it('detects P2SH-P2WPKH from 23-byte 0xa9 0x14 ... 0x87', () => {
    const bytes = new Uint8Array(23);
    bytes[0] = 0xa9;
    bytes[1] = 0x14;
    bytes[22] = 0x87;
    expect(detectInputScriptType(bytes)).toBe('SPENDP2SHWITNESS');
  });

  it('falls back to SPENDADDRESS for legacy P2PKH', () => {
    const bytes = new Uint8Array([0x76, 0xa9, 0x14, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x88, 0xac]);
    expect(detectInputScriptType(bytes)).toBe('SPENDADDRESS');
  });

  it('handles undefined/empty as SPENDADDRESS', () => {
    expect(detectInputScriptType(undefined)).toBe('SPENDADDRESS');
    expect(detectInputScriptType(new Uint8Array(0))).toBe('SPENDADDRESS');
  });
});

describe('detectOutputScriptType', () => {
  it('detects P2WPKH (22 bytes, 0x14 push)', () => {
    const bytes = new Uint8Array(22);
    bytes[0] = 0x00;
    bytes[1] = 0x14;
    expect(detectOutputScriptType(bytes)).toBe('PAYTOWITNESS');
  });

  it('detects P2WSH (34 bytes, 0x20 push)', () => {
    const bytes = new Uint8Array(34);
    bytes[0] = 0x00;
    bytes[1] = 0x20;
    expect(detectOutputScriptType(bytes)).toBe('PAYTOWITNESS');
  });

  it('detects P2SH', () => {
    const bytes = new Uint8Array(23);
    bytes[0] = 0xa9;
    bytes[1] = 0x14;
    bytes[22] = 0x87;
    expect(detectOutputScriptType(bytes)).toBe('PAYTOP2SHWITNESS');
  });

  it('falls back to PAYTOADDRESS', () => {
    expect(detectOutputScriptType(new Uint8Array([0x76, 0xa9]))).toBe('PAYTOADDRESS');
  });
});

describe('bytesToHexBe (display-order reversal)', () => {
  it('reverses byte order for big-endian display', () => {
    const le = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
    expect(bytesToHexBe(le)).toBe('04030201');
  });

  it('round-trip with bytesToHex (no reverse)', () => {
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    expect(bytesToHex(bytes)).toBe('deadbeef');
    expect(bytesToHexBe(bytes)).toBe('efbeadde');
  });
});

describe('decomposeBtcPsbtForTrezor', () => {
  /** Build a P2WPKH output script (0x00 0x14 + 20-byte hash) directly. */
  function p2wpkhScript(hash20: Uint8Array): Buffer {
    if (hash20.length !== 20) throw new Error('expected 20-byte hash');
    const out = Buffer.alloc(22);
    out[0] = 0x00;
    out[1] = 0x14;
    out.set(hash20, 2);
    return out;
  }

  /**
   * Build a deterministic P2WPKH PSBT: 1 input, 1 recipient output, 1 change output.
   * All scripts are built directly from 20-byte hashes so no bech32 address parsing is
   * required. The test asserts `script_type` detection works without pinning a specific
   * address-decode result; we test the address-decode path separately.
   */
  function buildTestPsbt(opts: {
    net: typeof networks.testnet | typeof networks.bitcoin;
    recipientHash: Uint8Array;
    changeHash: Uint8Array;
  }): { psbtHex: string; prevTxidHex: string } {
    const psbt = new Psbt({ network: opts.net });
    const prevTxidLeBytes = new Uint8Array(32); // all zeros

    // The signer's UTXO uses a 20-byte hash matching `changeHash` (own input)
    const signerScript = p2wpkhScript(opts.changeHash);
    psbt.addInput({
      hash: Buffer.from(prevTxidLeBytes),
      index: 0,
      witnessUtxo: { script: signerScript, value: 200_000n },
    });
    psbt.addOutput({ script: p2wpkhScript(opts.recipientHash), value: 100_000n });
    psbt.addOutput({ script: p2wpkhScript(opts.changeHash), value: 99_000n });
    return { psbtHex: psbt.toHex(), prevTxidHex: '0'.repeat(64) };
  }

  it('decomposes a 1-input / 2-output P2WPKH PSBT (testnet)', () => {
    const recipientHash = new Uint8Array(20).fill(0xaa);
    const changeHash = new Uint8Array(20).fill(0x42);
    const { psbtHex, prevTxidHex } = buildTestPsbt({
      net: networks.testnet,
      recipientHash,
      changeHash,
    });

    // Decode the changeHash address so we can pass it as the change-detection trigger.
    const changeAddr = address.fromOutputScript(p2wpkhScript(changeHash), networks.testnet);

    const out = decomposeBtcPsbtForTrezor(psbtHex, {
      signerAddress: changeAddr,
      signerDerivationPath: "m/84'/1'/0'/0/0",
      network: networks.testnet,
      changeAddress: changeAddr,
      changeAddressDerivationPath: "m/84'/1'/0'/1/0",
    });

    expect(out.coin).toBe('test');
    expect(out.inputs.length).toBe(1);
    const input = out.inputs[0]!;
    expect(input.prev_hash).toBe(prevTxidHex);
    expect(input.prev_index).toBe(0);
    expect(input.amount).toBe('200000');
    expect(input.script_type).toBe('SPENDWITNESS');
    expect(input.address_n).toEqual([2147483732, 2147483649, 2147483648, 0, 0]);

    expect(out.outputs.length).toBe(2);
    // First output: recipient (external)
    const recipient = out.outputs[0]!;
    expect(recipient.address).toBeDefined();
    expect(recipient.address_n).toBeUndefined();
    expect(recipient.amount).toBe('100000');
    expect(recipient.script_type).toBe('PAYTOWITNESS');

    // Second output: change to own address
    const change = out.outputs[1]!;
    expect(change.address).toBeUndefined();
    expect(change.address_n).toEqual([2147483732, 2147483649, 2147483648, 1, 0]);
    expect(change.amount).toBe('99000');

    expect(out.refTxIds).toEqual([prevTxidHex]);
  });

  it('mainnet coin string is "btc"', () => {
    const recipientHash = new Uint8Array(20).fill(0xaa);
    const changeHash = new Uint8Array(20).fill(0x42);
    const { psbtHex } = buildTestPsbt({
      net: networks.bitcoin,
      recipientHash,
      changeHash,
    });
    const changeAddr = address.fromOutputScript(p2wpkhScript(changeHash), networks.bitcoin);
    const out = decomposeBtcPsbtForTrezor(psbtHex, {
      signerAddress: changeAddr,
      signerDerivationPath: "m/84'/0'/0'/0/0",
      network: networks.bitcoin,
    });
    expect(out.coin).toBe('btc');
  });

  it('throws when an input has no witnessUtxo (defensive guard)', () => {
    // Build a valid PSBT first, then nuke witnessUtxo before parsing. Bitcoinjs strips
    // witnessUtxo on serialization if it's undefined; we simulate the post-parse state
    // by constructing the PSBT, decomposing once to confirm it works, then mutating its
    // internal state to clear witnessUtxo and re-decomposing should throw.
    const changeHash = new Uint8Array(20).fill(0x42);
    const recipientHash = new Uint8Array(20).fill(0xaa);
    const psbt = new Psbt({ network: networks.testnet });
    psbt.addInput({
      hash: Buffer.alloc(32),
      index: 0,
      witnessUtxo: { script: p2wpkhScript(changeHash), value: 100n },
    });
    psbt.addOutput({ script: p2wpkhScript(recipientHash), value: 90n });
    psbt.data.inputs[0]!.witnessUtxo = undefined;

    // either bitcoinjs fails during toHex() (because PSBT spec requires utxo info per
    // input) OR our parser throws after parse. either is acceptable, the contract is
    // "decomposing a PSBT without witness utxo info doesn't silently succeed."
    expect(() => {
      const hex = psbt.toHex();
      decomposeBtcPsbtForTrezor(hex, {
        signerAddress: '',
        signerDerivationPath: "m/84'/1'/0'/0/0",
        network: networks.testnet,
      });
    }).toThrow();
  });

  it('treats outputs as external (no address_n) when no changePath provided', () => {
    const recipientHash = new Uint8Array(20).fill(0xaa);
    const changeHash = new Uint8Array(20).fill(0x42);
    const { psbtHex } = buildTestPsbt({
      net: networks.testnet,
      recipientHash,
      changeHash,
    });
    const out = decomposeBtcPsbtForTrezor(psbtHex, {
      signerAddress: '',
      signerDerivationPath: "m/84'/1'/0'/0/0",
      network: networks.testnet,
      // no changeAddress / changeAddressDerivationPath
    });
    expect(out.outputs.every((o) => o.address && !o.address_n)).toBe(true);
  });
});

describe('decodeRawTxToRefTransaction', () => {
  it('decodes a simple coinbase-style raw tx', () => {
    // Construct a minimal raw tx: version=1, 1 input (all-zero prevhash, vin=0xffffffff, empty script),
    // 1 output (1000 sats to a P2WPKH script), locktime=0.
    const raw =
      '01000000' + // version u32 LE
      '01' + // input count varint
      '0000000000000000000000000000000000000000000000000000000000000000' + // prev hash
      'ffffffff' + // prev index
      '00' + // script_sig length
      'ffffffff' + // sequence
      '01' + // output count
      'e803000000000000' + // amount = 1000 sats LE
      '16' + // script length = 22
      '0014' + '0'.repeat(40) + // P2WPKH script (0x00 0x14 + 20 zero bytes)
      '00000000'; // lock_time

    const ref = decodeRawTxToRefTransaction(raw);
    expect(ref.version).toBe(1);
    expect(ref.lock_time).toBe(0);
    expect(ref.inputs.length).toBe(1);
    expect(ref.inputs[0]!.prev_hash).toBe('0'.repeat(64));
    expect(ref.inputs[0]!.prev_index).toBe(0xffffffff);
    expect(ref.inputs[0]!.sequence).toBe(0xffffffff);
    expect(ref.bin_outputs.length).toBe(1);
    expect(ref.bin_outputs[0]!.amount).toBe('1000');
    expect(ref.bin_outputs[0]!.script_pubkey).toBe('0014' + '0'.repeat(40));
    // hash should be a 64-char hex
    expect(ref.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
