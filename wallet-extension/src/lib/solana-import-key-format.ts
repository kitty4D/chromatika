/**
 * normalizes Solana fee keypaste for `solanaSecretKeyB64`: either Phantom/solana-keygen style
 * base64 (64 raw bytes) or JSON (`[uint8,...]` or `{"secretKey":[...]}` export).
 */
export function solanaSecretKeyB64FromFlexiblePaste(raw: string): string {
  const t = raw.trim();
  if (!t) throw new Error('paste your Solana secret key');
  if (!t.startsWith('[') && !t.startsWith('{')) {
    const b64 = t;
    const u8 = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    if (u8.length < 64) throw new Error('base64 decodes to fewer than 64 bytes');
    return b64;
  }
  let nums: unknown;
  try {
    const parsed: unknown = JSON.parse(t);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'secretKey' in parsed) {
      nums = (parsed as { secretKey: unknown }).secretKey;
    } else {
      nums = parsed;
    }
  } catch {
    throw new Error('invalid JSON, use a [byte,...] array or {"secretKey":[...]}');
  }
  if (!Array.isArray(nums)) throw new Error('expected a JSON array of byte values');
  if (nums.length !== 64) throw new Error('expected 64 bytes in the secret key');
  const bytes = new Uint8Array(64);
  for (let i = 0; i < 64; i++) {
    const n = nums[i];
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 255) {
      throw new Error('each entry must be an integer 0-255');
    }
    bytes[i] = n;
  }
  return btoa(String.fromCharCode(...bytes));
}
