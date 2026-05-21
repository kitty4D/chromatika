/**
 * Unit tests for the Solana tx classifier. Pure function over a parsed-tx shape.
 */

import { describe, it, expect } from 'vitest';
import {
  classifySolanaTx,
  SOLANA_PROGRAM_IDS,
  type ParsedTxLite,
} from './solana-classifier';

function makeParsedTx(
  instructions: Array<{
    programId: string;
    parsed?: { type?: string; info?: Record<string, unknown> };
    data?: string;
  }>,
): ParsedTxLite {
  return {
    transaction: {
      message: {
        instructions: instructions.map((ix) => ({
          programId: ix.programId,
          parsed: ix.parsed ?? null,
          data: ix.data,
        })),
      },
    },
  };
}

describe('classifySolanaTx', () => {
  it('returns transfer for a System Program transfer ix', () => {
    const parsed = makeParsedTx([
      {
        programId: SOLANA_PROGRAM_IDS.SYSTEM,
        parsed: { type: 'transfer', info: { lamports: 1000000 } },
      },
    ]);
    const r = classifySolanaTx(parsed);
    expect(r.kind).toBe('transfer');
    expect(r.memo).toBeNull();
  });

  it('returns transfer for an SPL Token transfer ix', () => {
    const parsed = makeParsedTx([
      {
        programId: SOLANA_PROGRAM_IDS.TOKEN,
        parsed: { type: 'transfer', info: { amount: '100000' } },
      },
    ]);
    const r = classifySolanaTx(parsed);
    expect(r.kind).toBe('transfer');
  });

  it('returns transfer for an SPL Token transferChecked ix', () => {
    const parsed = makeParsedTx([
      {
        programId: SOLANA_PROGRAM_IDS.TOKEN,
        parsed: { type: 'transferChecked', info: {} },
      },
    ]);
    const r = classifySolanaTx(parsed);
    expect(r.kind).toBe('transfer');
  });

  it('returns swap when Jupiter v6 program is invoked', () => {
    const parsed = makeParsedTx([
      { programId: SOLANA_PROGRAM_IDS.JUPITER_V6 },
    ]);
    const r = classifySolanaTx(parsed);
    expect(r.kind).toBe('swap');
  });

  it('returns swap when Raydium AMM v4 is invoked', () => {
    const parsed = makeParsedTx([
      { programId: SOLANA_PROGRAM_IDS.RAYDIUM_AMM_V4 },
    ]);
    const r = classifySolanaTx(parsed);
    expect(r.kind).toBe('swap');
  });

  it('returns swap when both a swap program AND a transfer ix are present (swap wins)', () => {
    const parsed = makeParsedTx([
      { programId: SOLANA_PROGRAM_IDS.SYSTEM, parsed: { type: 'transfer' } },
      { programId: SOLANA_PROGRAM_IDS.JUPITER_V6 },
    ]);
    const r = classifySolanaTx(parsed);
    expect(r.kind).toBe('swap');
  });

  it('extracts memo from Memo v2 program data', () => {
    const parsed = makeParsedTx([
      { programId: SOLANA_PROGRAM_IDS.MEMO_V2, data: 'for coffee' },
    ]);
    const r = classifySolanaTx(parsed);
    expect(r.memo).toBe('for coffee');
  });

  it('returns stakeDelegate when Stake program is invoked', () => {
    const parsed = makeParsedTx([
      { programId: SOLANA_PROGRAM_IDS.STAKE },
    ]);
    const r = classifySolanaTx(parsed);
    expect(r.kind).toBe('stakeDelegate');
  });

  it('returns smartContractCall when only an unknown program is touched', () => {
    const parsed = makeParsedTx([
      { programId: 'SomeUnknownProgramId11111111111111111111111' },
    ]);
    const r = classifySolanaTx(parsed);
    expect(r.kind).toBe('smartContractCall');
  });

  it('returns unknown when the tx has no instructions', () => {
    const parsed = makeParsedTx([]);
    const r = classifySolanaTx(parsed);
    expect(r.kind).toBe('unknown');
  });
});
