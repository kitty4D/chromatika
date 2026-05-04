/**
 * pure cap-to-sibling matching for the dwallet inventory. takes a list of owned dwalletCaps and
 * the merged dwalletMeta for each local sibling vault; annotates each cap with the matching
 * sibling (if any) and reports the precise orphan count.
 *
 * "matched" = `cap.dwalletId` appears in some sibling's dwalletMeta. that's the local truth set
 * (written when DKG completes or when the user accepts an encrypted share). matches the same
 * read pattern used by `kickDiscoveryForVault` so freshly-discovered ids count.
 *
 * extracted into its own module so the cap-match contract can be unit-tested without booting a
 * full session + tRPC stack. the inventory tRPC procedure is a thin wrapper around this fn.
 */

import type { CurveKey } from '@/background/session';

export type SiblingDwalletMetaSummary = {
  vaultId: string;
  label: string;
  /** bip44-style ika encryption-key index. defaults to 0 when the vault record has no field. */
  ikaIndex: number;
  isActive: boolean;
  /** dwallet ids the local vault has accepted / discovered (one per curve max). */
  knownDwalletIds: string[];
};

export type OwnedCapInputForMatch = {
  capObjectId: string;
  dwalletId: string;
  curve: CurveKey | 'unknown';
  status: string;
  needsZeroTrustCompletion: boolean;
  chainAddresses?: unknown;
};

export type MatchedCap = OwnedCapInputForMatch & {
  /** non-null when `cap.dwalletId` is in some sibling's known set. */
  matchedVaultId: string | null;
  matchedVaultLabel: string | null;
  matchedIkaIndex: number | null;
};

export type CapMatchResult = {
  caps: MatchedCap[];
  capCount: number;
  siblingCount: number;
  orphanCount: number;
};

/**
 * given a flat list of caps from chain + a list of sibling summaries (with merged dwalletMeta),
 * annotate each cap with whichever sibling owns it (or `null` for orphans). siblings carrying
 * the same dwallet id (data-corruption edge case) resolve in iteration order.
 */
export function matchCapsToSiblings(
  caps: OwnedCapInputForMatch[],
  siblings: SiblingDwalletMetaSummary[],
): CapMatchResult {
  const dwalletIdToSibling = new Map<string, { vaultId: string; label: string; ikaIndex: number }>();
  for (const s of siblings) {
    for (const id of s.knownDwalletIds) {
      const trimmed = id.trim();
      if (!trimmed) continue;
      // first-write-wins; later siblings claiming the same id are ignored. realistic data
      // shouldn't have duplicates - dwallet ids are unique on chain.
      if (!dwalletIdToSibling.has(trimmed)) {
        dwalletIdToSibling.set(trimmed, { vaultId: s.vaultId, label: s.label, ikaIndex: s.ikaIndex });
      }
    }
  }

  const annotated: MatchedCap[] = caps.map((c) => {
    const matched = dwalletIdToSibling.get(c.dwalletId.trim());
    return {
      ...c,
      matchedVaultId: matched?.vaultId ?? null,
      matchedVaultLabel: matched?.label ?? null,
      matchedIkaIndex: matched?.ikaIndex ?? null,
    };
  });

  return {
    caps: annotated,
    capCount: annotated.length,
    siblingCount: siblings.length,
    orphanCount: annotated.filter((c) => c.matchedVaultId === null).length,
  };
}
