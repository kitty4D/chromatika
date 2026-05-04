/**
 * minimal protobuf wire codec for Encrypt executor unary calls.
 * avoids importing `@encrypt.xyz/.../encrypt_service` in the extension graph (that module pulls `@grpc/grpc-js`).
 */

import { BinaryReader, BinaryWriter, WireType } from '@bufbuild/protobuf/wire';

export type EncryptedInputWire = {
  ciphertextBytes: Uint8Array;
  fheType: number;
};

export type CreateInputRequestWire = {
  chain: number;
  inputs: EncryptedInputWire[];
  proof: Uint8Array;
  authorized: Uint8Array;
  networkEncryptionPublicKey: Uint8Array;
};

export function encodeEncryptedInput(message: EncryptedInputWire): Uint8Array {
  const w = new BinaryWriter();
  if (message.ciphertextBytes.length > 0) w.uint32(10).bytes(message.ciphertextBytes);
  if (message.fheType !== 0) w.uint32(16).uint32(message.fheType);
  return w.finish();
}

export function encodeCreateInputRequest(message: CreateInputRequestWire): Uint8Array {
  const writer = new BinaryWriter();
  if (message.chain !== 0) writer.uint32(8).int32(message.chain);
  for (const v of message.inputs) {
    writer.uint32(18).bytes(encodeEncryptedInput(v));
  }
  if (message.proof.length > 0) writer.uint32(26).bytes(message.proof);
  if (message.authorized.length > 0) writer.uint32(34).bytes(message.authorized);
  if (message.networkEncryptionPublicKey.length > 0) {
    writer.uint32(42).bytes(message.networkEncryptionPublicKey);
  }
  return writer.finish();
}

export function decodeCreateInputResponse(data: Uint8Array): { ciphertextIdentifiers: Uint8Array[] } {
  const reader = new BinaryReader(data);
  const end = reader.len;
  const ciphertextIdentifiers: Uint8Array[] = [];
  while (reader.pos < end) {
    const tag = reader.uint32();
    if (tag === 10) {
      ciphertextIdentifiers.push(reader.bytes());
      continue;
    }
    reader.skip((tag & 7) as WireType);
  }
  return { ciphertextIdentifiers };
}

export type ReadCiphertextRequestWire = {
  message: Uint8Array;
  signature: Uint8Array;
  signer: Uint8Array;
};

export function encodeReadCiphertextRequest(message: ReadCiphertextRequestWire): Uint8Array {
  const w = new BinaryWriter();
  if (message.message.length > 0) w.uint32(10).bytes(message.message);
  if (message.signature.length > 0) w.uint32(18).bytes(message.signature);
  if (message.signer.length > 0) w.uint32(26).bytes(message.signer);
  return w.finish();
}

export type ReadCiphertextResponseWire = {
  value: Uint8Array;
  fheType: number;
  digest: Uint8Array;
};

export function decodeReadCiphertextResponse(data: Uint8Array): ReadCiphertextResponseWire {
  const reader = new BinaryReader(data);
  const end = reader.len;
  const out: ReadCiphertextResponseWire = {
    value: new Uint8Array(0),
    fheType: 0,
    digest: new Uint8Array(0),
  };
  while (reader.pos < end) {
    const tag = reader.uint32();
    switch (tag) {
      case 10:
        out.value = reader.bytes();
        break;
      case 16:
        out.fheType = reader.uint32();
        break;
      case 26:
        out.digest = reader.bytes();
        break;
      default:
        reader.skip((tag & 7) as WireType);
        break;
    }
  }
  return out;
}
