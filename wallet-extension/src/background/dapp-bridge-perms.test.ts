import { describe, it, expect } from 'vitest';
import { parseWalletPermissionObjectKeys } from '@/background/dapp-bridge';

describe('parseWalletPermissionObjectKeys', () => {
  it('returns keys from wallet permission object', () => {
    expect(parseWalletPermissionObjectKeys([{ eth_accounts: {}, solana: {} }])).toEqual(['eth_accounts', 'solana']);
  });

  it('returns empty when first param is not a plain object', () => {
    expect(parseWalletPermissionObjectKeys([['eth_accounts']])).toEqual([]);
    expect(parseWalletPermissionObjectKeys(undefined)).toEqual([]);
  });
});
