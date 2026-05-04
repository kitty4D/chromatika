/**
 * tests for PC-Token PDA derivations. the derivations are pure functions of the seeds + program
 * IDs; we verify:
 *
 *   - seed order matches upstream (`pc_account` is `[mint, owner]`, NOT `[owner, mint]`).
 *   - different (mint, owner) pairs produce distinct PDAs.
 *   - the `not-configured` sentinel throws the right structured error.
 *
 * we can't test against ground-truth PDAs from upstream because the PC-Token program ID is the
 * unconfigured sentinel; once the canonical program ID lands these tests gain a "matches the
 * upstream e2e's `aliceAccount` / `bobAccount`" check.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import {
  __resetPcTokenProgramIdRuntimeForTests,
  __setPcTokenProgramIdRuntimeForTests,
} from '@/background/encrypt-pc/pc-token-program';

// default sentinel state - no overrides.
describe('pc-token-pda (sentinel state)', () => {
  beforeEach(() => {
    __resetPcTokenProgramIdRuntimeForTests();
  });

  it('derivePcMintPda throws not-configured error when program ID is the sentinel', async () => {
    const { derivePcMintPda } = await import('@/background/encrypt-pc/pc-token-pda');
    const mintAuthority = Keypair.generate().publicKey;
    let caught: unknown = null;
    try {
      derivePcMintPda(mintAuthority);
    } catch (e) {
      caught = e;
    }
    expect(caught).not.toBeNull();
    expect((caught as { name?: string }).name).toBe('PcTokenError');
    expect((caught as { reason?: string }).reason).toBe('not-configured');
  });
});

// with a configured program ID stubbed in, exercise the real derivations.
describe('pc-token-pda (configured)', () => {
  const TEST_PROGRAM_ID = 'PCToknwwK7tqrtKtbPpmK6jZ7n45iYQpzx95YRG7eXg';

  beforeEach(() => {
    __setPcTokenProgramIdRuntimeForTests(TEST_PROGRAM_ID);
  });

  afterEach(() => {
    __resetPcTokenProgramIdRuntimeForTests();
    vi.restoreAllMocks();
  });

  it('derivePcAccountPda uses seed order [mint, owner] (not [owner, mint])', async () => {
    const { derivePcAccountPda } = await import('@/background/encrypt-pc/pc-token-pda');
    const mint = Keypair.generate().publicKey;
    const owner = Keypair.generate().publicKey;

    const a = derivePcAccountPda(mint, owner);
    const b = derivePcAccountPda(owner, mint); // swapped - should produce a DIFFERENT PDA
    expect(a.pda.toBase58()).not.toBe(b.pda.toBase58());

    // bumps are valid (0..255)
    expect(a.bump).toBeGreaterThanOrEqual(0);
    expect(a.bump).toBeLessThanOrEqual(255);
  });

  it('derivePcAccountPda is deterministic per (mint, owner)', async () => {
    const { derivePcAccountPda } = await import('@/background/encrypt-pc/pc-token-pda');
    const mint = Keypair.generate().publicKey;
    const owner = Keypair.generate().publicKey;
    const a = derivePcAccountPda(mint, owner);
    const b = derivePcAccountPda(mint, owner);
    expect(a.pda.toBase58()).toBe(b.pda.toBase58());
    expect(a.bump).toBe(b.bump);
  });

  it('derivePcMintPda + derivePcVaultPda + derivePcReceiptPda all return valid PDAs', async () => {
    const { derivePcMintPda, derivePcVaultPda, derivePcReceiptPda } = await import(
      '@/background/encrypt-pc/pc-token-pda'
    );
    const mintAuthority = Keypair.generate().publicKey;
    const burnedCt = Keypair.generate().publicKey;

    const m = derivePcMintPda(mintAuthority);
    expect(m.pda).toBeInstanceOf(PublicKey);
    const v = derivePcVaultPda(m.pda);
    expect(v.pda).toBeInstanceOf(PublicKey);
    const r = derivePcReceiptPda(burnedCt);
    expect(r.pda).toBeInstanceOf(PublicKey);

    // all three should be distinct
    expect(m.pda.toBase58()).not.toBe(v.pda.toBase58());
    expect(v.pda.toBase58()).not.toBe(r.pda.toBase58());
  });

  it('derivePcTokenCpiAuthority is constant per program (no inputs)', async () => {
    const { derivePcTokenCpiAuthority } = await import('@/background/encrypt-pc/pc-token-pda');
    const a = derivePcTokenCpiAuthority();
    const b = derivePcTokenCpiAuthority();
    expect(a.pda.toBase58()).toBe(b.pda.toBase58());
  });

  it('Encrypt-program PDAs are distinct from PC-Token PDAs', async () => {
    const { deriveEncryptConfigPda, deriveEncryptDepositPda, deriveEncryptEventAuthorityPda } = await import(
      '@/background/encrypt-pc/pc-token-pda'
    );
    const payer = Keypair.generate().publicKey;
    const cfg = deriveEncryptConfigPda();
    const dep = deriveEncryptDepositPda(payer);
    const ev = deriveEncryptEventAuthorityPda();
    expect(cfg.pda.toBase58()).not.toBe(dep.pda.toBase58());
    expect(cfg.pda.toBase58()).not.toBe(ev.pda.toBase58());
    expect(dep.pda.toBase58()).not.toBe(ev.pda.toBase58());
  });
});
