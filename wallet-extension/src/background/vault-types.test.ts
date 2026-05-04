import { describe, it, expect } from 'vitest';
import {
  assertVaultPayload,
  parseAndMigrateVaultPayload,
  type VaultPayloadV3,
} from '@/background/vault-types';

describe('parseAndMigrateVaultPayload', () => {
  it('migrates v2 payload to v3', () => {
    const json = JSON.stringify({
      v: 2,
      activeVaultId: 'vid',
      vaults: [
        {
          id: 'vid',
          label: 'default',
          baseChain: 'sui',
          network: 'mainnet',
          accountKind: 'hd',
          mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
          ikaShareKeysB64: {},
          dwalletMeta: {},
          createdAtMs: 1,
        },
      ],
    });
    const p = parseAndMigrateVaultPayload(json);
    expect(p.v).toBe(3);
    expect(p.vaults).toHaveLength(1);
    expect(p.vaults[0]!.accountKind).toBe('hd');
    expect((p.vaults[0] as { mnemonic: string }).mnemonic).toContain('abandon');
  });

  it('passes through v3', () => {
    const json = JSON.stringify({
      v: 3,
      activeVaultId: 'a',
      vaults: [
        {
          id: 'a',
          label: 'x',
          baseChain: 'sui',
          network: 'mainnet',
          accountKind: 'importedKey',
          suiPrivateKeyBech32: 'suiprivkey1invalidfortest',
          ikaShareKeysB64: {},
          dwalletMeta: {},
          createdAtMs: 1,
        },
      ],
    });
    expect(() => parseAndMigrateVaultPayload(json)).not.toThrow();
  });

  it('round-trips a hardware vault with the walletconnect block', () => {
    // the encrypt -> decrypt path is covered by `vault.test.ts`; here we just verify the
    // structural parse passes through. the WC fields nest under `walletconnect` so a future
    // discriminated-union refactor can split them out without forcing a migration on the blob.
    const json = JSON.stringify({
      v: 3,
      activeVaultId: 'wc-vault',
      vaults: [
        {
          id: 'wc-vault',
          label: 'WC Solana',
          baseChain: 'solana',
          network: 'mainnet',
          accountKind: 'hardware',
          hardwareAccountId: 'walletconnect-1234567890',
          ledgerFeePayerSolPubkeyB58: '11111111111111111111111111111111',
          ikaGrpcFeePayerSolSecretKeyB64: 'AA'.repeat(32) + '==',
          walletconnect: {
            sessionTopic: 'a'.repeat(64),
            accountAddress: '11111111111111111111111111111111',
            chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
            pairedAtEpochMs: 1_700_000_000_000,
          },
          ikaShareKeysB64: { SECP256K1: 'AAA=', ED25519: 'BBB=' },
          dwalletMeta: {},
          createdAtMs: 1,
        },
      ],
    });
    const p = parseAndMigrateVaultPayload(json);
    expect(p.v).toBe(3);
    expect(p.vaults).toHaveLength(1);
    const v = p.vaults[0]!;
    expect(v.accountKind).toBe('hardware');
    expect((v as { walletconnect?: unknown }).walletconnect).toMatchObject({
      sessionTopic: 'a'.repeat(64),
      accountAddress: '11111111111111111111111111111111',
      chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
      pairedAtEpochMs: 1_700_000_000_000,
    });
    // no MWA fields are present alongside WC - the two transports are mutually exclusive.
    expect((v as { mwaTransport?: unknown }).mwaTransport).toBeUndefined();
    expect((v as { mwaAuthToken?: unknown }).mwaAuthToken).toBeUndefined();
    expect(() => assertVaultPayload(p)).not.toThrow();
  });

  it('rejects v3 payloads that still contain zkLogin vaults', () => {
    const p = {
      v: 3 as const,
      activeVaultId: 'x',
      vaults: [
        {
          id: 'x',
          label: 'z',
          baseChain: 'sui' as const,
          network: 'mainnet' as const,
          accountKind: 'zklogin',
          zkLoginSuiAddress: '0x1',
          suiPrivateKeyBech32: 'suiprivkey1invalidfortest',
          ikaShareKeysB64: {},
          dwalletMeta: {},
          createdAtMs: 1,
        },
      ],
    } as unknown as VaultPayloadV3;
    expect(() => assertVaultPayload(p)).toThrow(/zkLogin vaults are no longer supported/i);
  });
});
