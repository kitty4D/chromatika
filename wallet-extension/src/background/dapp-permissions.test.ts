import { describe, expect, it } from 'vitest';
import { canAccessChain, canUseMethod, type DappPermissionRecord } from '@/background/dapp-permissions';

function mkPermission(overrides?: Partial<DappPermissionRecord>): DappPermissionRecord {
  return {
    grantedAt: Date.now(),
    updatedAt: Date.now(),
    scope: {
      accounts: true,
      chainIds: [],
      canSignPersonal: true,
      canSignTypedData: true,
      canSendTransaction: true,
      canAddChain: false,
      canSwitchChain: true,
    },
    ...overrides,
  };
}

describe('dapp permissions helpers', () => {
  it('allows unrestricted chain access when chainIds is empty', () => {
    const p = mkPermission();
    expect(canAccessChain(p, 1)).toBe(true);
    expect(canAccessChain(p, 8453)).toBe(true);
  });

  it('enforces chain allowlist when provided', () => {
    const p = mkPermission({ scope: { ...mkPermission().scope, chainIds: [1, 8453] } });
    expect(canAccessChain(p, 1)).toBe(true);
    expect(canAccessChain(p, 10)).toBe(false);
  });

  it('blocks signing and send methods when scopes are disabled', () => {
    const p = mkPermission({
      scope: {
        ...mkPermission().scope,
        canSignPersonal: false,
        canSignTypedData: false,
        canSendTransaction: false,
      },
    });
    expect(canUseMethod(p, 'personal_sign')).toBe(false);
    expect(canUseMethod(p, 'eth_signTypedData_v4')).toBe(false);
    expect(canUseMethod(p, 'eth_sendTransaction')).toBe(false);
  });
});
