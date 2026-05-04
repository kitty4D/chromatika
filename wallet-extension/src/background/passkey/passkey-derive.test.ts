import { describe, expect, it } from 'vitest';
import { bytesToHex } from '@noble/hashes/utils.js';
import { fromBase64 } from '@mysten/sui/utils';
import { chromatikaPrfSalt, chromatikaPrfSaltB64 } from '@/background/passkey/passkey-derive';
import { ikaRootSeedFromPasskeyPRF } from '@/background/keyring/hd';

describe('chromatikaPrfSalt (deterministic webauthn prf domain separator)', () => {
  it('returns exactly 32 bytes', () => {
    const s = chromatikaPrfSalt();
    expect(s).toBeInstanceOf(Uint8Array);
    expect(s.length).toBe(32);
  });

  it('is identical across calls (deterministic constant)', () => {
    const a = chromatikaPrfSalt();
    const b = chromatikaPrfSalt();
    expect(bytesToHex(a)).toBe(bytesToHex(b));
  });

  it('matches the keccak256 of the canonical domain string', () => {
    // golden: locks the domain string so a future bump (e.g. v2) is an explicit, visible change.
    // any drift here breaks restore-from-passkey for every shipped vault, so we want a flashing
    // red light if the constant moves.
    expect(bytesToHex(chromatikaPrfSalt())).toBe(
      // keccak256("chromatika.passkey.prf-salt.v1")
      '6326daeeaf06c3f5427301bacb4a9f6bf95f58c9bb61c555d091ee3a28cda0db',
    );
  });

  it('returns a fresh copy each call so callers cannot mutate the cached buffer', () => {
    const first = chromatikaPrfSalt();
    first.fill(0xff);
    const second = chromatikaPrfSalt();
    expect(second[0]).not.toBe(0xff);
  });

  it('b64 helper round-trips back to the same 32 bytes', () => {
    const raw = chromatikaPrfSalt();
    const b64 = chromatikaPrfSaltB64();
    expect(fromBase64(b64)).toEqual(raw);
  });
});

describe('ikaRootSeedFromPasskeyPRF index plumbing (multi-vault from one passkey)', () => {
  // simulate a 32-byte prf hmac-secret output for a fixed passkey credential.
  const prfSecret = new Uint8Array(32).map((_, i) => (i * 7 + 11) & 0xff);

  it('produces different seeds for different encryption-key indices (bip44-style accounts)', () => {
    const seed0 = ikaRootSeedFromPasskeyPRF(prfSecret, 0);
    const seed1 = ikaRootSeedFromPasskeyPRF(prfSecret, 1);
    const seed2 = ikaRootSeedFromPasskeyPRF(prfSecret, 2);
    expect(seed0).toHaveLength(32);
    expect(seed1).toHaveLength(32);
    expect(seed2).toHaveLength(32);
    expect(bytesToHex(seed0)).not.toBe(bytesToHex(seed1));
    expect(bytesToHex(seed1)).not.toBe(bytesToHex(seed2));
    expect(bytesToHex(seed0)).not.toBe(bytesToHex(seed2));
  });

  it('is deterministic for a given (prfSecret, index) pair across calls', () => {
    const a = ikaRootSeedFromPasskeyPRF(prfSecret, 3);
    const b = ikaRootSeedFromPasskeyPRF(prfSecret, 3);
    expect(bytesToHex(a)).toBe(bytesToHex(b));
  });

  it('defaults to index 0 when omitted', () => {
    const explicit = ikaRootSeedFromPasskeyPRF(prfSecret, 0);
    const implicit = ikaRootSeedFromPasskeyPRF(prfSecret);
    expect(bytesToHex(implicit)).toBe(bytesToHex(explicit));
  });

  it('different prf secrets at the same index produce different seeds (cross-credential separation)', () => {
    const otherPrf = new Uint8Array(32).map((_, i) => (i * 13 + 5) & 0xff);
    const seedA = ikaRootSeedFromPasskeyPRF(prfSecret, 0);
    const seedB = ikaRootSeedFromPasskeyPRF(otherPrf, 0);
    expect(bytesToHex(seedA)).not.toBe(bytesToHex(seedB));
  });
});
