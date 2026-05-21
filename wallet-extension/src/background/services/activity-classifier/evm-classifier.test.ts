/**
 * Unit tests for the EVM tx classifier. The classifier is a pure function over an
 * IndexedTx + optional hints, so these tests don't need any chain wiring or mocking -
 * we hand it shaped rows and verify the kind/swapMeta outputs.
 */

import { describe, it, expect } from 'vitest';
import { classifyEvmTx } from './evm-classifier';
import type { IndexedTx } from '@/background/services/activity-index';

/** factory for a baseline IndexedTx; tests override only the fields they care about. */
function makeRow(overrides: Partial<IndexedTx> = {}): IndexedTx {
  return {
    key: 'evm:vault1:0xabc',
    vaultId: 'vault1',
    chain: 'evm',
    digest: '0xabc',
    perspectiveAddress: '0xowner',
    counterparty: '0xrecipient',
    position: '12345',
    timestampMs: 1234567890,
    symbol: 'USDC',
    amountRaw: '100000000',
    source: 'alchemy:eth-1',
    status: 'success',
    ...overrides,
  };
}

describe('classifyEvmTx', () => {
  it('returns transfer kind for a vanilla ERC-20 row with no DEX router match', () => {
    const row = makeRow({ counterparty: '0x9999999999999999999999999999999999999999' });
    const r = classifyEvmTx(row, { alchemyCategory: 'erc20' });
    expect(r.kind).toBe('transfer');
  });

  it('returns transfer kind for native ETH transfer', () => {
    const row = makeRow({ counterparty: '0x9999999999999999999999999999999999999999', symbol: 'ETH' });
    const r = classifyEvmTx(row, { alchemyCategory: 'external' });
    expect(r.kind).toBe('transfer');
  });

  it('returns transferNFT when Alchemy category is erc721', () => {
    const row = makeRow({ symbol: 'BAYC', amountRaw: '1' });
    const r = classifyEvmTx(row, { alchemyCategory: 'erc721' });
    expect(r.kind).toBe('transferNFT');
  });

  it('returns transferNFT when Alchemy category is erc1155', () => {
    const row = makeRow({ symbol: 'OPENSEA-COLLECTIBLE', amountRaw: '3' });
    const r = classifyEvmTx(row, { alchemyCategory: 'erc1155' });
    expect(r.kind).toBe('transferNFT');
  });

  it('returns swap kind when counterparty matches Uniswap V2 router on mainnet', () => {
    const row = makeRow({
      counterparty: '0x7a250d5630b4cf539739df2c5dacb4c659f2488d',
      source: 'alchemy:eth-1',
    });
    const r = classifyEvmTx(row, { alchemyCategory: 'external' });
    expect(r.kind).toBe('swap');
  });

  it('returns swap kind when counterparty matches 1inch v5 router (mainnet)', () => {
    const row = makeRow({
      counterparty: '0x1111111254eeb25477b68fb85ed929f73a960582',
      source: 'alchemy:eth-1',
    });
    const r = classifyEvmTx(row, { alchemyCategory: 'external' });
    expect(r.kind).toBe('swap');
  });

  it('returns transfer (not swap) when same router address but different chain', () => {
    const row = makeRow({
      counterparty: '0x7a250d5630b4cf539739df2c5dacb4c659f2488d', // Uniswap V2 on mainnet
      source: 'alchemy:eth-999', // unknown chain
    });
    const r = classifyEvmTx(row, { alchemyCategory: 'external' });
    expect(r.kind).toBe('transfer');
  });

  it('prefers NFT category over swap router match (so NFT marketplace trades classify as NFT transfer)', () => {
    const row = makeRow({
      counterparty: '0x7a250d5630b4cf539739df2c5dacb4c659f2488d', // would be swap...
      source: 'alchemy:eth-1',
    });
    const r = classifyEvmTx(row, { alchemyCategory: 'erc721' }); // ...but NFT trumps
    expect(r.kind).toBe('transferNFT');
  });

  it('handles missing hints (falls back to transfer)', () => {
    const row = makeRow({ counterparty: '0x9999999999999999999999999999999999999999' });
    const r = classifyEvmTx(row);
    expect(r.kind).toBe('transfer');
  });

  it('case-insensitive router match', () => {
    const row = makeRow({
      // mixed-case checksum address; classifier should normalize.
      counterparty: '0x7A250d5630B4cF539739dF2C5dAcb4c659F2488D',
      source: 'alchemy:eth-1',
    });
    const r = classifyEvmTx(row, { alchemyCategory: 'external' });
    expect(r.kind).toBe('swap');
  });
});
