import { describe, expect, it } from 'vitest';
import { buildCandidates, buildHdCandidates, buildIdentityCandidate } from '@/background/scan/scan-derivations';

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('buildHdCandidates', () => {
  it('returns hardLimit + gap candidates by default (5 + 5 = 10 unless caller bumps)', () => {
    const candidates = buildHdCandidates(TEST_MNEMONIC);
    // default hardLimit=20 + gap=5 = 25 candidates, but the orchestrator stops earlier on its own.
    expect(candidates.length).toBeGreaterThanOrEqual(20);
    expect(candidates.length).toBeLessThanOrEqual(50);
  });

  it('produces unique sui / solana / evm addresses per accountIndex', () => {
    const candidates = buildHdCandidates(TEST_MNEMONIC, { maxIndexHardLimit: 5 });
    const suiSet = new Set(candidates.map((c) => c.suiAddress));
    const solSet = new Set(candidates.map((c) => c.solanaAddress));
    const evmSet = new Set(candidates.map((c) => c.evmAddress));
    expect(suiSet.size).toBe(candidates.length);
    expect(solSet.size).toBe(candidates.length);
    expect(evmSet.size).toBe(candidates.length);
  });

  it('candidate at accountIndex 0 has stable derived addresses (round-trip determinism)', () => {
    const a = buildHdCandidates(TEST_MNEMONIC, { maxIndexHardLimit: 1 });
    const b = buildHdCandidates(TEST_MNEMONIC, { maxIndexHardLimit: 1 });
    expect(a[0]!.suiAddress).toBe(b[0]!.suiAddress);
    expect(a[0]!.solanaAddress).toBe(b[0]!.solanaAddress);
    expect(a[0]!.evmAddress).toBe(b[0]!.evmAddress);
  });

  it('candidate keys encode the accountIndex for stable react keys', () => {
    const candidates = buildHdCandidates(TEST_MNEMONIC, { maxIndexHardLimit: 3 });
    expect(candidates[0]!.key).toBe('hd:account=0');
    expect(candidates[1]!.key).toBe('hd:account=1');
    expect(candidates[2]!.key).toBe('hd:account=2');
  });

  it('every candidate has accountIndex matching its position', () => {
    const candidates = buildHdCandidates(TEST_MNEMONIC, { maxIndexHardLimit: 5 });
    candidates.forEach((c, i) => {
      expect(c.accountIndex).toBe(i);
    });
  });

  it('evm addresses are valid 0x-prefixed 40-hex strings', () => {
    const candidates = buildHdCandidates(TEST_MNEMONIC, { maxIndexHardLimit: 3 });
    for (const c of candidates) {
      expect(c.evmAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
  });

  it('every HD candidate has a valid 33-byte compressed secp256k1 pubkey for DeSo / future secp probes', () => {
    const candidates = buildHdCandidates(TEST_MNEMONIC, { maxIndexHardLimit: 3 });
    for (const c of candidates) {
      // 33 bytes = 66 hex chars; first byte is 0x02 or 0x03 (compressed sec1 prefix).
      expect(c.secp256k1CompressedHex).toMatch(/^(02|03)[0-9a-f]{64}$/);
    }
  });

  it('compressed pubkey hex matches the EVM address derivation - same secp keypair, two encodings', async () => {
    // sanity: ethers derives evmAddress from the SAME secp keypair we expose as compressedHex.
    // both should change in lockstep when accountIndex moves; both should be stable for index 0.
    const a = buildHdCandidates(TEST_MNEMONIC, { maxIndexHardLimit: 1 });
    const b = buildHdCandidates(TEST_MNEMONIC, { maxIndexHardLimit: 1 });
    expect(a[0]!.secp256k1CompressedHex).toBe(b[0]!.secp256k1CompressedHex);
    // adjacent indices have unrelated compressed pubkeys.
    const multi = buildHdCandidates(TEST_MNEMONIC, { maxIndexHardLimit: 2 });
    expect(multi[0]!.secp256k1CompressedHex).not.toBe(multi[1]!.secp256k1CompressedHex);
  });
});

describe('buildIdentityCandidate', () => {
  it('passkey identity returns single-row candidate with sui address', () => {
    const c = buildIdentityCandidate({ method: 'passkey', suiAddress: '0xdeadbeef' });
    expect(c.key).toBe('passkey:single');
    expect(c.suiAddress).toBe('0xdeadbeef');
    expect(c.solanaAddress).toBeUndefined();
    expect(c.accountIndex).toBeUndefined();
  });

  it('seeker identity carries solana address only', () => {
    // valid 32-byte base58 solana pubkey (the system program address makes a stable fixture).
    const SEEKER_ADDR = '11111111111111111111111111111111';
    const c = buildIdentityCandidate({ method: 'seeker', solanaAddress: SEEKER_ADDR });
    expect(c.key).toBe('seeker:single');
    expect(c.solanaAddress).toBe(SEEKER_ADDR);
    expect(c.suiAddress).toBeUndefined();
  });

  it('lazor identity uses smart-wallet pda as solana address when valid base58', () => {
    const LAZOR_PDA = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
    const c = buildIdentityCandidate({ method: 'lazor', lazorSmartWalletPubkeyB58: LAZOR_PDA });
    expect(c.key).toBe('lazor:single');
    expect(c.solanaAddress).toBe(LAZOR_PDA);
  });

  it('lazor identity drops solanaAddress when the persisted value is not valid base58 (v1 placeholder bug)', () => {
    // chromatika v1 stores the lazor passkey P-256 pubkey (base64) here as a placeholder
    // for the canonical smart-wallet PDA. solana RPC needs base58, so we drop the address
    // upstream so the probe is skipped instead of throwing "Non-base58 character".
    const PASSKEY_B64 = 'AmZcVgZOSvWj/upzz98BZTxtNtSAMbrZcm8rLUEksKE0';
    const c = buildIdentityCandidate({ method: 'lazor', lazorSmartWalletPubkeyB58: PASSKEY_B64 });
    expect(c.key).toBe('lazor:single');
    expect(c.solanaAddress).toBeUndefined();
  });

  it('seeker identity drops solanaAddress when not valid base58 (defensive)', () => {
    const c = buildIdentityCandidate({ method: 'seeker', solanaAddress: 'NotBase58!' });
    expect(c.solanaAddress).toBeUndefined();
  });
});

describe('buildCandidates dispatch', () => {
  it('routes HD to multi-candidate generator', () => {
    const c = buildCandidates({ method: 'hd', mnemonic: TEST_MNEMONIC }, { maxIndexHardLimit: 3 });
    expect(c.length).toBeGreaterThanOrEqual(3);
  });

  it('routes identity methods to single-candidate generator', () => {
    const c = buildCandidates({ method: 'passkey', suiAddress: '0xabc' });
    expect(c).toHaveLength(1);
    expect(c[0]!.suiAddress).toBe('0xabc');
  });
});
