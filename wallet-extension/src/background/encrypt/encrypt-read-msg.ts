/**
 * BCS layout for Encrypt `ReadCiphertextMessage` (matches `@encrypt.xyz/pre-alpha-solana-client` grpc helper).
 * chain(u8) + ciphertext_identifier(vec) + reencryption_key(vec) + epoch(u64 LE)
 */

export function encodeReadCiphertextMessage(
  chain: number,
  ciphertextIdentifier: Uint8Array,
  reencryptionKey: Uint8Array,
  epoch: bigint,
): Uint8Array {
  const ctIdLen = ciphertextIdentifier.length;
  const rekeyLen = reencryptionKey.length;
  const totalLen = 1 + 1 + ctIdLen + 1 + rekeyLen + 8;
  const buf = new Uint8Array(totalLen);
  let offset = 0;
  buf[offset++] = chain & 0xff;
  buf[offset++] = ctIdLen;
  buf.set(ciphertextIdentifier, offset);
  offset += ctIdLen;
  buf[offset++] = rekeyLen;
  buf.set(reencryptionKey, offset);
  offset += rekeyLen;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  view.setBigUint64(offset, epoch, true);
  return buf;
}
