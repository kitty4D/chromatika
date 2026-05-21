/**
 * Forward name resolution for the Send recipient step.
 *
 * 4 chains, 4 resolvers, all best-effort - failure means "treat input as a raw address"
 * downstream. each helper returns `null` when the name doesn't resolve.
 *
 *   - `.sui`         -> SuiNS (Mysten on-chain registry, queried via GraphQL).
 *   - `.eth` + most ENS TLDs -> ENS (mainnet, via ethers' `resolveName`).
 *   - `.sol` + AllDomains TLDs -> SNS.id proxy API (forward lookup HTTPS endpoint).
 *   - `.apt`         -> Aptos Names Service public REST API.
 *
 * suiKER's Android `AddressChainViewModel.kt` runs name lookups with a 500ms debounce
 * and shows a "verified ✓ name -> 0xabc..." pill below the recipient input. We mirror
 * that UX on the chromatika side panel; the debounce is enforced by the caller (UI).
 *
 * caching: each resolver is wrapped by a small in-memory SWR cache keyed on
 * `${chain}:${name}` with a 5-min TTL. Names rarely change; resolving on every keystroke
 * would hammer the upstream APIs / RPCs. cache lives in this module's closure so it
 * survives across tRPC calls within one SW lifecycle (not persistent across SW restarts;
 * that's fine - the user re-types or the cache rebuilds in seconds).
 */

import { createSuiGraphQLClientFromRegistryNetworkId } from '@/background/sui-client';
import { tryAnkrEvmRpcUrl } from '@/lib/ankr-rpc';
import { findEvmNetwork } from '@/config/networks';
import { getCustomNetworks } from '@/background/network/custom-networks';
import { JsonRpcProvider } from 'ethers';
import { PublicKey } from '@solana/web3.js';

export type ResolveChain = 'sui' | 'evm' | 'sol' | 'apt';

export type ResolveNameResult = {
  resolved: string | null;
  source: 'suins' | 'ens' | 'sns' | 'apt' | null;
  cacheHit: boolean;
};

const CACHE_TTL_MS = 5 * 60 * 1000;
type CacheEntry = { resolved: string | null; source: ResolveNameResult['source']; expiresAt: number };
const memoryCache = new Map<string, CacheEntry>();

function cacheKey(chain: ResolveChain, name: string): string {
  return `${chain}:${name.trim().toLowerCase()}`;
}

function readCache(chain: ResolveChain, name: string): ResolveNameResult | null {
  const k = cacheKey(chain, name);
  const hit = memoryCache.get(k);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    memoryCache.delete(k);
    return null;
  }
  return { resolved: hit.resolved, source: hit.source, cacheHit: true };
}

function writeCache(chain: ResolveChain, name: string, resolved: string | null, source: ResolveNameResult['source']): void {
  const k = cacheKey(chain, name);
  memoryCache.set(k, { resolved, source, expiresAt: Date.now() + CACHE_TTL_MS });
}

/** looks like a name not an address - has a dot, doesn't start with 0x/base58-only. */
export function looksLikeName(input: string): boolean {
  const s = input.trim();
  if (s.length === 0) return false;
  if (!s.includes('.')) return false;
  if (s.startsWith('0x')) return false; // 0x... is an address shape, not a name
  // bare base58 (Solana addresses) never have a dot, so the dot check above is enough.
  return true;
}

/** SuiNS forward lookup via GraphQL.
 *
 * Mysten's GraphQL exposes `resolveSuinsAddress(domain)` returning `{ address }`. mainnet
 * is the source of truth - testnet has its own registry but no users rely on it for sends.
 */
async function resolveSuiNs(name: string): Promise<string | null> {
  try {
    // mainnet only; SuiNS on testnet exists but no one routes a real send through it.
    const client = createSuiGraphQLClientFromRegistryNetworkId('sui-mainnet');
    const res = (await (client as unknown as {
      query: (opts: { query: string; variables: Record<string, unknown> }) => Promise<{ data?: { resolveSuinsAddress?: { address?: string } | null } | null }>;
    }).query({
      query: 'query ResolveSuiNs($domain: String!) { resolveSuinsAddress(domain: $domain) { address } }',
      variables: { domain: name },
    }));
    const addr = res?.data?.resolveSuinsAddress?.address;
    return typeof addr === 'string' && addr.startsWith('0x') ? addr : null;
  } catch (e) {
    console.warn('[name-resolver] SuiNS lookup failed', { name, error: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

/** ENS forward lookup via ethers on Ethereum mainnet.
 *
 * Uses the wallet's chain-1 primary RPC (Ankr-keyed when VITE_ANKR_API_KEY is set). ENS
 * resolution requires mainnet because that's where the registry lives; users sending on
 * L2s still get their `name.eth` resolved against the L1 registry.
 */
async function resolveEns(name: string): Promise<string | null> {
  try {
    const { evm: customEvm } = await getCustomNetworks();
    const net = findEvmNetwork(1, customEvm);
    const rpcUrl = tryAnkrEvmRpcUrl(1) ?? net?.rpcUrl ?? 'https://ethereum-rpc.publicnode.com';
    const provider = new JsonRpcProvider(rpcUrl);
    const addr = await provider.resolveName(name);
    return typeof addr === 'string' && /^0x[a-fA-F0-9]{40}$/.test(addr) ? addr : null;
  } catch (e) {
    console.warn('[name-resolver] ENS lookup failed', { name, error: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

/** SNS forward lookup via the public sdk-proxy.
 *
 * SNS.id (Bonfida-operated) exposes a `domain-key` endpoint that returns the owner's
 * base58 Solana address for any registered `.sol` name. AllDomains TLDs flow through the
 * same proxy. We treat the proxy as authoritative for sends - if the user pastes a name
 * that resolves to a typo address, that's between them and the registrar.
 */
async function resolveSns(name: string): Promise<string | null> {
  try {
    const url = `https://sns-sdk-proxy.bonfida.workers.dev/resolve/${encodeURIComponent(name)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const j = (await res.json()) as { s?: string; result?: string };
    if (j.s !== 'ok' || typeof j.result !== 'string' || !j.result.trim()) return null;
    const candidate = j.result.trim();
    try {
      new PublicKey(candidate); // validate base58 -> 32 bytes
      return candidate;
    } catch {
      return null;
    }
  } catch (e) {
    console.warn('[name-resolver] SNS lookup failed', { name, error: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

/** Aptos Names Service forward lookup via the public REST API.
 *
 * Aptos Names is operated by Aptos Labs at `aptosnames.com`. The `/api/v1/address/{name}`
 * endpoint returns `{ address: "0x..." }` for registered names. Returns null on miss.
 */
async function resolveAptosName(name: string): Promise<string | null> {
  try {
    // ANS expects the bare name (no `.apt` suffix), but accepts both forms in practice.
    const clean = name.toLowerCase().endsWith('.apt') ? name.slice(0, -4) : name;
    const url = `https://www.aptosnames.com/api/v1/address/${encodeURIComponent(clean)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const j = (await res.json()) as { address?: string };
    return typeof j.address === 'string' && j.address.startsWith('0x') ? j.address : null;
  } catch (e) {
    console.warn('[name-resolver] Aptos Names lookup failed', { name, error: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Reverse resolution: address -> human name. Used by TxDetailModal to render
// "vitalik.eth" pills next to counterparty addresses.
// ---------------------------------------------------------------------------

export type ReverseNameResult = {
  name: string | null;
  source: 'ens' | 'suins' | 'sns' | 'apt' | null;
  cacheHit: boolean;
};

const reverseCache = new Map<string, { name: string | null; source: ReverseNameResult['source']; expiresAt: number }>();

function reverseCacheKey(chain: ResolveChain, address: string): string {
  // EVM + Sui + Aptos are case-insensitive; Solana is case-sensitive (base58).
  const norm = chain === 'sol' ? address : address.toLowerCase();
  return `rev:${chain}:${norm}`;
}

/** ENS reverse: `provider.lookupAddress(addr)` - returns the primary name or null. */
async function reverseEns(address: string): Promise<string | null> {
  try {
    const { evm: customEvm } = await getCustomNetworks();
    const net = findEvmNetwork(1, customEvm);
    const rpcUrl = tryAnkrEvmRpcUrl(1) ?? net?.rpcUrl ?? 'https://ethereum-rpc.publicnode.com';
    const provider = new JsonRpcProvider(rpcUrl);
    return await provider.lookupAddress(address);
  } catch (e) {
    console.warn('[name-resolver] ENS reverse failed', { address, error: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

/** SuiNS reverse via Mysten GraphQL: lookup primary name for an address. */
async function reverseSuiNs(address: string): Promise<string | null> {
  try {
    const client = createSuiGraphQLClientFromRegistryNetworkId('sui-mainnet');
    const res = (await (client as unknown as {
      query: (opts: { query: string; variables: Record<string, unknown> }) => Promise<{ data?: { address?: { defaultSuinsName?: string | null } | null } | null }>;
    }).query({
      query: 'query ReverseSuiNs($addr: SuiAddress!) { address(address: $addr) { defaultSuinsName } }',
      variables: { addr: address },
    }));
    const name = res?.data?.address?.defaultSuinsName;
    return typeof name === 'string' && name.length > 0 ? name : null;
  } catch (e) {
    console.warn('[name-resolver] SuiNS reverse failed', { address, error: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

/** SNS reverse via Bonfida sdk-proxy. */
async function reverseSns(address: string): Promise<string | null> {
  try {
    const r = await fetch(`https://sns-sdk-proxy.bonfida.workers.dev/reverse-lookup/${encodeURIComponent(address)}`, {
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { s?: string; result?: string };
    if (j.s !== 'ok' || typeof j.result !== 'string' || !j.result.trim()) return null;
    const n = j.result.trim();
    return n.endsWith('.sol') ? n : `${n}.sol`;
  } catch (e) {
    console.warn('[name-resolver] SNS reverse failed', { address, error: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

/** Aptos Names reverse via `aptosnames.com/api/v1/primary-name/:address`. */
async function reverseAptosName(address: string): Promise<string | null> {
  try {
    const r = await fetch(`https://www.aptosnames.com/api/v1/primary-name/${encodeURIComponent(address)}`, {
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { name?: string };
    if (typeof j.name === 'string' && j.name.length > 0) {
      return j.name.endsWith('.apt') ? j.name : `${j.name}.apt`;
    }
    return null;
  } catch (e) {
    console.warn('[name-resolver] Aptos Names reverse failed', { address, error: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

/** reverse-lookup an address to a human name on the given chain. cached 5 min. */
export async function reverseLookupName(address: string, chain: ResolveChain): Promise<ReverseNameResult> {
  const trimmed = address.trim();
  if (!trimmed) return { name: null, source: null, cacheHit: false };

  const cacheKey = reverseCacheKey(chain, trimmed);
  const hit = reverseCache.get(cacheKey);
  if (hit && Date.now() < hit.expiresAt) {
    return { name: hit.name, source: hit.source, cacheHit: true };
  }

  let name: string | null = null;
  let source: ReverseNameResult['source'] = null;
  switch (chain) {
    case 'evm':
      name = await reverseEns(trimmed);
      source = name ? 'ens' : null;
      break;
    case 'sui':
      name = await reverseSuiNs(trimmed);
      source = name ? 'suins' : null;
      break;
    case 'sol':
      name = await reverseSns(trimmed);
      source = name ? 'sns' : null;
      break;
    case 'apt':
      name = await reverseAptosName(trimmed);
      source = name ? 'apt' : null;
      break;
  }
  reverseCache.set(cacheKey, { name, source, expiresAt: Date.now() + CACHE_TTL_MS });
  return { name, source, cacheHit: false };
}

/**
 * resolve a name on the given chain. caches successful and null results for 5 min.
 *
 * the caller (UI) is expected to:
 *  - debounce keystrokes (~500ms) before invoking, so we don't hit upstreams on every char
 *  - call only when `looksLikeName(input) === true`
 *  - replace the input with `resolved` (if non-null) before submitting the send
 */
export async function resolveName(name: string, chain: ResolveChain): Promise<ResolveNameResult> {
  const trimmed = name.trim();
  if (!trimmed) return { resolved: null, source: null, cacheHit: false };

  const cached = readCache(chain, trimmed);
  if (cached) return cached;

  let resolved: string | null = null;
  let source: ResolveNameResult['source'] = null;
  switch (chain) {
    case 'sui':
      resolved = await resolveSuiNs(trimmed);
      source = resolved ? 'suins' : null;
      break;
    case 'evm':
      resolved = await resolveEns(trimmed);
      source = resolved ? 'ens' : null;
      break;
    case 'sol':
      resolved = await resolveSns(trimmed);
      source = resolved ? 'sns' : null;
      break;
    case 'apt':
      resolved = await resolveAptosName(trimmed);
      source = resolved ? 'apt' : null;
      break;
  }

  writeCache(chain, trimmed, resolved, source);
  return { resolved, source, cacheHit: false };
}
