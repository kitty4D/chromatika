import { useEffect, useState } from 'react';
import type { VaultSummary } from '@/ui/VaultPicker';
import { resolveSuinsNames, suinsAvatarUrlForName } from '@/lib/name-resolution/suins-rpc';
import {
  resolveAllDomainsMainName,
  resolveSnsPrimaryName,
  snsBonfidaImageUrl,
} from '@/lib/name-resolution/solana-names';

export type VaultNameHint = {
  vaultId: string;
  suinsNames: string[];
  suinsAvatarUrl: string | null;
  snsName: string | null;
  snsAvatarUrl: string | null;
  allDomainsName: string | null;
};

const cache = new Map<string, VaultNameHint>();

export function useVaultNameHints(vaultSummaries: VaultSummary[] | null): Map<string, VaultNameHint> {
  const [hints, setHints] = useState<Map<string, VaultNameHint>>(() => new Map());

  useEffect(() => {
    if (!vaultSummaries?.length) {
      setHints(new Map());
      return;
    }

    let cancelled = false;

    void (async () => {
      const next = new Map<string, VaultNameHint>();
      await Promise.all(
        vaultSummaries.map(async (v) => {
          const hit = cache.get(v.id);
          if (hit) {
            next.set(v.id, hit);
            return;
          }
          const sui = v.suiAddress0;
          const sol = v.solanaAddress0;
          const suiGql = v.suiGraphqlUrl;
          const solRpc = v.solanaLookupRpcUrl;

          const suinsNames =
            sui && suiGql ? await resolveSuinsNames(suiGql, sui) : [];
          const suinsPrimary = suinsNames[0] ?? null;
          const snsName = sol ? await resolveSnsPrimaryName(sol) : null;
          const allDomainsName =
            sol && solRpc ? await resolveAllDomainsMainName(solRpc, sol) : null;

          const row: VaultNameHint = {
            vaultId: v.id,
            suinsNames,
            suinsAvatarUrl: suinsPrimary ? suinsAvatarUrlForName(suinsPrimary) : null,
            snsName,
            snsAvatarUrl: snsName ? snsBonfidaImageUrl(snsName) : null,
            allDomainsName,
          };
          cache.set(v.id, row);
          next.set(v.id, row);
        }),
      );
      if (!cancelled) setHints(next);
    })();

    return () => {
      cancelled = true;
    };
  }, [vaultSummaries]);

  return hints;
}
