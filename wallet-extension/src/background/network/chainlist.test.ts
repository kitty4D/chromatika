import { describe, expect, it } from 'vitest';
import { scoreChainlistMatch } from './chainlist';

describe('scoreChainlistMatch', () => {
  it('ranks exact name above substring matches like chainlink', () => {
    const ink = {
      chainId: 57073,
      name: 'Ink',
      shortName: 'ink',
      rpc: ['https://x'],
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    };
    const chainlink = {
      chainId: 1,
      name: 'Chainlink',
      rpc: [],
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    };
    expect(scoreChainlistMatch(ink, 'ink')).toBeGreaterThan(scoreChainlistMatch(chainlink, 'ink'));
  });

  it('matches shortName when name does not contain the query as a word', () => {
    const c = {
      chainId: 1,
      name: 'Some Network',
      shortName: 'ink',
      rpc: [],
      nativeCurrency: { name: 'X', symbol: 'X', decimals: 18 },
    };
    expect(scoreChainlistMatch(c, 'ink')).toBeGreaterThan(0);
  });
});
