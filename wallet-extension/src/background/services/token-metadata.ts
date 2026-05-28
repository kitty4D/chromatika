/**
 * token logo URL resolver.
 *
 * v1 is deterministic + network-free: it constructs a Trust Wallet assets URL
 * from the chain + token identifier (contract / mint / coin type). the verified
 * path shape is:
 *   blockchains/<folder>/assets/<id>/logo.png   (a specific token)
 *   blockchains/<folder>/info/logo.png           (the chain's native coin)
 *
 * the actual image BYTES are fetched, content-type checked, privacy-scrubbed
 * (credentials omit + no referrer) and cached for 7 days by the offscreen media
 * cache at render time - see `TokenIcon` -> `fetchCachedMediaBytes`. so a wrong
 * or missing URL is totally harmless: the offscreen fetch 404s, negative-caches
 * the miss for 5 min, and `TokenIcon` falls back to the letter glyph. that's why
 * we can hand out a best-effort URL here without doing any lookup ourselves.
 *
 * known v1 tradeoff: these are runtime `raw.githubusercontent.com` URLs. it's
 * privacy-safe (offscreen fetch strips IP-adjacent headers the same way it does
 * for NFT media) but it does depend on GitHub being up. the planned follow-up is
 * a vendored logo slice committed under `src/assets/token-logos/` + a richer
 * waterfall (on-chain Metaplex / Sui Display, Jupiter / CoinGecko lists) feeding
 * a chrome.storage.local metadata cache. wire `VENDORED_LOGO_OVERRIDE` to that
 * slice when it lands so the common tokens stop needing a network round-trip.
 */

import { getAddress } from 'ethers';

const TW_BASE = 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains';

/**
 * EVM chainId -> Trust Wallet `blockchains/<folder>` name. only the chains we're
 * confident about are listed; an unknown chainId returns `undefined` (glyph).
 */
const TW_EVM_FOLDER: Record<number, string> = {
  1: 'ethereum',
  10: 'optimism',
  56: 'smartchain',
  137: 'polygon',
  250: 'fantom',
  8453: 'base',
  42161: 'arbitrum',
  43114: 'avalanchec',
};

/**
 * vendored-slice override hook. empty in v1; populate from a committed index
 * (`chainKey -> chrome.runtime.getURL(...)`) once the vendor script ships, so
 * common tokens resolve to a bundled asset instead of runtime GitHub.
 */
const VENDORED_LOGO_OVERRIDE: Record<string, string> = {};

function vendored(chainKey: string): string | undefined {
  return VENDORED_LOGO_OVERRIDE[chainKey];
}

function nativeUrl(folder: string): string {
  return `${TW_BASE}/${folder}/info/logo.png`;
}

function assetUrl(folder: string, id: string): string {
  return `${TW_BASE}/${folder}/assets/${id}/logo.png`;
}

/**
 * EVM token logo. pass `null` contract for the chain's native coin.
 * the address is EIP-55 checksummed because Trust Wallet keys asset folders by
 * the checksummed form; a non-hex address yields `undefined` (glyph).
 */
export function evmTokenLogoUrl(chainId: number, contractAddress: string | null): string | undefined {
  const folder = TW_EVM_FOLDER[chainId];
  if (!folder) return undefined;
  if (!contractAddress) {
    return vendored(`evm:${chainId}:native`) ?? nativeUrl(folder);
  }
  let checksum: string;
  try {
    checksum = getAddress(contractAddress);
  } catch {
    return undefined;
  }
  return vendored(`evm:${chainId}:${checksum.toLowerCase()}`) ?? assetUrl(folder, checksum);
}

/** Solana token logo. pass `null` mint for native SOL. */
export function solanaTokenLogoUrl(mint: string | null): string {
  if (!mint) return vendored('solana:native') ?? nativeUrl('solana');
  return vendored(`solana:${mint}`) ?? assetUrl('solana', mint);
}

/**
 * native SUI logo. Trust Wallet only carries native SUI (non-native Sui coins
 * are keyed by `0xpkg::module::TYPE`, which isn't an address-indexed asset
 * folder), so callers gate this behind a native-coin check.
 */
export function suiNativeLogoUrl(): string {
  return vendored('sui:native') ?? nativeUrl('sui');
}
