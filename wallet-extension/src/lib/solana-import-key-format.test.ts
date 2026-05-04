import { describe, expect, it } from 'vitest';
import { solanaSecretKeyB64FromFlexiblePaste } from './solana-import-key-format';

describe('solanaSecretKeyB64FromFlexiblePaste', () => {
  it('accepts raw json byte array of 64', () => {
    const bytes = Array.from({ length: 64 }, (_, i) => i % 256);
    const b64 = solanaSecretKeyB64FromFlexiblePaste(JSON.stringify(bytes));
    expect(b64.length).toBeGreaterThan(0);
    const round = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    expect(round.length).toBe(64);
    expect([...round]).toEqual(bytes);
  });

  it('accepts solana-keygen style object', () => {
    const bytes = Array.from({ length: 64 }, (_, i) => (i * 3) % 256);
    const b64 = solanaSecretKeyB64FromFlexiblePaste(JSON.stringify({ secretKey: bytes }));
    const round = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    expect(round.length).toBe(64);
  });
});
