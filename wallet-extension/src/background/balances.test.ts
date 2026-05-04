import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getTrpcBalanceSummary } from '@/background/balances';
import * as session from '@/background/session';
import { getVaultNetworkSettings } from '@/background/network/tier-network-settings';

vi.mock('@/background/session', () => ({
  getSession: vi.fn(),
}));

vi.mock('@/background/network/tier-network-settings', () => ({
  getVaultNetworkSettings: vi.fn().mockResolvedValue({
    suiNetworkId: 'sui-mainnet',
    solana: {
      solNetworkId: 'sol-devnet',
      customRpcUrl: null,
      priorityFeeMicroLamportsPerCu: 0,
      commitment: 'confirmed',
      maxRetries: 3,
      skipPreflight: false,
    },
  }),
}));

describe('getTrpcBalanceSummary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns solana pre-alpha fields when ika base is solana', async () => {
    vi.spyOn(session, 'getSession').mockReturnValue({
      activeVaultId: 'vault-1',
      activeVaultBaseChain: 'solana',
      network: 'testnet',
      solanaFeePayer: {
        publicKey: { toBase58: () => 'So11111111111111111111111111111111111111112' },
      },
      solanaConnection: {
        getBalance: vi.fn().mockResolvedValue(1_500_000),
      },
    } as never);

    const r = await getTrpcBalanceSummary();
    expect(r).toMatchObject({
      locked: false,
      ikaBase: 'solana',
      solanaNetworkId: 'sol-devnet',
      solanaLamports: '1500000',
      solanaPreAlpha: true,
      feePayerAddress: 'So11111111111111111111111111111111111111112',
      funding: { ready: true },
    });
    if (r.locked === false && r.ikaBase === 'solana') {
      expect(r.solanaRpcUrl).toContain('devnet');
    }
    expect(getVaultNetworkSettings).toHaveBeenCalled();
  });

  it('sets solanaRpcMissing when connection absent', async () => {
    vi.spyOn(session, 'getSession').mockReturnValue({
      activeVaultId: 'vault-1',
      activeVaultBaseChain: 'solana',
      network: 'testnet',
      solanaFeePayer: {
        publicKey: { toBase58: () => 'So11111111111111111111111111111111111111112' },
      },
    } as never);

    const r = await getTrpcBalanceSummary();
    expect(r).toMatchObject({
      locked: false,
      ikaBase: 'solana',
      solanaRpcMissing: true,
      solanaLamports: '0',
    });
  });
});
