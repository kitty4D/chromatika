import { describe, expect, it } from 'vitest';
import { matchCapsToSiblings, type OwnedCapInputForMatch, type SiblingDwalletMetaSummary } from '@/background/scan/dwallet-cap-match';

function fakeCap(overrides: Partial<OwnedCapInputForMatch> & { dwalletId: string }): OwnedCapInputForMatch {
  return {
    capObjectId: `cap_${overrides.dwalletId}`,
    curve: 'SECP256K1',
    status: 'Active',
    needsZeroTrustCompletion: false,
    ...overrides,
  };
}

function fakeSibling(overrides: Partial<SiblingDwalletMetaSummary> & { vaultId: string; knownDwalletIds: string[] }): SiblingDwalletMetaSummary {
  return {
    label: overrides.vaultId,
    ikaIndex: 0,
    isActive: false,
    ...overrides,
  };
}

describe('matchCapsToSiblings - precise per-cap orphan match', () => {
  it('all caps matched when every dwalletId is in some sibling\'s known set', () => {
    const r = matchCapsToSiblings(
      [fakeCap({ dwalletId: '0xa1' }), fakeCap({ dwalletId: '0xb2' })],
      [
        fakeSibling({ vaultId: 'v1', label: 'default', ikaIndex: 0, isActive: true, knownDwalletIds: ['0xa1'] }),
        fakeSibling({ vaultId: 'v2', label: 'work', ikaIndex: 1, knownDwalletIds: ['0xb2'] }),
      ],
    );
    expect(r.capCount).toBe(2);
    expect(r.orphanCount).toBe(0);
    expect(r.caps[0]!.matchedVaultId).toBe('v1');
    expect(r.caps[0]!.matchedVaultLabel).toBe('default');
    expect(r.caps[0]!.matchedIkaIndex).toBe(0);
    expect(r.caps[1]!.matchedVaultId).toBe('v2');
    expect(r.caps[1]!.matchedIkaIndex).toBe(1);
  });

  it('flags caps whose dwalletId is absent from every sibling as orphan', () => {
    const r = matchCapsToSiblings(
      [
        fakeCap({ dwalletId: '0xa1' }), // matched
        fakeCap({ dwalletId: '0xORPHAN' }), // orphan
        fakeCap({ dwalletId: '0xb2' }), // matched
      ],
      [
        fakeSibling({ vaultId: 'v1', knownDwalletIds: ['0xa1'] }),
        fakeSibling({ vaultId: 'v2', knownDwalletIds: ['0xb2'] }),
      ],
    );
    expect(r.orphanCount).toBe(1);
    expect(r.caps[0]!.matchedVaultId).toBe('v1');
    expect(r.caps[1]!.matchedVaultId).toBeNull();
    expect(r.caps[1]!.matchedVaultLabel).toBeNull();
    expect(r.caps[1]!.matchedIkaIndex).toBeNull();
    expect(r.caps[2]!.matchedVaultId).toBe('v2');
  });

  it('all caps orphan when no siblings exist', () => {
    const r = matchCapsToSiblings(
      [fakeCap({ dwalletId: '0xa' }), fakeCap({ dwalletId: '0xb' })],
      [],
    );
    expect(r.orphanCount).toBe(2);
    expect(r.siblingCount).toBe(0);
    expect(r.caps.every((c) => c.matchedVaultId === null)).toBe(true);
  });

  it('all caps orphan when siblings exist but have no known dwallet ids (DKG not run yet)', () => {
    const r = matchCapsToSiblings(
      [fakeCap({ dwalletId: '0xa' })],
      [fakeSibling({ vaultId: 'v1', knownDwalletIds: [] })],
    );
    expect(r.orphanCount).toBe(1);
    expect(r.siblingCount).toBe(1);
  });

  it('handles multiple curves per sibling (one vault owns SECP256K1 + ED25519 dwallets)', () => {
    const r = matchCapsToSiblings(
      [
        fakeCap({ dwalletId: '0xs1', curve: 'SECP256K1' }),
        fakeCap({ dwalletId: '0xed1', curve: 'ED25519' }),
      ],
      [fakeSibling({ vaultId: 'v1', knownDwalletIds: ['0xs1', '0xed1'] })],
    );
    expect(r.orphanCount).toBe(0);
    expect(r.caps[0]!.matchedVaultId).toBe('v1');
    expect(r.caps[1]!.matchedVaultId).toBe('v1');
  });

  it('first-write-wins when two siblings claim the same dwallet id (data corruption edge case)', () => {
    const r = matchCapsToSiblings(
      [fakeCap({ dwalletId: '0xshared' })],
      [
        fakeSibling({ vaultId: 'v1', label: 'first', knownDwalletIds: ['0xshared'] }),
        fakeSibling({ vaultId: 'v2', label: 'second', knownDwalletIds: ['0xshared'] }),
      ],
    );
    expect(r.caps[0]!.matchedVaultId).toBe('v1');
    expect(r.caps[0]!.matchedVaultLabel).toBe('first');
  });

  it('trims whitespace on both sides of the dwallet id comparison', () => {
    const r = matchCapsToSiblings(
      [fakeCap({ dwalletId: '  0xabc  ' })],
      [fakeSibling({ vaultId: 'v1', knownDwalletIds: ['0xabc'] })],
    );
    expect(r.caps[0]!.matchedVaultId).toBe('v1');
  });

  it('skips empty/whitespace-only known dwallet ids on the sibling side', () => {
    const r = matchCapsToSiblings(
      [fakeCap({ dwalletId: '0xa' })],
      [fakeSibling({ vaultId: 'v1', knownDwalletIds: ['', '   ', '0xa'] })],
    );
    expect(r.caps[0]!.matchedVaultId).toBe('v1');
  });

  it('preserves cap fields verbatim alongside the match annotations', () => {
    const cap = fakeCap({ dwalletId: '0xa', status: 'AwaitingKeyHolderSignature', needsZeroTrustCompletion: true });
    const r = matchCapsToSiblings([cap], [fakeSibling({ vaultId: 'v1', knownDwalletIds: ['0xa'] })]);
    expect(r.caps[0]!.capObjectId).toBe(cap.capObjectId);
    expect(r.caps[0]!.curve).toBe('SECP256K1');
    expect(r.caps[0]!.status).toBe('AwaitingKeyHolderSignature');
    expect(r.caps[0]!.needsZeroTrustCompletion).toBe(true);
  });
});
