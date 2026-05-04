/** Lowercase hex without `0x` (matches hardware queue validators). */
export function uint8ToHexNo0x(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function hexNo0xToUint8(hex: string): Uint8Array {
  const h = hex.trim();
  if (h.startsWith('0x') || h.startsWith('0X')) {
    throw new Error('hex must not use 0x prefix here');
  }
  if (h.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(h)) {
    throw new Error('invalid hex string');
  }
  return Uint8Array.from(h.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)));
}
