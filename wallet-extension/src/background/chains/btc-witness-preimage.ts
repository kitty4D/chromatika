/**
 * BIP143 witness v0 sighash preimage (same construction as bitcoinjs-lib Transaction.hashForWitnessV0,
 * but returns the preimage buffer before the final hash256).
 */

import { Transaction, crypto } from 'bitcoinjs-lib';
import * as tools from 'uint8array-tools';
import * as varuint from 'varuint-bitcoin';

const ZERO = tools.fromHex(
  '0000000000000000000000000000000000000000000000000000000000000000',
);

function varSliceSize(someScript: Uint8Array): number {
  const length = someScript.length;
  return varuint.encodingLength(length) + length;
}

/** minimal BufferWriter (same behavior as bitcoinjs-lib for this preimage). */
class BufferWriter {
  buffer: Uint8Array;
  offset: number;
  static withCapacity(size: number): BufferWriter {
    return new BufferWriter(new Uint8Array(size));
  }
  constructor(buffer: Uint8Array, offset = 0) {
    this.buffer = buffer;
    this.offset = offset;
  }
  writeUInt32(i: number) {
    this.offset = tools.writeUInt32(this.buffer, this.offset, i, 'LE');
  }
  writeInt64(i: bigint) {
    this.offset = tools.writeInt64(this.buffer, this.offset, i, 'LE');
  }
  writeSlice(slice: Uint8Array) {
    if (this.buffer.length < this.offset + slice.length) {
      throw new Error('Cannot write slice out of bounds');
    }
    this.buffer.set(slice, this.offset);
    this.offset += slice.length;
  }
  writeVarInt(i: number) {
    const { bytes } = varuint.encode(i, this.buffer, this.offset);
    this.offset += bytes;
  }
  writeVarSlice(slice: Uint8Array) {
    this.writeVarInt(slice.length);
    this.writeSlice(slice);
  }
  end() {
    if (this.buffer.length === this.offset) {
      return this.buffer;
    }
    throw new Error(`buffer size ${this.buffer.length}, offset ${this.offset}`);
  }
}

/**
 * returns the BIP143 preimage bytes ika should hash with DoubleSHA256 (matches Bitcoin's hash256(sighash)).
 */
export function witnessV0Preimage(
  tx: InstanceType<typeof Transaction>,
  inIndex: number,
  prevOutScript: Uint8Array,
  value: bigint,
  hashType: number,
): Uint8Array {
  let tbuffer = Uint8Array.from([]);
  let bufferWriter: BufferWriter;
  let hashOutputs = ZERO;
  let hashPrevouts = ZERO;
  let hashSequence = ZERO;
  if (!(hashType & Transaction.SIGHASH_ANYONECANPAY)) {
    tbuffer = new Uint8Array(36 * tx.ins.length);
    bufferWriter = new BufferWriter(tbuffer, 0);
    for (const txIn of tx.ins) {
      bufferWriter.writeSlice(txIn.hash);
      bufferWriter.writeUInt32(txIn.index);
    }
    hashPrevouts = crypto.hash256(tbuffer);
  }
  if (
    !(hashType & Transaction.SIGHASH_ANYONECANPAY) &&
    (hashType & 0x1f) !== Transaction.SIGHASH_SINGLE &&
    (hashType & 0x1f) !== Transaction.SIGHASH_NONE
  ) {
    tbuffer = new Uint8Array(4 * tx.ins.length);
    bufferWriter = new BufferWriter(tbuffer, 0);
    for (const txIn of tx.ins) {
      bufferWriter.writeUInt32(txIn.sequence);
    }
    hashSequence = crypto.hash256(tbuffer);
  }
  if ((hashType & 0x1f) !== Transaction.SIGHASH_SINGLE && (hashType & 0x1f) !== Transaction.SIGHASH_NONE) {
    const txOutsSize = tx.outs.reduce((sum, output) => {
      return sum + 8 + varSliceSize(output.script);
    }, 0);
    tbuffer = new Uint8Array(txOutsSize);
    bufferWriter = new BufferWriter(tbuffer, 0);
    for (const out of tx.outs) {
      bufferWriter.writeInt64(out.value);
      bufferWriter.writeVarSlice(out.script);
    }
    hashOutputs = crypto.hash256(tbuffer);
  } else if ((hashType & 0x1f) === Transaction.SIGHASH_SINGLE && inIndex < tx.outs.length) {
    const output = tx.outs[inIndex];
    tbuffer = new Uint8Array(8 + varSliceSize(output.script));
    bufferWriter = new BufferWriter(tbuffer, 0);
    bufferWriter.writeInt64(output.value);
    bufferWriter.writeVarSlice(output.script);
    hashOutputs = crypto.hash256(tbuffer);
  }
  tbuffer = new Uint8Array(156 + varSliceSize(prevOutScript));
  bufferWriter = new BufferWriter(tbuffer, 0);
  const input = tx.ins[inIndex];
  bufferWriter.writeUInt32(tx.version);
  bufferWriter.writeSlice(hashPrevouts);
  bufferWriter.writeSlice(hashSequence);
  bufferWriter.writeSlice(input.hash);
  bufferWriter.writeUInt32(input.index);
  bufferWriter.writeVarSlice(prevOutScript);
  bufferWriter.writeInt64(value);
  bufferWriter.writeUInt32(input.sequence);
  bufferWriter.writeSlice(hashOutputs);
  bufferWriter.writeUInt32(tx.locktime);
  bufferWriter.writeUInt32(hashType);
  return bufferWriter.end();
}
