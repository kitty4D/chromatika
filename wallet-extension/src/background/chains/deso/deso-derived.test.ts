/**
 * unit tests for `deso-derived.ts` (the derived-key delegation primitives). we mock
 * `chrome.storage`, `getSession`, `getDwalletSecpPublicKey`, and the deso-node-client functions
 * the module calls into. pure logic stays observable: storage round-trips, input validation,
 * URL builder shape.
 *
 * reference: `wallet-extension/docs/DESO_DERIVED_KEY_SPIKE.md`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hexToBytes } from '@/background/chains/deso/deso-signature';
import { encodeDeSoAddress } from '@/background/chains/deso/deso-address';

// 33-byte compressed secp pubkey we use as the dWallet identity for these tests. hand-built so
// it is deterministic and can be re-encoded to a known BC1Y... address.
const DWALLET_PUBKEY_HEX =
  '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const DWALLET_PUBKEY = hexToBytes(DWALLET_PUBKEY_HEX);
const DWALLET_BC1Y_ADDR = encodeDeSoAddress(DWALLET_PUBKEY, 'mainnet');

const OWNER_PUBKEY = 'BC1YLgRsW7HqEKp4kmajJpCLmQfu1NFWFgcFnPNNT5fhzfUZWfwcCh3'; // arbitrary BC1Y...

type ChromeStorageMock = {
  store: Record<string, unknown>;
  get: (keys: string[], cb: (r: Record<string, unknown>) => void) => void;
  set: (items: Record<string, unknown>, cb: () => void) => void;
  remove: (keys: string[], cb: () => void) => void;
};

const storageMock: ChromeStorageMock = {
  store: {},
  get(keys, cb) {
    const out: Record<string, unknown> = {};
    for (const k of keys) {
      if (k in this.store) out[k] = this.store[k];
    }
    cb(out);
  },
  set(items, cb) {
    Object.assign(this.store, items);
    cb();
  },
  remove(keys, cb) {
    for (const k of keys) delete this.store[k];
    cb();
  },
};

vi.mock('@/background/session', () => ({
  getSession: () => ({ activeVaultId: 'vault-test' }),
}));

vi.mock('@/background/chains/bitcoin', () => ({
  getDwalletSecpPublicKey: async () => DWALLET_PUBKEY,
}));

const nodeMock = vi.hoisted(() => ({
  constructAuthorizeDerivedKey: vi.fn(),
  getTransactionSpendingLimitHex: vi.fn(),
  getUserDerivedKeys: vi.fn(),
  submitTransaction: vi.fn(),
}));

vi.mock('@/background/chains/deso/deso-node-client', () => ({
  constructAuthorizeDerivedKey: nodeMock.constructAuthorizeDerivedKey,
  getTransactionSpendingLimitHex: nodeMock.getTransactionSpendingLimitHex,
  getUserDerivedKeys: nodeMock.getUserDerivedKeys,
  submitTransaction: nodeMock.submitTransaction,
}));

beforeEach(() => {
  storageMock.store = {};
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: { local: storageMock },
    runtime: { lastError: null },
  };
  nodeMock.constructAuthorizeDerivedKey.mockReset();
  nodeMock.getTransactionSpendingLimitHex.mockReset();
  nodeMock.getUserDerivedKeys.mockReset();
  nodeMock.submitTransaction.mockReset();
});

afterEach(() => {
  vi.resetModules();
});

describe('buildDeSoIdentityDeriveUrl', () => {
  it('produces a valid /derive URL with required v=2 + DerivedPublicKey + spending-limit', async () => {
    const m = await import('@/background/chains/deso/deso-derived');
    const url = m.buildDeSoIdentityDeriveUrl({
      derivedPubkeyBase58Check: DWALLET_BC1Y_ADDR,
      spendingLimit: { kind: 'unlimited' },
    });
    expect(url.startsWith('https://identity.deso.org/derive?')).toBe(true);
    const u = new URL(url);
    expect(u.searchParams.get('v')).toBe('2');
    expect(u.searchParams.get('DerivedPublicKey')).toBe(DWALLET_BC1Y_ADDR);
    const spend = u.searchParams.get('TransactionSpendingLimitResponse');
    expect(spend).toBeTruthy();
    // the param value is URL-encoded JSON, URLSearchParams already decodes once.
    const parsed = JSON.parse(spend!);
    expect(parsed).toEqual({ IsUnlimited: true });
    expect(u.searchParams.get('AppName')).toBe('chromatika');
    expect(u.searchParams.get('ExpirationDays')).toBe('30');
    expect(u.searchParams.get('PublicKey')).toBeNull(); // omitted when no owner provided
  });

  it('respects ownerPubkey + custom expirationDays + custom origin', async () => {
    const m = await import('@/background/chains/deso/deso-derived');
    const url = m.buildDeSoIdentityDeriveUrl({
      derivedPubkeyBase58Check: DWALLET_BC1Y_ADDR,
      spendingLimit: { kind: 'unlimited' },
      ownerPubkeyBase58Check: OWNER_PUBKEY,
      expirationDays: 7,
      identityOrigin: 'https://identity.staging.deso.org',
    });
    expect(url.startsWith('https://identity.staging.deso.org/derive?')).toBe(true);
    const u = new URL(url);
    expect(u.searchParams.get('PublicKey')).toBe(OWNER_PUBKEY);
    expect(u.searchParams.get('ExpirationDays')).toBe('7');
  });

  it('marks testnet=true when requested', async () => {
    const m = await import('@/background/chains/deso/deso-derived');
    const url = m.buildDeSoIdentityDeriveUrl({
      derivedPubkeyBase58Check: DWALLET_BC1Y_ADDR,
      spendingLimit: { kind: 'unlimited' },
      testnet: true,
    });
    expect(new URL(url).searchParams.get('testnet')).toBe('true');
  });
});

describe('buildDeSoIdentityApproveUrl', () => {
  it('puts the unsigned tx hex into ?tx=', async () => {
    const m = await import('@/background/chains/deso/deso-derived');
    const url = m.buildDeSoIdentityApproveUrl({ unsignedTransactionHex: 'abcd1234' });
    const u = new URL(url);
    expect(url.startsWith('https://identity.deso.org/approve?')).toBe(true);
    expect(u.searchParams.get('tx')).toBe('abcd1234');
  });
});

describe('getSpendingLimitHexForV0Unlimited', () => {
  it('proxies to /api/v0/get-transaction-spending-limit-hex-string with IsUnlimited:true', async () => {
    nodeMock.getTransactionSpendingLimitHex.mockResolvedValue('80aabb');
    const m = await import('@/background/chains/deso/deso-derived');
    const hex = await m.getSpendingLimitHexForV0Unlimited();
    expect(hex).toBe('80aabb');
    expect(nodeMock.getTransactionSpendingLimitHex).toHaveBeenCalledWith({ IsUnlimited: true });
  });
});

describe('getEffectiveDeSoSendIdentity', () => {
  it('returns wallet identity when no delegation is active', async () => {
    const m = await import('@/background/chains/deso/deso-derived');
    const eff = await m.getEffectiveDeSoSendIdentity();
    expect(eff.isDelegated).toBe(false);
    expect(eff.sendAsPubkeyBase58Check).toBe(DWALLET_BC1Y_ADDR);
    expect(eff.signingPubkeyBase58Check).toBe(DWALLET_BC1Y_ADDR);
    expect(eff.ownerPubkeyBase58Check).toBeUndefined();
  });

  it('returns owner-as-send + dWallet-as-signer when delegation is active', async () => {
    const m = await import('@/background/chains/deso/deso-derived');
    await m.__setDeSoOwnerLinkForTests('vault-test', {
      ownerPubkeyBase58Check: OWNER_PUBKEY,
      derivedPubkeyBase58Check: DWALLET_BC1Y_ADDR,
      derivedPubkeyHexCompressed: DWALLET_PUBKEY_HEX,
      spendingLimit: { kind: 'unlimited' },
      spendingLimitHex: '80aabb',
      expirationBlock: 312500,
      authorizedAtMs: Date.now(),
      txnHashHex: 'cafebabe',
      verifiedAtMs: Date.now(),
      identityServiceOrigin: 'https://identity.deso.org',
    });
    const eff = await m.getEffectiveDeSoSendIdentity();
    expect(eff.isDelegated).toBe(true);
    expect(eff.sendAsPubkeyBase58Check).toBe(OWNER_PUBKEY);
    expect(eff.signingPubkeyBase58Check).toBe(DWALLET_BC1Y_ADDR);
    expect(eff.ownerPubkeyBase58Check).toBe(OWNER_PUBKEY);
    expect(eff.expirationBlock).toBe(312500);
  });
});

describe('constructDeSoAuthorizeDerivedKey', () => {
  it('rejects when derivedPubkey does not match the active dWallet', async () => {
    const m = await import('@/background/chains/deso/deso-derived');
    await expect(
      m.constructDeSoAuthorizeDerivedKey({
        ownerPubkeyBase58Check: OWNER_PUBKEY,
        derivedPubkeyBase58Check: 'BC1YLnotchromatika', // wrong derived
        accessSignatureHex: '30440220aaaa',
        expirationBlock: 312500,
        spendingLimitHex: '80aabb',
      }),
    ).rejects.toThrow(/does not match active dWallet/);
    expect(nodeMock.constructAuthorizeDerivedKey).not.toHaveBeenCalled();
  });

  it('rejects bad ownerPubkey + empty accessSignature + empty spendingLimitHex', async () => {
    const m = await import('@/background/chains/deso/deso-derived');
    await expect(
      m.constructDeSoAuthorizeDerivedKey({
        ownerPubkeyBase58Check: '',
        derivedPubkeyBase58Check: DWALLET_BC1Y_ADDR,
        accessSignatureHex: '30440220aaaa',
        expirationBlock: 312500,
        spendingLimitHex: '80aabb',
      }),
    ).rejects.toThrow(/owner/i);
    await expect(
      m.constructDeSoAuthorizeDerivedKey({
        ownerPubkeyBase58Check: OWNER_PUBKEY,
        derivedPubkeyBase58Check: DWALLET_BC1Y_ADDR,
        accessSignatureHex: '',
        expirationBlock: 312500,
        spendingLimitHex: '80aabb',
      }),
    ).rejects.toThrow(/accessSignatureHex/);
    await expect(
      m.constructDeSoAuthorizeDerivedKey({
        ownerPubkeyBase58Check: OWNER_PUBKEY,
        derivedPubkeyBase58Check: DWALLET_BC1Y_ADDR,
        accessSignatureHex: '30440220aaaa',
        expirationBlock: 312500,
        spendingLimitHex: '',
      }),
    ).rejects.toThrow(/spendingLimitHex/);
  });

  it('passes valid args through to the node client', async () => {
    nodeMock.constructAuthorizeDerivedKey.mockResolvedValue({
      TransactionHex: 'deadbeef00',
    });
    const m = await import('@/background/chains/deso/deso-derived');
    const res = await m.constructDeSoAuthorizeDerivedKey({
      ownerPubkeyBase58Check: OWNER_PUBKEY,
      derivedPubkeyBase58Check: DWALLET_BC1Y_ADDR,
      accessSignatureHex: '0x30440220aabbccdd',
      expirationBlock: 312500,
      spendingLimitHex: '0x80aabb',
    });
    expect(res.unsignedTransactionHex).toBe('deadbeef00');
    expect(nodeMock.constructAuthorizeDerivedKey).toHaveBeenCalledTimes(1);
    const call = nodeMock.constructAuthorizeDerivedKey.mock.calls[0]![0]!;
    expect(call.ownerPublicKeyBase58Check).toBe(OWNER_PUBKEY);
    expect(call.derivedPublicKeyBase58Check).toBe(DWALLET_BC1Y_ADDR);
    expect(call.accessSignatureHex).toBe('30440220aabbccdd'); // 0x stripped
    expect(call.transactionSpendingLimitHex).toBe('80aabb');
    expect(call.memo).toBe('chromatika delegation');
    expect(call.appName).toBe('chromatika');
  });
});

describe('submitAndPersistDeSoOwnerLink', () => {
  it('submits + persists the link with verifiedAtMs:null', async () => {
    nodeMock.submitTransaction.mockResolvedValue({ TxnHashHex: 'abc123' });
    const m = await import('@/background/chains/deso/deso-derived');
    const res = await m.submitAndPersistDeSoOwnerLink({
      signedTransactionHex: 'deadbeef',
      ownerPubkeyBase58Check: OWNER_PUBKEY,
      spendingLimit: { kind: 'unlimited' },
      spendingLimitHex: '80aabb',
      expirationBlock: 312500,
    });
    expect(res.txnHashHex).toBe('abc123');
    expect(res.link.ownerPubkeyBase58Check).toBe(OWNER_PUBKEY);
    expect(res.link.derivedPubkeyBase58Check).toBe(DWALLET_BC1Y_ADDR);
    expect(res.link.derivedPubkeyHexCompressed).toBe(DWALLET_PUBKEY_HEX);
    expect(res.link.verifiedAtMs).toBeNull();
    expect(res.link.txnHashHex).toBe('abc123');

    const stored = await m.getActiveDeSoOwnerLink();
    expect(stored?.ownerPubkeyBase58Check).toBe(OWNER_PUBKEY);
    expect(stored?.txnHashHex).toBe('abc123');
  });

  it('throws when submit-transaction returns no TxnHashHex', async () => {
    nodeMock.submitTransaction.mockResolvedValue({});
    const m = await import('@/background/chains/deso/deso-derived');
    await expect(
      m.submitAndPersistDeSoOwnerLink({
        signedTransactionHex: 'deadbeef',
        ownerPubkeyBase58Check: OWNER_PUBKEY,
        spendingLimit: { kind: 'unlimited' },
        spendingLimitHex: '80aabb',
        expirationBlock: 312500,
      }),
    ).rejects.toThrow(/TxnHashHex/);
  });
});

describe('checkDeSoDerivedKeyVerification', () => {
  it('returns verified:false when no link exists', async () => {
    const m = await import('@/background/chains/deso/deso-derived');
    const res = await m.checkDeSoDerivedKeyVerification();
    expect(res.verified).toBe(false);
    expect(res.link).toBeNull();
  });

  it('returns verified:false when chain has no entry yet', async () => {
    nodeMock.getUserDerivedKeys.mockResolvedValue({ DerivedKeys: {} });
    const m = await import('@/background/chains/deso/deso-derived');
    await m.__setDeSoOwnerLinkForTests('vault-test', {
      ownerPubkeyBase58Check: OWNER_PUBKEY,
      derivedPubkeyBase58Check: DWALLET_BC1Y_ADDR,
      derivedPubkeyHexCompressed: DWALLET_PUBKEY_HEX,
      spendingLimit: { kind: 'unlimited' },
      spendingLimitHex: '80aabb',
      expirationBlock: 312500,
      authorizedAtMs: Date.now(),
      txnHashHex: 'abc123',
      verifiedAtMs: null,
      identityServiceOrigin: 'https://identity.deso.org',
    });
    const res = await m.checkDeSoDerivedKeyVerification();
    expect(res.verified).toBe(false);
    expect(res.link?.verifiedAtMs).toBeNull();
  });

  it('returns verified:true + patches verifiedAtMs when chain confirms IsValid', async () => {
    nodeMock.getUserDerivedKeys.mockResolvedValue({
      DerivedKeys: {
        [DWALLET_BC1Y_ADDR]: {
          OwnerPublicKeyBase58Check: OWNER_PUBKEY,
          DerivedPublicKeyBase58Check: DWALLET_BC1Y_ADDR,
          ExpirationBlock: 312500,
          IsValid: true,
        },
      },
    });
    const m = await import('@/background/chains/deso/deso-derived');
    await m.__setDeSoOwnerLinkForTests('vault-test', {
      ownerPubkeyBase58Check: OWNER_PUBKEY,
      derivedPubkeyBase58Check: DWALLET_BC1Y_ADDR,
      derivedPubkeyHexCompressed: DWALLET_PUBKEY_HEX,
      spendingLimit: { kind: 'unlimited' },
      spendingLimitHex: '80aabb',
      expirationBlock: 312500,
      authorizedAtMs: Date.now(),
      txnHashHex: 'abc123',
      verifiedAtMs: null,
      identityServiceOrigin: 'https://identity.deso.org',
    });
    const res = await m.checkDeSoDerivedKeyVerification();
    expect(res.verified).toBe(true);
    expect(res.link?.verifiedAtMs).not.toBeNull();
    // calling again returns the cached "already verified" without hitting the chain
    nodeMock.getUserDerivedKeys.mockClear();
    const res2 = await m.checkDeSoDerivedKeyVerification();
    expect(res2.verified).toBe(true);
    expect(nodeMock.getUserDerivedKeys).not.toHaveBeenCalled();
  });
});

describe('clearActiveDeSoOwnerLink', () => {
  it('removes the link from storage', async () => {
    const m = await import('@/background/chains/deso/deso-derived');
    await m.__setDeSoOwnerLinkForTests('vault-test', {
      ownerPubkeyBase58Check: OWNER_PUBKEY,
      derivedPubkeyBase58Check: DWALLET_BC1Y_ADDR,
      derivedPubkeyHexCompressed: DWALLET_PUBKEY_HEX,
      spendingLimit: { kind: 'unlimited' },
      spendingLimitHex: '80aabb',
      expirationBlock: 312500,
      authorizedAtMs: Date.now(),
      txnHashHex: 'abc123',
      verifiedAtMs: Date.now(),
      identityServiceOrigin: 'https://identity.deso.org',
    });
    expect(await m.getActiveDeSoOwnerLink()).not.toBeNull();
    await m.clearActiveDeSoOwnerLink();
    expect(await m.getActiveDeSoOwnerLink()).toBeNull();
  });
});
