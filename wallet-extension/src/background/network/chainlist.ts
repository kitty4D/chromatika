import type { EvmNetwork } from '@/config/networks';

type ChainlistItem = {
  chainId: number;
  name: string;
  /** e.g. `ink` for Ink; used for search ranking when present */
  shortName?: string;
  rpc: string[];
  nativeCurrency: { name: string; symbol: string; decimals: number };
  explorers?: { url: string }[];
};

const CHAINLIST_JSON_URL = 'https://chainid.network/chains.json';
const CHAINLIST_CACHE_TTL_MS = 5 * 60_000;

let chainlistCache: { fetchedAt: number; chains: ChainlistItem[] } | null = null;

/** shared fetch for Settings search + dapp `wallet_switchEthereumChain` registry fallback. */
export async function loadChainlistChains(): Promise<ChainlistItem[]> {
  const now = Date.now();
  if (chainlistCache && now - chainlistCache.fetchedAt < CHAINLIST_CACHE_TTL_MS) {
    return chainlistCache.chains;
  }
  const res = await fetch(CHAINLIST_JSON_URL);
  if (!res.ok) throw new Error(`chainlist fetch failed: ${res.status}`);
  const chains = (await res.json()) as ChainlistItem[];
  chainlistCache = { fetchedAt: now, chains };
  return chains;
}

/** map a chainlist row to our EvmNetwork shape, or null if there is no usable https RPC (no `${` templates). */
export function chainlistItemToEvmNetwork(c: ChainlistItem): EvmNetwork | null {
  const rpcUrl =
    c.rpc.find((r) => typeof r === 'string' && r.startsWith('https://') && !r.includes('${')) ?? '';
  if (!rpcUrl.startsWith('https://')) return null;
  return {
    id: `evm-${c.chainId}`,
    name: c.name,
    chainId: c.chainId,
    rpcUrl,
    symbol: c.nativeCurrency.symbol,
    decimals: c.nativeCurrency.decimals,
    explorerUrl: c.explorers?.[0]?.url,
    isCustom: false,
  };
}

/**
 * resolve a chain by numeric id from the public chainlist registry (same source as Settings search).
 * used when a dapp calls `wallet_switchEthereumChain` before `wallet_addEthereumChain`.
 */
export async function lookupEvmNetworkFromChainlistByChainId(chainId: number): Promise<EvmNetwork | null> {
  const chains = await loadChainlistChains();
  const row = chains.find((c) => c.chainId === chainId);
  if (!row) return null;
  return chainlistItemToEvmNetwork(row);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * higher score = better match. used so `Ink` ranks above `Chainlink` when searching `ink`.
 */
export function scoreChainlistMatch(c: ChainlistItem, q: string): number {
  const query = q.toLowerCase().trim();
  if (!query) return 0;
  const name = c.name.toLowerCase();
  const short = (c.shortName ?? '').toLowerCase();
  const native = (c.nativeCurrency?.name ?? '').toLowerCase();

  if (name === query) return 100_000;
  if (short === query) return 95_000;
  if (native === query) return 92_000;

  if (name.startsWith(query + ' ') || name.startsWith(query + '(') || name.startsWith(query + '/')) {
    return 85_000;
  }
  if (name.startsWith(query)) return 80_000;

  const wordBoundary = new RegExp(`(^|[\\s(-/])${escapeRegex(query)}`, 'i');
  if (wordBoundary.test(c.name)) return 50_000;

  if (name.includes(query)) return 10_000 - Math.min(name.length, 400);

  if (short.includes(query)) return 5000;
  if (native.includes(query)) return 4000;

  return 0;
}

/**
 * search chainid.network/chains.json by chainId (exact) or name (substring, case-insensitive).
 * matches are ranked by relevance (exact name and shortName first, then prefix / word boundary),
 * then substring so short names like `Ink` are not buried under the first 10 `*link*` chains.
 * returns up to 25 matches as ready-to-add EvmNetwork objects.
 * RPC entries that require API keys (contain `${`) are skipped.
 */
export async function searchChainlist(query: string | number): Promise<EvmNetwork[]> {
  const chains = await loadChainlistChains();

  const q = String(query).toLowerCase().trim();
  if (!q && typeof query === 'string') return [];

  const isNumeric = /^\d+$/.test(q);

  const matched = chains.filter((c) =>
    isNumeric ? String(c.chainId) === q : scoreChainlistMatch(c, q) > 0,
  );

  if (!isNumeric) {
    matched.sort((a, b) => {
      const ds = scoreChainlistMatch(b, q) - scoreChainlistMatch(a, q);
      if (ds !== 0) return ds;
      return a.name.localeCompare(b.name);
    });
  }

  return matched
    .map((c) => chainlistItemToEvmNetwork(c))
    .filter((n): n is EvmNetwork => n != null)
    .slice(0, 25);
}
