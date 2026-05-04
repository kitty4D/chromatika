import { describe, it, expect } from 'vitest';
import { parseSolanaDWalletAccountData } from '@/background/ika/solana-dwallet-onchain';

describe('parseSolanaDWalletAccountData', () => {
  it('parses ed25519 dwallet layout (curve u16 LE @34, pkLen @37, pubkey @38)', () => {
    const buf = new Uint8Array(153);
    buf[0] = 2;
    buf[1] = 1;
    buf.fill(7, 2, 34);
    buf[34] = 2;
    buf[35] = 0;
    buf[36] = 1;
    buf[37] = 32;
    buf.fill(9, 38, 38 + 32);
    const r = parseSolanaDWalletAccountData(buf);
    expect(r.curveKey).toBe('ED25519');
    expect(r.curveByte).toBe(2);
    expect(r.publicOutput.length).toBe(32);
    expect(Array.from(r.publicOutput)).toEqual(new Array(32).fill(9));
  });

  it('parses secp256k1 compressed (curve 0, pkLen 33)', () => {
    const buf = new Uint8Array(153);
    buf[0] = 2;
    buf[1] = 1;
    buf.fill(3, 2, 34);
    buf[34] = 0;
    buf[35] = 0;
    buf[36] = 1;
    buf[37] = 33;
    buf[38] = 0x03;
    buf.fill(5, 39, 38 + 33);
    const r = parseSolanaDWalletAccountData(buf);
    expect(r.curveKey).toBe('SECP256K1');
    expect(r.curveByte).toBe(0);
    expect(r.publicOutput.length).toBe(33);
    expect(r.publicOutput[0]).toBe(0x03);
  });

  it('rejects when pkLen overflows the buffer', () => {
    const buf = new Uint8Array(60);
    buf[0] = 2;
    buf[1] = 1;
    expect(() => parseSolanaDWalletAccountData(buf)).toThrow(/too short/);
  });
});
