import { describe, it, expect } from 'vitest';
import {
  computeEffectiveParentDwalletId,
  type DwalletParentRelations,
} from '@/background/dwallet-relations-storage';
import type { SessionState } from '@/background/session';

describe('computeEffectiveParentDwalletId', () => {
  const child = '0x' + '11'.repeat(32);
  const parentRel = '0x' + '22'.repeat(32);
  const parentMeta = '0x' + '33'.repeat(32);

  it('prefers parent relations map over meta mirror', () => {
    const rel: DwalletParentRelations = { parentByChildId: { [child]: parentRel } };
    const meta: SessionState['dwalletMeta'] = {
      ED25519: { baseChain: 'sui', dwalletId: child, parentDwalletId: parentMeta },
    };
    expect(computeEffectiveParentDwalletId(child, rel, meta)).toBe(parentRel);
  });

  it('falls back to meta parent when relations omit child', () => {
    const rel: DwalletParentRelations = { parentByChildId: {} };
    const meta: SessionState['dwalletMeta'] = {
      SECP256K1: { baseChain: 'sui', dwalletId: child, parentDwalletId: parentMeta },
    };
    expect(computeEffectiveParentDwalletId(child, rel, meta)).toBe(parentMeta);
  });

  it('returns null when unknown child', () => {
    const rel: DwalletParentRelations = { parentByChildId: {} };
    expect(computeEffectiveParentDwalletId(child, rel, {})).toBeNull();
  });
});
