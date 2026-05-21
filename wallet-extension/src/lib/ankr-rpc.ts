/**
 * Ankr multichain RPC URL helpers (freemium API key). Bake the per-chain `rpc.ankr.com/<chain>/<key>`
 * shape in one place so it can be wired into:
 *  - built-in EVM presets ([`config/networks.ts`](../config/networks.ts) `BUILTIN_EVM` rpcUrl per chain)
 *  - the EVM fallback rotation ([`chains/evm-send.ts`](../background/chains/evm-send.ts) `CHAIN_FALLBACK_RPC`)
 *  - built-in Solana presets ([`config/networks.ts`](../config/networks.ts) `builtinSolanaPresetRpcUrl`,
 *    used after Helius is exhausted)
 *
 * the key is `VITE_ANKR_API_KEY` (set in `.env`; vite bakes at build time). every helper returns
 * `null` when the key is missing so callers can short-circuit to their existing keyless
 * fallback chain without an `if`-soup at each site.
 *
 * what Ankr DOES NOT cover well in chromatika:
 *  - Sui: Ankr offers JSON-RPC, chromatika is GraphQL-only (`SuiGraphQLClient` everywhere).
 *  - Bitcoin: chromatika uses Esplora REST; Ankr exposes a BTC JSON-RPC node which doesn't
 *    match. balance/utxo reads stay on `blockstream.info`.
 *  - Aptos: Ankr's Aptos REST endpoint shape (`/http/aptos/<key>/v1`) is non-obvious vs the
 *    standard Aptos node REST URL. left for a follow-up.
 *  - NFTs: Alchemy (EVM) + Helius DAS (Solana) already cover this; no Ankr NFT route here.
 *
 * one design note: we intentionally do NOT route the dapp-bridge through Ankr for chains where
 * the dapp picks its own RPC. dapps that use `eth_sendTransaction` via injection are still
 * served by the wallet's primary RPC, which IS upgraded to Ankr when the key is set.
 */

function trimAnkrKey(): string {
  const raw = import.meta.env.VITE_ANKR_API_KEY;
  return typeof raw === 'string' ? raw.trim() : '';
}

/** map a numeric EVM chainId to the Ankr URL slug, or `null` for chains Ankr doesn't expose
 * (or that we haven't validated). the freemium tier covers all the slugs listed below at
 * 1500 req/min - more than enough for one user's wallet activity. paid plans bump the limit
 * but the URL shape is identical. */
function ankrEvmChainSlug(chainId: number): string | null {
  switch (chainId) {
    case 1:
      return 'eth';
    case 10:
      return 'optimism';
    case 56:
      return 'bsc';
    case 100:
      return 'gnosis';
    case 137:
      return 'polygon';
    case 250:
      return 'fantom';
    case 8453:
      return 'base';
    case 42161:
      return 'arbitrum';
    case 43114:
      return 'avalanche';
    case 11155111:
      return 'eth_sepolia';
    default:
      return null;
  }
}

/** keyed EVM RPC URL for `chainId`, or `null` if the key is missing or the chain isn't
 * covered. callers should fall through to existing keyless RPCs when this returns `null`. */
export function tryAnkrEvmRpcUrl(chainId: number): string | null {
  const key = trimAnkrKey();
  if (!key) return null;
  const slug = ankrEvmChainSlug(chainId);
  if (!slug) return null;
  return `https://rpc.ankr.com/${slug}/${encodeURIComponent(key)}`;
}

/** keyless Ankr URL for `chainId` (no auth header). useful as the LAST entry in a fallback
 * list - Ankr serves a limited rate from these for ASN-allowlisted clients, so it's better
 * than nothing when the primary + keyed + publicnode all fail. */
export function ankrEvmKeylessRpcUrl(chainId: number): string | null {
  const slug = ankrEvmChainSlug(chainId);
  if (!slug) return null;
  return `https://rpc.ankr.com/${slug}`;
}

/** keyed Solana cluster RPC URL, or `null` if the key is missing or the cluster isn't
 * covered. `testnet` returns null - Ankr's Solana coverage is mainnet + devnet only on the
 * freemium tier (testnet sees almost no real traffic and the Solana Labs testnet endpoint
 * is fine). */
export function tryAnkrSolanaRpcUrl(cluster: 'mainnet' | 'devnet' | 'testnet'): string | null {
  const key = trimAnkrKey();
  if (!key) return null;
  if (cluster === 'mainnet') return `https://rpc.ankr.com/solana/${encodeURIComponent(key)}`;
  if (cluster === 'devnet') return `https://rpc.ankr.com/solana_devnet/${encodeURIComponent(key)}`;
  return null;
}

/** convenience boolean for UI hints / status pages - "is the Ankr key wired into this build?". */
export function isAnkrConfigured(): boolean {
  return trimAnkrKey().length > 0;
}
