/**
 * SuiNS reverse lookup via Sui GraphQL (`address.defaultSuinsName` with a
 * `suinsRegistrations` fallback for indexers that do not expose the default).
 * avatar / PFP lives on the name NFT object; we only resolve names here.
 * UI-side raw `fetch()` so this stays out of the background bundle.
 */

const SUINS_REVERSE_QUERY = /* GraphQL */ `
  query ChromatikaSuinsReverse($address: SuiAddress!) {
    address(address: $address) {
      defaultSuinsName
      suinsRegistrations(first: 5) {
        nodes {
          domain
        }
      }
    }
  }
`;

type SuinsReverseResponse = {
  data?: {
    address?: {
      defaultSuinsName?: string | null;
      suinsRegistrations?: {
        nodes?: Array<{ domain?: string | null }> | null;
      } | null;
    } | null;
  };
  errors?: Array<{ message?: string }>;
};

export async function resolveSuinsNames(graphqlUrl: string, suiAddress: string): Promise<string[]> {
  try {
    const res = await fetch(graphqlUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: SUINS_REVERSE_QUERY,
        variables: { address: suiAddress },
      }),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as SuinsReverseResponse;
    const addr = json.data?.address;
    if (!addr) return [];
    const out: string[] = [];
    const primary = addr.defaultSuinsName;
    if (typeof primary === 'string' && primary.trim()) out.push(primary.trim());
    for (const row of addr.suinsRegistrations?.nodes ?? []) {
      const d = row?.domain;
      if (typeof d === 'string' && d.trim() && !out.includes(d.trim())) out.push(d.trim());
    }
    return out;
  } catch {
    return [];
  }
}

/** best-effort SuiNS profile image (depends on indexer; may 404). */
export function suinsAvatarUrlForName(primaryName: string): string | null {
  const n = primaryName.trim();
  if (!n) return null;
  return `https://suins-image.cdn.sui.io/name/${encodeURIComponent(n)}`;
}
