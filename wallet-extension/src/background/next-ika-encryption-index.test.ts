/**
 * unit tests for the bip44-style ika encryption-index auto-pick used by
 * `addHardwareVault` / `addWaapVault` / `addLazorVault`.
 *
 * the helper itself isn't exported from `wallet-service.ts` (kept private), so we exercise the
 * same arithmetic via a local re-implementation of the predicate-filter + max-plus-one logic.
 * if the production helper drifts, the contract this test pins (next index = max(matches)+1, 0
 * when no matches) is what the per-method add-flows depend on.
 */
import { describe, expect, it } from 'vitest';
import type { VaultRecord, VaultPayloadV3 } from '@/background/vault-types';

function nextIkaEncryptionIndex(payload: VaultPayloadV3, predicate: (v: VaultRecord) => boolean): number {
  const indices: number[] = [];
  for (const v of payload.vaults) {
    if (!predicate(v)) continue;
    const idx = (v as { ikaEncryptionIndex?: number }).ikaEncryptionIndex ?? 0;
    if (Number.isFinite(idx) && idx >= 0) indices.push(idx);
  }
  return indices.length > 0 ? Math.max(...indices) + 1 : 0;
}

function makePayload(vaults: VaultRecord[]): VaultPayloadV3 {
  return { v: 3, vaults, activeVaultId: vaults[0]?.id ?? null };
}

function fakeHardware(opts: { id: string; hardwareAccountId: string; ikaEncryptionIndex?: number }): VaultRecord {
  return {
    id: opts.id,
    label: opts.id,
    baseChain: 'solana',
    accountKind: 'hardware',
    hardwareAccountId: opts.hardwareAccountId,
    ...(opts.ikaEncryptionIndex !== undefined ? { ikaEncryptionIndex: opts.ikaEncryptionIndex } : {}),
    network: 'mainnet',
    ikaShareKeysB64: {},
    dwalletMeta: {},
    createdAtMs: 0,
  } as VaultRecord;
}

function fakeWaap(opts: { id: string; waapSuiAddress: string; ikaEncryptionIndex?: number }): VaultRecord {
  return {
    id: opts.id,
    label: opts.id,
    baseChain: 'sui',
    accountKind: 'waap',
    waapSuiAddress: opts.waapSuiAddress,
    waapSuiPublicKeyB64: 'placeholder',
    waapAuthMethod: 'email',
    seedSource: 'recovery-words',
    ...(opts.ikaEncryptionIndex !== undefined ? { ikaEncryptionIndex: opts.ikaEncryptionIndex } : {}),
    network: 'mainnet',
    ikaShareKeysB64: {},
    dwalletMeta: {},
    createdAtMs: 0,
  } as VaultRecord;
}

describe('nextIkaEncryptionIndex contract', () => {
  it('returns 0 when no matching identity exists', () => {
    const payload = makePayload([fakeHardware({ id: 'a', hardwareAccountId: 'OTHER_HW' })]);
    const next = nextIkaEncryptionIndex(payload, (v) => v.accountKind === 'hardware' && v.hardwareAccountId === 'TARGET');
    expect(next).toBe(0);
  });

  it('returns 1 when one matching record exists at index 0 (implicit)', () => {
    const payload = makePayload([fakeHardware({ id: 'a', hardwareAccountId: 'TARGET' })]);
    const next = nextIkaEncryptionIndex(payload, (v) => v.accountKind === 'hardware' && v.hardwareAccountId === 'TARGET');
    expect(next).toBe(1);
  });

  it('returns 1 when one matching record exists at index 0 (explicit)', () => {
    const payload = makePayload([fakeHardware({ id: 'a', hardwareAccountId: 'TARGET', ikaEncryptionIndex: 0 })]);
    expect(
      nextIkaEncryptionIndex(payload, (v) => v.accountKind === 'hardware' && v.hardwareAccountId === 'TARGET'),
    ).toBe(1);
  });

  it('returns max+1 when several matching records exist with non-contiguous indices', () => {
    const payload = makePayload([
      fakeHardware({ id: 'a', hardwareAccountId: 'TARGET', ikaEncryptionIndex: 0 }),
      fakeHardware({ id: 'b', hardwareAccountId: 'TARGET', ikaEncryptionIndex: 2 }),
      fakeHardware({ id: 'c', hardwareAccountId: 'TARGET', ikaEncryptionIndex: 5 }),
    ]);
    expect(
      nextIkaEncryptionIndex(payload, (v) => v.accountKind === 'hardware' && v.hardwareAccountId === 'TARGET'),
    ).toBe(6);
  });

  it('ignores records with a different identity field', () => {
    const payload = makePayload([
      fakeHardware({ id: 'a', hardwareAccountId: 'TARGET', ikaEncryptionIndex: 0 }),
      fakeHardware({ id: 'b', hardwareAccountId: 'OTHER', ikaEncryptionIndex: 9 }),
    ]);
    expect(
      nextIkaEncryptionIndex(payload, (v) => v.accountKind === 'hardware' && v.hardwareAccountId === 'TARGET'),
    ).toBe(1);
  });

  it('ignores records of a different accountKind even with a matching field name', () => {
    const payload = makePayload([
      fakeWaap({ id: 'a', waapSuiAddress: 'SAME', ikaEncryptionIndex: 3 }),
      fakeHardware({ id: 'b', hardwareAccountId: 'SAME', ikaEncryptionIndex: 0 }),
    ]);
    // looking for waap-only with identity SAME -> max is 3 -> next is 4. hardware row ignored.
    expect(
      nextIkaEncryptionIndex(payload, (v) => v.accountKind === 'waap' && v.waapSuiAddress === 'SAME'),
    ).toBe(4);
  });

  it('treats negative or non-finite ikaEncryptionIndex values as ineligible (defensive)', () => {
    const payload = makePayload([
      fakeHardware({ id: 'a', hardwareAccountId: 'TARGET', ikaEncryptionIndex: -1 }),
      fakeHardware({ id: 'b', hardwareAccountId: 'TARGET', ikaEncryptionIndex: Number.NaN }),
    ]);
    // both rows are filtered out; treated as if no matches exist.
    expect(
      nextIkaEncryptionIndex(payload, (v) => v.accountKind === 'hardware' && v.hardwareAccountId === 'TARGET'),
    ).toBe(0);
  });

  it('handles an empty payload', () => {
    expect(nextIkaEncryptionIndex(makePayload([]), () => true)).toBe(0);
  });
});
