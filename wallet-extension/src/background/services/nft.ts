/**
 * NFTService: per-chain NFT fetching, all gated by MediaSafetyMode.
 *
 * SUI:  GraphQL listOwnedObjects with Display v2 (no API key)
 * BTC:  Hiro Ordinals REST API (no API key)
 * EVM:  Alchemy NFT API (requires VITE_ALCHEMY_KEY, else returns empty)
 * SOL:  Helius DAS API via `tryHeliusSolanaRpcUrl('mainnet')` (requires VITE_HELIUS_KEY, else returns empty)
 * APT:  Aptos token v2 indexer (no API key, limited metadata)
 *
 * production: set **VITE_ALCHEMY_KEY** and **VITE_HELIUS_KEY** at build time for EVM/Solana grids and Helius-backed Solana RPC presets;
 * document third-party hosts in Chrome Web Store privacy disclosures.
 */

import { getSession } from '@/background/session';
import { getDwalletNetworkSettings } from '@/background/network/tier-network-settings';
import { tryHeliusSolanaRpcUrl } from '@/config/networks';
import { createSuiGraphQLClientFromRegistryNetworkId } from '@/background/sui-client';
import { filterImageUrl, type MediaSafetyMode } from './media-safety';

const APT_INDEXER: Record<string, string> = {
  'apt-mainnet': 'https://api.mainnet.aptoslabs.com/v1',
  'apt-testnet': 'https://api.testnet.aptoslabs.com/v1',
  'apt-devnet': 'https://api.devnet.aptoslabs.com/v1',
};

export type NftItem = {
  id: string;
  name: string;
  description?: string;
  imageUrl: string | null; // null when filtered by MediaSafetyMode
  collectionName?: string;
  chain: 'sui' | 'evm' | 'solana' | 'aptos' | 'bitcoin';
  /** raw on-chain type / contract address */
  contractOrType?: string;
};

// --- SUI ---

export async function getSuiNfts(address: string, mode: MediaSafetyMode): Promise<NftItem[]> {
  const s = getSession();
  if (!s) throw new Error('Wallet locked');
  const dw = await getDwalletNetworkSettings(s.activeVaultId, {
    network: s.network,
    baseChain: s.activeVaultBaseChain,
  });
  const client = createSuiGraphQLClientFromRegistryNetworkId(dw.suiNetworkId);

  const items: NftItem[] = [];
  let cursor: string | null = null;

  // paginate all owned objects that have a Display (which NFTs emit on-chain).
  // GraphQL response: `objects[].display.output` is `Record<string, unknown> | null`
  // (was `Record<string, string>` before @mysten/sui 2.16; values are still strings in
  // practice since Move's `display` module only accepts UTF-8 strings, but the SDK
  // narrowed the type so we coerce at read time).
  // Awaited<ReturnType<>> avoids tsc 7022 "implicitly any in own initializer" caused
  // by the cursor write-back pattern below.
  type Page = Awaited<ReturnType<typeof client.core.listOwnedObjects<{ display: true }>>>;
  for (;;) {
    const page: Page = await client.core.listOwnedObjects({
      owner: address,
      cursor,
      limit: 50,
      include: { display: true },
    });

    for (const obj of page.objects) {
      const display = obj.display?.output as Record<string, string | undefined> | null | undefined;
      if (!display?.name) continue;

      items.push({
        id: obj.objectId,
        name: display.name ?? 'Unnamed',
        description: display.description ?? undefined,
        imageUrl: filterImageUrl(display.image_url ?? display.img_url, mode),
        collectionName: display.collection_name ?? display.project_name ?? undefined,
        chain: 'sui',
        contractOrType: obj.type,
      });
    }

    if (!page.hasNextPage || !page.cursor) break;
    cursor = page.cursor;
  }

  return items;
}

// --- BTC Ordinals (Hiro) ---

type HiroInscription = {
  id: string;
  number: number;
  content_type?: string;
  content_uri?: string;
  meta?: { name?: string };
  collection_symbol?: string;
};

export async function getBtcOrdinals(address: string, mode: MediaSafetyMode): Promise<NftItem[]> {
  if (mode === 'none') return [];
  try {
    const url = `https://api.hiro.so/ordinals/v1/inscriptions?address=${encodeURIComponent(address)}&limit=60`;
    const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return [];
    const data = await r.json() as { results?: HiroInscription[] };
    return (data.results ?? []).map((ins) => {
      // hiro content URI: https://api.hiro.so/ordinals/v1/inscriptions/{id}/content
      const rawImageUrl = ins.content_type?.startsWith('image/')
        ? `https://api.hiro.so/ordinals/v1/inscriptions/${ins.id}/content`
        : null;
      return {
        id: ins.id,
        name: ins.meta?.name ?? `Inscription #${ins.number}`,
        imageUrl: rawImageUrl ? filterImageUrl(rawImageUrl, mode) : null,
        collectionName: ins.collection_symbol ?? undefined,
        chain: 'bitcoin' as const,
      };
    });
  } catch {
    return [];
  }
}

// --- EVM (Alchemy): requires VITE_ALCHEMY_KEY ---

export async function getEvmNfts(address: string, chainId: number, mode: MediaSafetyMode): Promise<NftItem[]> {
  // use `import.meta.env.*` directly so vite replaces at build time. a `typeof import.meta` guard
  // makes vite emit a runtime import.meta shim that touches `document`, service workers have none.
  const apiKey = import.meta.env.VITE_ALCHEMY_KEY ?? '';
  if (!apiKey) return []; // no API key, caller should surface a "connect Alchemy" prompt
  // map chainId to Alchemy subdomain
  const subdomain: Record<number, string> = {
    1: 'eth-mainnet',
    8453: 'base-mainnet',
    42161: 'arb-mainnet',
    10: 'opt-mainnet',
    137: 'polygon-mainnet',
  };
  const host = subdomain[chainId] ?? 'eth-mainnet';
  try {
    const url = `https://${host}.g.alchemy.com/nft/v3/${apiKey}/getNFTsForOwner?owner=${address}&withMetadata=true&pageSize=50`;
    const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return [];
    const data = await r.json() as {
      ownedNfts?: Array<{ tokenId: string; name?: string; description?: string; image?: { originalUrl?: string }; contract?: { address?: string; name?: string } }>;
    };
    return (data.ownedNfts ?? []).map((nft) => ({
      id: `${nft.contract?.address ?? ''}:${nft.tokenId}`,
      name: nft.name ?? `NFT #${nft.tokenId}`,
      description: nft.description ?? undefined,
      imageUrl: filterImageUrl(nft.image?.originalUrl, mode),
      collectionName: nft.contract?.name ?? undefined,
      chain: 'evm' as const,
      contractOrType: nft.contract?.address,
    }));
  } catch {
    return [];
  }
}

// --- Solana (Helius DAS): requires VITE_HELIUS_KEY ---

export async function getSolanaNfts(address: string, mode: MediaSafetyMode): Promise<NftItem[]> {
  const url = tryHeliusSolanaRpcUrl('mainnet');
  if (!url) return [];
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'getAssetsByOwner',
        params: { ownerAddress: address, page: 1, limit: 100 },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return [];
    const data = await r.json() as {
      result?: {
        items?: Array<{
          id: string;
          content?: { metadata?: { name?: string; description?: string }; links?: { image?: string } };
          grouping?: Array<{ group_key: string; group_value: string }>;
        }>;
      };
    };
    return (data.result?.items ?? []).map((asset) => ({
      id: asset.id,
      name: asset.content?.metadata?.name ?? asset.id.slice(0, 8),
      description: asset.content?.metadata?.description ?? undefined,
      imageUrl: filterImageUrl(asset.content?.links?.image, mode),
      collectionName: asset.grouping?.find((g) => g.group_key === 'collection')?.group_value ?? undefined,
      chain: 'solana' as const,
    }));
  } catch {
    return [];
  }
}

// --- Aptos (indexer) ---

export async function getAptosNfts(address: string, mode: MediaSafetyMode): Promise<NftItem[]> {
  const s = getSession();
  if (!s) throw new Error('Wallet locked');
  const dw = await getDwalletNetworkSettings(s.activeVaultId, {
    network: s.network,
    baseChain: s.activeVaultBaseChain,
  });
  const { aptNetworkId } = dw;
  const baseUrl = APT_INDEXER[aptNetworkId] ?? APT_INDEXER['apt-mainnet'];
  try {
    const url = `${baseUrl}/accounts/${address}/resources?limit=50`;
    const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return [];
    const resources = await r.json() as Array<{ type: string; data: unknown }>;
    const tokenResources = resources.filter((res) => res.type.includes('0x4::token::Token'));
    return tokenResources.map((res) => {
      const d = res.data as { uri?: string; name?: string; description?: string };
      return {
        id: res.type,
        name: d.name ?? 'Aptos Token',
        description: d.description ?? undefined,
        imageUrl: d.uri ? filterImageUrl(d.uri, mode) : null,
        chain: 'aptos' as const,
        contractOrType: res.type,
      };
    });
  } catch {
    return [];
  }
}
