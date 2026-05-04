/**
 * EVM token balances for a single address on a chain (active-chain style).
 * cache 60s per address+chainId. arbitrum-first curated list + native, alchemy shortcut when RPC supports it.
 */

import { Contract, formatUnits, JsonRpcProvider } from 'ethers';
import { findEvmNetwork } from '@/config/networks';
import { getCustomNetworks } from '@/background/network/custom-networks';
import { sendEvmRpcWithRetry } from '@/background/chains/evm-send';
import { getPrice } from '@/background/services/price';
import { listWatchedEvmTokensForWallet } from '@/background/network/evm-watched-tokens';

export type EvmTokenBalanceRow = {
  contractAddress: string | null;
  symbol: string;
  name: string;
  decimals: number;
  balanceRaw: string;
  balanceFormatted: string;
  usdValue: number | null;
  iconUrl?: string;
};

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { at: number; tokens: EvmTokenBalanceRow[] }>();

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
];

type CuratedToken = {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  priceSymbol: string;
};

/** common Arbitrum One tokens for balance scans when not using Alchemy DEFAULT_TOKENS */
const ARBITRUM_CURATED: CuratedToken[] = [
  {
    address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    symbol: 'WETH',
    name: 'Wrapped Ether',
    decimals: 18,
    priceSymbol: 'ETH',
  },
  {
    address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    symbol: 'USDC',
    name: 'USD Coin',
    decimals: 6,
    priceSymbol: 'USDC',
  },
  {
    address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
    symbol: 'USDT',
    name: 'Tether USD',
    decimals: 6,
    priceSymbol: 'USDT',
  },
  {
    address: '0x912CE59144191C1204E64559FE8253a0e49E6548',
    symbol: 'ARB',
    name: 'Arbitrum',
    decimals: 18,
    priceSymbol: 'ARB',
  },
];

function cacheKey(address: string, chainId: number): string {
  return `${chainId}:${address.toLowerCase()}`;
}

/** call after wallet_watchAsset so the next balance read includes the new token. */
export function invalidateEvmTokenBalanceCache(walletAddress: string, chainId: number): void {
  cache.delete(cacheKey(walletAddress, chainId));
}

async function tryAlchemyTokenBalances(
  rpcUrl: string,
  chainId: number,
  walletAddress: string,
): Promise<Array<{ contractAddress: string; tokenBalance: string }> | null> {
  try {
    const raw = (await sendEvmRpcWithRetry(chainId, rpcUrl, 'alchemy_getTokenBalances', [
      walletAddress,
      'DEFAULT_TOKENS',
    ])) as { tokenBalances?: Array<{ contractAddress: string; tokenBalance: string }> };
    const list = raw?.tokenBalances;
    if (!list?.length) return null;
    return list.filter((x) => x.tokenBalance && x.tokenBalance !== '0x0' && x.tokenBalance !== '0x');
  } catch {
    return null;
  }
}

function clampErc20Decimals(raw: unknown): number {
  const n = typeof raw === 'bigint' ? Number(raw) : Number(raw);
  if (!Number.isFinite(n) || Number.isNaN(n)) return 18;
  const x = Math.trunc(n);
  if (x < 0) return 0;
  if (x > 36) return 36;
  return x;
}

async function readErc20Meta(
  provider: JsonRpcProvider,
  tokenAddress: string,
): Promise<{ symbol: string; name: string; decimals: number }> {
  const c = new Contract(tokenAddress, ERC20_ABI, provider);
  const [symbol, name, decimals] = await Promise.all([
    c.symbol().catch(() => '???'),
    c.name().catch(() => ''),
    c.decimals().catch(() => 18),
  ]);
  return {
    symbol: typeof symbol === 'string' ? symbol : String(symbol),
    name: typeof name === 'string' ? name : String(name),
    decimals: clampErc20Decimals(decimals),
  };
}

export async function fetchEvmTokenBalances(walletAddress: string, chainId: number): Promise<EvmTokenBalanceRow[]> {
  const { evm: customEvm } = await getCustomNetworks();
  const net = findEvmNetwork(chainId, customEvm);
  if (!net) throw new Error(`No network config for chain ${chainId}`);

  const ck = cacheKey(walletAddress, chainId);
  const hit = cache.get(ck);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.tokens;

  const provider = new JsonRpcProvider(net.rpcUrl);
  const rows: EvmTokenBalanceRow[] = [];

  const nativeBal = await provider.getBalance(walletAddress);
  if (nativeBal > 0n) {
    const sym = net.symbol || 'ETH';
    const dec = net.decimals ?? 18;
    const formatted = formatUnits(nativeBal, dec);
    const px = await getPrice(sym).catch(() => null);
    const usd = px != null ? parseFloat(formatted) * px : null;
    rows.push({
      contractAddress: null,
      symbol: sym,
      name: sym,
      decimals: dec,
      balanceRaw: nativeBal.toString(),
      balanceFormatted: formatted,
      usdValue: usd,
    });
  }

  const alchemyList = await tryAlchemyTokenBalances(net.rpcUrl, chainId, walletAddress);

  if (alchemyList?.length) {
    for (const item of alchemyList) {
      const bal = BigInt(item.tokenBalance);
      if (bal === 0n) continue;
      const meta = await readErc20Meta(provider, item.contractAddress);
      const formatted = formatUnits(bal, meta.decimals);
      const px = await getPrice(meta.symbol.toUpperCase()).catch(() => null);
      const usd = px != null ? parseFloat(formatted) * px : null;
      rows.push({
        contractAddress: item.contractAddress,
        symbol: meta.symbol,
        name: meta.name || meta.symbol,
        decimals: meta.decimals,
        balanceRaw: bal.toString(),
        balanceFormatted: formatted,
        usdValue: usd,
      });
    }
  } else if (chainId === 42161) {
    for (const t of ARBITRUM_CURATED) {
      const c = new Contract(t.address, ERC20_ABI, provider);
      const bal: bigint = await c.balanceOf(walletAddress).catch(() => 0n);
      if (bal === 0n) continue;
      const formatted = formatUnits(bal, t.decimals);
      const px = await getPrice(t.priceSymbol).catch(() => null);
      const usd = px != null ? parseFloat(formatted) * px : null;
      rows.push({
        contractAddress: t.address,
        symbol: t.symbol,
        name: t.name,
        decimals: t.decimals,
        balanceRaw: bal.toString(),
        balanceFormatted: formatted,
        usdValue: usd,
      });
    }
  }

  const watched = await listWatchedEvmTokensForWallet(chainId, walletAddress);
  const seen = new Set(
    rows.map((r) => r.contractAddress?.toLowerCase()).filter((x): x is string => !!x),
  );
  for (const w of watched) {
    const low = w.contractAddress.toLowerCase();
    if (seen.has(low)) continue;
    seen.add(low);
    const meta = await readErc20Meta(provider, w.contractAddress).catch(() => ({
      symbol: w.symbol,
      name: w.symbol,
      decimals: w.decimals,
    }));
    const c = new Contract(w.contractAddress, ERC20_ABI, provider);
    const bal: bigint = await c.balanceOf(walletAddress).catch(() => 0n);
    const formatted = formatUnits(bal, meta.decimals);
    const px = await getPrice(meta.symbol.toUpperCase()).catch(() => null);
    const usd = px != null ? parseFloat(formatted) * px : null;
    rows.push({
      contractAddress: w.contractAddress,
      symbol: meta.symbol,
      name: meta.name || meta.symbol,
      decimals: meta.decimals,
      balanceRaw: bal.toString(),
      balanceFormatted: formatted,
      usdValue: usd,
      iconUrl: w.image,
    });
  }

  rows.sort((a, b) => (b.usdValue ?? 0) - (a.usdValue ?? 0));
  cache.set(ck, { at: Date.now(), tokens: rows });
  return rows;
}
