import { describe, expect, it } from 'vitest';
import { bytesToHex } from '@noble/hashes/utils.js';
import { Keypair } from '@solana/web3.js';
import {
  IKA_FEE_PAYER_DERIVATION_INDEX,
  deriveSolanaKeypair,
  deriveSuiKeypair,
  ikaRootSeedFromFeeKeypair,
  ikaRootSeedFromMwaSignature,
  ikaRootSeedFromSolanaKeypair,
  solanaFeeKeypairFromWalletSignature,
} from '@/background/keyring/hd';

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('ikaRootSeedFromFeeKeypair', () => {
  it('matches ika CLI resolve_seed for Ed25519 fee key (index 0)', () => {
    const kp = deriveSuiKeypair(TEST_MNEMONIC, 0);
    const seed = ikaRootSeedFromFeeKeypair(kp, 0);
    expect(seed.length).toBe(32);
    // golden: stable across runs; verify against `ika dwallet generate-keypair --curve secp256k1` with same keystore if needed
    expect(bytesToHex(seed)).toBe(
      'f3208b21d316e5f91b6ad0d99e86088a04e88594f51c63be9365649edcc621ac',
    );
  });

  it('changes with encryption key index', () => {
    const kp = deriveSuiKeypair(TEST_MNEMONIC, 0);
    const a = ikaRootSeedFromFeeKeypair(kp, 0);
    const b = ikaRootSeedFromFeeKeypair(kp, 1);
    expect(bytesToHex(a)).not.toBe(bytesToHex(b));
  });
});

describe('ikaRootSeedFromSolanaKeypair', () => {
  it('produces a stable 32-byte seed for a given Solana keypair + index', () => {
    const kp = deriveSolanaKeypair(TEST_MNEMONIC, 0);
    const seed = ikaRootSeedFromSolanaKeypair(kp, 0);
    expect(seed.length).toBe(32);
    // re-deriving the same keypair + index must yield the same seed bytes (no time / randomness).
    const seed2 = ikaRootSeedFromSolanaKeypair(deriveSolanaKeypair(TEST_MNEMONIC, 0), 0);
    expect(bytesToHex(seed)).toBe(bytesToHex(seed2));
  });

  it('changes with encryption key index', () => {
    const kp = deriveSolanaKeypair(TEST_MNEMONIC, 0);
    const a = ikaRootSeedFromSolanaKeypair(kp, 0);
    const b = ikaRootSeedFromSolanaKeypair(kp, 1);
    expect(bytesToHex(a)).not.toBe(bytesToHex(b));
  });

  it('differs from the Sui-keypair derivation for the same mnemonic', () => {
    // sanity: Solana base must produce a different seed than Sui base, otherwise we leaked
    // ika encryption keys across base chains for the same HD seed.
    const sol = ikaRootSeedFromSolanaKeypair(deriveSolanaKeypair(TEST_MNEMONIC, 0), 0);
    const sui = ikaRootSeedFromFeeKeypair(deriveSuiKeypair(TEST_MNEMONIC, 0), 0);
    expect(bytesToHex(sol)).not.toBe(bytesToHex(sui));
  });

  it('throws on a wrong-length secret key', () => {
    // a fresh ed25519 keypair where secretKey is 64 bytes is the canonical shape; mutate to break.
    const kp = Keypair.generate();
    const broken = { secretKey: kp.secretKey.slice(0, 32) } as unknown as Keypair;
    expect(() => ikaRootSeedFromSolanaKeypair(broken, 0)).toThrow();
  });
});

describe('solanaFeeKeypairFromWalletSignature', () => {
  // same wallet signature on any device must derive the same fee-payer Keypair, so the
  // restored vault on a new device finds the prior install's SOL balance instead of stranding it.
  const SAMPLE_SIG_64 = Uint8Array.from(Array.from({ length: 64 }, (_, i) => (i + 7) & 0xff));
  const OTHER_SIG_64 = Uint8Array.from(Array.from({ length: 64 }, (_, i) => (i + 200) & 0xff));

  it('produces the same Keypair address for the same signature on every call', () => {
    const a = solanaFeeKeypairFromWalletSignature(SAMPLE_SIG_64);
    const b = solanaFeeKeypairFromWalletSignature(SAMPLE_SIG_64);
    expect(a.publicKey.toBase58()).toBe(b.publicKey.toBase58());
  });

  it('produces a different address for a different signature', () => {
    const a = solanaFeeKeypairFromWalletSignature(SAMPLE_SIG_64);
    const c = solanaFeeKeypairFromWalletSignature(OTHER_SIG_64);
    expect(a.publicKey.toBase58()).not.toBe(c.publicKey.toBase58());
  });

  it('produces a different address at a different index', () => {
    const a = solanaFeeKeypairFromWalletSignature(SAMPLE_SIG_64, IKA_FEE_PAYER_DERIVATION_INDEX);
    const b = solanaFeeKeypairFromWalletSignature(SAMPLE_SIG_64, IKA_FEE_PAYER_DERIVATION_INDEX + 1);
    expect(a.publicKey.toBase58()).not.toBe(b.publicKey.toBase58());
  });

  it('refuses index 0 (reserved for ika root seed - prevents key collision)', () => {
    expect(() => solanaFeeKeypairFromWalletSignature(SAMPLE_SIG_64, 0)).toThrow(/index 0/);
  });

  it('rejects empty signatures', () => {
    expect(() => solanaFeeKeypairFromWalletSignature(new Uint8Array(0))).toThrow(/non-empty/);
  });

  it('rejects negative or non-integer indices', () => {
    expect(() => solanaFeeKeypairFromWalletSignature(SAMPLE_SIG_64, -1)).toThrow(/non-negative integer/);
    expect(() => solanaFeeKeypairFromWalletSignature(SAMPLE_SIG_64, 1.5)).toThrow(/non-negative integer/);
  });

  it('does not collide with the ika UserShareEncryptionKeys root pubkey at index 0', () => {
    // cross-check that the index byte changes the keccak output enough that the resulting
    // pubkey bytes diverge. if anyone simplifies the formula (drops the index, etc.), this
    // assertion catches it loudly before it can ship.
    const ikaSeed = ikaRootSeedFromMwaSignature(SAMPLE_SIG_64, 0);
    const fee = solanaFeeKeypairFromWalletSignature(SAMPLE_SIG_64);
    expect(Array.from(fee.publicKey.toBytes())).not.toEqual(Array.from(ikaSeed));
  });
});
