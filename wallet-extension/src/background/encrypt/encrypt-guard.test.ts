import { describe, it, expect, vi, afterEach } from 'vitest';
import { assertEncryptSolanaIkaBase, isEncryptAllowedForSession } from '@/background/encrypt/encrypt-guard';
import * as sessionMod from '@/background/session';
import type { SessionState } from '@/background/session';

function partialSession(overrides: Partial<SessionState>): SessionState {
  return {
    activeVaultId: 'v1',
    activeVaultLabel: 't',
    activeVaultBaseChain: 'solana',
    vaultKey: {} as SessionState['vaultKey'],
    vaultKdfMeta: {} as SessionState['vaultKdfMeta'],
    accountKind: 'hd',
    mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
    network: 'mainnet',
    suiKeypair: {} as SessionState['suiKeypair'],
    vaultSuiClient: {} as SessionState['vaultSuiClient'],
    suiClient: {} as SessionState['suiClient'],
    dwalletSolanaConnection: {} as SessionState['dwalletSolanaConnection'],
    ikaClient: {} as SessionState['ikaClient'],
    ikaShareKeys: {} as SessionState['ikaShareKeys'],
    ikaShareKeysB64: {},
    dwalletMeta: {},
    ...overrides,
  };
}

describe('encrypt-guard', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('assertEncryptSolanaIkaBase throws when locked', () => {
    vi.spyOn(sessionMod, 'getSession').mockReturnValue(null);
    expect(() => assertEncryptSolanaIkaBase()).toThrow(/Wallet locked/);
  });

  it('assertEncryptSolanaIkaBase throws on Sui ika-base session', () => {
    vi.spyOn(sessionMod, 'getSession').mockReturnValue(partialSession({ activeVaultBaseChain: 'sui' }));
    expect(() => assertEncryptSolanaIkaBase()).toThrow(/Encrypt lab/);
  });

  it('assertEncryptSolanaIkaBase passes on Solana ika-base session', () => {
    vi.spyOn(sessionMod, 'getSession').mockReturnValue(partialSession({ activeVaultBaseChain: 'solana' }));
    expect(() => assertEncryptSolanaIkaBase()).not.toThrow();
  });

  it('isEncryptAllowedForSession is false when locked or Sui base', () => {
    vi.spyOn(sessionMod, 'getSession').mockReturnValue(null);
    expect(isEncryptAllowedForSession()).toBe(false);
    vi.spyOn(sessionMod, 'getSession').mockReturnValue(partialSession({ activeVaultBaseChain: 'sui' }));
    expect(isEncryptAllowedForSession()).toBe(false);
    vi.spyOn(sessionMod, 'getSession').mockReturnValue(partialSession({ activeVaultBaseChain: 'solana' }));
    expect(isEncryptAllowedForSession()).toBe(true);
  });
});
