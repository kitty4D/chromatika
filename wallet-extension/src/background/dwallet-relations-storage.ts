/**
 * legacy merge helper for optional `parentDwalletId` on `dwalletMeta` (tests + future reads).
 * home nesting UI was removed; chrome `chromatika_dwallet_parent_relations_v1_*` is unused.
 */

import type { CurveKey, SessionState } from '@/background/session';

export type DwalletParentRelations = {
  parentByChildId: Record<string, string>;
};

const CURVES: CurveKey[] = ['SECP256K1', 'ED25519'];

/**
 * if `rel.parentByChildId` had an entry it would win; nesting UI no longer writes that map.
 */
export function computeEffectiveParentDwalletId(
  childDwalletId: string,
  rel: DwalletParentRelations,
  meta: SessionState['dwalletMeta'],
): string | null {
  const fromRel = rel.parentByChildId[childDwalletId];
  if (fromRel) return fromRel;
  for (const c of CURVES) {
    const m = meta[c];
    if (m?.dwalletId === childDwalletId && m.parentDwalletId) return m.parentDwalletId;
  }
  return null;
}
