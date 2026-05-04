import { describe, it, expect } from 'vitest';
import { assertNotSolanaBaseForSecpSigning } from '@/background/chains/signing-solana-guard';
import { IKA_SOLANA_SECP_SIGNING_IMPLEMENTED } from '@/background/ika/solana-secp-signing';
import type { SessionState } from '@/background/session';

function minimalSession(overrides: Partial<SessionState>): SessionState {
  return {
    activeVaultId: 'v1',
    activeVaultLabel: 't',
    activeVaultBaseChain: 'sui',
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

describe('assertNotSolanaBaseForSecpSigning', () => {
  it('does nothing when session is null', () => {
    expect(() => assertNotSolanaBaseForSecpSigning(null, 'evm')).not.toThrow();
  });

  it('does nothing when ika base is sui', () => {
    expect(() => assertNotSolanaBaseForSecpSigning(minimalSession({ activeVaultBaseChain: 'sui' }), 'evm')).not.toThrow();
  });

  it('evm + solana: throws only when Solana secp signing flag is off', () => {
    const fn = () => assertNotSolanaBaseForSecpSigning(minimalSession({ activeVaultBaseChain: 'solana' }), 'evm');
    if (IKA_SOLANA_SECP_SIGNING_IMPLEMENTED) expect(fn).not.toThrow();
    else expect(fn).toThrow(/EVM signing with ika Solana base is not wired/);
  });

  it('btc + solana: throws only when Solana secp signing flag is off', () => {
    const fn = () => assertNotSolanaBaseForSecpSigning(minimalSession({ activeVaultBaseChain: 'solana' }), 'btc');
    if (IKA_SOLANA_SECP_SIGNING_IMPLEMENTED) expect(fn).not.toThrow();
    else expect(fn).toThrow(/Bitcoin signing with ika Solana base is not wired/);
  });
});
