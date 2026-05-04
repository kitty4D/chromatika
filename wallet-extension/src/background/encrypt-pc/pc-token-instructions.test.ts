/**
 * tests for PC-Token instruction builders. we verify:
 *
 *   - each ix has the correct discriminator at byte 0.
 *   - required signers + writable flags match the upstream e2e.
 *   - account list ordering is positional (the program reads them by index).
 *   - the 9-account encryptCpiAccounts suffix is appended to FHE-using instructions.
 *
 * tests run against the stubbed `PC_TOKEN_PROGRAM_ID_B58` constant; once the canonical program ID
 * lands these tests double as regression coverage if upstream changes the discriminator table.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Keypair, PublicKey, type AccountMeta } from '@solana/web3.js';
import {
  PC_TOKEN_IX,
  __resetPcTokenProgramIdRuntimeForTests,
  __setPcTokenProgramIdRuntimeForTests,
} from '@/background/encrypt-pc/pc-token-program';

const TEST_PROGRAM_ID = 'PCToknwwK7tqrtKtbPpmK6jZ7n45iYQpzx95YRG7eXg';

beforeEach(() => {
  __setPcTokenProgramIdRuntimeForTests(TEST_PROGRAM_ID);
});

afterEach(() => {
  __resetPcTokenProgramIdRuntimeForTests();
  vi.restoreAllMocks();
});

const mockNetworkKey = new Uint8Array(32).fill(0x55);

describe('pc-token-instructions', () => {
  it('Wrap (disc 30) has the right discriminator + 10-byte data layout', async () => {
    const { buildWrapIx } = await import('@/background/encrypt-pc/pc-token-instructions');
    const owner = Keypair.generate().publicKey;
    const ix = buildWrapIx({
      vaultPda: Keypair.generate().publicKey,
      tokenAccountPda: Keypair.generate().publicKey,
      userAta: Keypair.generate().publicKey,
      vaultAta: Keypair.generate().publicKey,
      balanceCt: Keypair.generate().publicKey,
      amountCt: Keypair.generate().publicKey,
      owner,
      payer: owner,
      amountPlaintext: 100_000_000n,
      networkKey32: mockNetworkKey,
    });
    expect(ix.programId.toBase58()).toBe(TEST_PROGRAM_ID);
    expect(ix.data[0]).toBe(PC_TOKEN_IX.Wrap);
    expect(ix.data.length).toBe(10);
    // last 8 bytes of data should be the u64 LE plaintext amount (100_000_000)
    let amount = 0n;
    for (let i = 9; i >= 2; i--) {
      amount = (amount << 8n) | BigInt(ix.data[i]!);
    }
    expect(amount).toBe(100_000_000n);
  });

  it('Transfer (disc 3) has 6 PC-specific accounts + 9 cpi accounts and owner is the only signer in PC accounts', async () => {
    const { buildTransferIx } = await import('@/background/encrypt-pc/pc-token-instructions');
    const owner = Keypair.generate().publicKey;
    const ix = buildTransferIx({
      fromAccountPda: Keypair.generate().publicKey,
      toAccountPda: Keypair.generate().publicKey,
      fromBalanceCt: Keypair.generate().publicKey,
      toBalanceCt: Keypair.generate().publicKey,
      amountCt: Keypair.generate().publicKey,
      owner,
      payer: owner,
      networkKey32: mockNetworkKey,
    });
    expect(ix.data[0]).toBe(PC_TOKEN_IX.Transfer);
    expect(ix.data.length).toBe(2);
    expect(ix.keys.length).toBe(6 + 9); // 6 PC accounts + 9 CPI suffix
    // owner at index 5 of the PC accounts is the only PC-section signer
    const pcAccounts = ix.keys.slice(0, 6);
    const signerCount = pcAccounts.filter((m) => m.isSigner).length;
    expect(signerCount).toBe(1);
    expect(pcAccounts[5]!.pubkey.toBase58()).toBe(owner.toBase58());
    expect(pcAccounts[5]!.isSigner).toBe(true);
  });

  it('InitializeAccount (disc 1) requires balanceCt as a signer', async () => {
    const { buildInitializeAccountIx } = await import(
      '@/background/encrypt-pc/pc-token-instructions'
    );
    const owner = Keypair.generate().publicKey;
    const balanceCt = Keypair.generate().publicKey;
    const ix = buildInitializeAccountIx({
      pcMint: Keypair.generate().publicKey,
      owner,
      payer: owner,
      balanceCt,
      networkKey32: mockNetworkKey,
    });
    expect(ix.data[0]).toBe(PC_TOKEN_IX.InitializeAccount);
    expect(ix.data.length).toBe(3);
    // balanceCt is at index 3 and must be a signer + writable
    const balanceCtMeta: AccountMeta = ix.keys[3]!;
    expect(balanceCtMeta.pubkey.toBase58()).toBe(balanceCt.toBase58());
    expect(balanceCtMeta.isSigner).toBe(true);
    expect(balanceCtMeta.isWritable).toBe(true);
  });

  it('UnwrapBurn (disc 31) has 11-byte data layout with 8-byte LE amount tail', async () => {
    const { buildUnwrapBurnIx } = await import('@/background/encrypt-pc/pc-token-instructions');
    const owner = Keypair.generate().publicKey;
    const ix = buildUnwrapBurnIx({
      vaultPda: Keypair.generate().publicKey,
      tokenAccountPda: Keypair.generate().publicKey,
      balanceCt: Keypair.generate().publicKey,
      amountCt: Keypair.generate().publicKey,
      burnedCt: Keypair.generate().publicKey,
      owner,
      payer: owner,
      amountPlaintext: 25n,
      networkKey32: mockNetworkKey,
    });
    expect(ix.data[0]).toBe(PC_TOKEN_IX.UnwrapBurn);
    expect(ix.data.length).toBe(11);
    let amount = 0n;
    for (let i = 10; i >= 3; i--) {
      amount = (amount << 8n) | BigInt(ix.data[i]!);
    }
    expect(amount).toBe(25n);
  });

  it('UnwrapDecrypt (disc 32) requires requestAcct as a signer + non-writable configPda in CPI', async () => {
    const { buildUnwrapDecryptIx } = await import('@/background/encrypt-pc/pc-token-instructions');
    const owner = Keypair.generate().publicKey;
    const requestAcct = Keypair.generate().publicKey;
    const ix = buildUnwrapDecryptIx({
      receiptPda: Keypair.generate().publicKey,
      requestAcct,
      burnedCt: Keypair.generate().publicKey,
      owner,
      payer: owner,
      networkKey32: mockNetworkKey,
    });
    expect(ix.data[0]).toBe(PC_TOKEN_IX.UnwrapDecrypt);
    // requestAcct at index 1 of PC accounts is signer + writable
    expect(ix.keys[1]!.pubkey.toBase58()).toBe(requestAcct.toBase58());
    expect(ix.keys[1]!.isSigner).toBe(true);
    expect(ix.keys[1]!.isWritable).toBe(true);
    // configPda is the 2nd item of the CPI suffix (index 4 from the end of pc accounts).
    // PC accounts are 4 items here: receiptPda, requestAcct, burnedCt, owner.
    // then encryptCpiAccounts starts at index 4: [encryptProgram, configPda, depositPda, ...].
    expect(ix.keys.length).toBe(4 + 9);
    expect(ix.keys[5]!.isWritable).toBe(false); // configPda forced non-writable for UnwrapDecrypt
  });

  it('UnwrapComplete (disc 33) is 1-byte data + 9 PC accounts, no CPI suffix', async () => {
    const { buildUnwrapCompleteIx } = await import('@/background/encrypt-pc/pc-token-instructions');
    const owner = Keypair.generate().publicKey;
    const ix = buildUnwrapCompleteIx({
      receiptPda: Keypair.generate().publicKey,
      vaultPda: Keypair.generate().publicKey,
      pcMint: Keypair.generate().publicKey,
      requestAcct: Keypair.generate().publicKey,
      vaultAta: Keypair.generate().publicKey,
      userAta: Keypair.generate().publicKey,
      owner,
      destination: owner,
    });
    expect(ix.data[0]).toBe(PC_TOKEN_IX.UnwrapComplete);
    expect(ix.data.length).toBe(1);
    expect(ix.keys.length).toBe(9); // 8 pc accounts + spl token program
    expect(ix.keys[6]!.pubkey.toBase58()).toBe(owner.toBase58());
    expect(ix.keys[6]!.isSigner).toBe(true);
  });

  it('CPI suffix has 9 accounts in the spec order', async () => {
    const { buildEncryptCpiSuffix } = await import('@/background/encrypt-pc/pc-token-cpi');
    const payer = Keypair.generate().publicKey;
    const { metas } = buildEncryptCpiSuffix(payer, mockNetworkKey);
    expect(metas.length).toBe(9);
    // index 6 = payer, signer + writable
    expect(metas[6]!.pubkey.toBase58()).toBe(payer.toBase58());
    expect(metas[6]!.isSigner).toBe(true);
    expect(metas[6]!.isWritable).toBe(true);
    // index 8 = SystemProgram
    expect(metas[8]!.pubkey).toBeInstanceOf(PublicKey);
  });
});
