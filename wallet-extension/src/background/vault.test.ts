import { describe, expect, it } from 'vitest';
import {
  ARGON2ID_PARAMS,
  decryptVaultWithPassword,
  encryptVaultFresh,
  parseVaultBlob,
} from '@/background/vault';

describe('vault (argon2id v3)', () => {
  it('round-trips plaintext through fresh-encrypt + password-decrypt', async () => {
    const pw = 'correct horse battery staple';
    const { blob } = await encryptVaultFresh(pw, '{"k":1}');
    const parsed = parseVaultBlob(blob);
    expect(parsed.v).toBe(3);
    expect(parsed.kdf).toBe('argon2id');
    expect(parsed.t).toBe(ARGON2ID_PARAMS.t);
    expect(parsed.m).toBe(ARGON2ID_PARAMS.m);
    expect(parsed.p).toBe(ARGON2ID_PARAMS.p);
    const out = await decryptVaultWithPassword(pw, blob);
    expect(out.plaintext).toBe('{"k":1}');
  }, 60_000);

  it('rejects wrong password with a Wrong password error', async () => {
    const { blob } = await encryptVaultFresh('right', '{"k":1}');
    await expect(decryptVaultWithPassword('wrong', blob)).rejects.toThrow(/Wrong password/);
  }, 60_000);

  it('rejects legacy PBKDF2 v2 blobs (pre-release: clear storage)', () => {
    const legacyV2 = JSON.stringify({
      iterations: 900_000,
      salt: 'AAAA',
      iv: 'AAAA',
      data: 'AAAA',
    });
    expect(() => parseVaultBlob(legacyV2)).toThrow(/Legacy PBKDF2 vault/);
  });
});
