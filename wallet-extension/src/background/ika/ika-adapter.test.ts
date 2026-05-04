import { describe, it, expect } from 'vitest';
import { getIkaAdapter } from '@/background/ika/ika-adapter';
import type { SessionState } from '@/background/session';

describe('getIkaAdapter', () => {
  it('returns Solana adapter with empty caps list for discovery stubs', async () => {
    const session = {
      ikaClient: {},
      solanaIkaGrpc: {},
      solanaConnection: undefined,
    } as unknown as SessionState;
    const a = getIkaAdapter(session, 'solana');
    expect(a.baseChain).toBe('solana');
    const caps = await a.getOwnedDWalletCaps('SomeOwner', null, 10);
    expect(caps.dWalletCaps).toEqual([]);
    expect(caps.hasNextPage).toBe(false);
  });

  it('Solana adapter throws on Sui-only presign reads', () => {
    const session = {
      ikaClient: {},
      solanaIkaGrpc: {},
    } as unknown as SessionState;
    const a = getIkaAdapter(session, 'solana');
    expect(() => a.getPresignInParticularState('x', 'Completed')).toThrow(/Sui ika PTB/);
  });
});
