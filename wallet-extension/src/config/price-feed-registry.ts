/**
 * static registries for the price waterfall: CoinGecko ids, Pyth Hermes feed ids,
 * Chainlink (rpcUrl + feed address) per token, and GeckoTerminal DEX routes.
 *
 * these are price-oracle infrastructure: not user-configurable networks. editing
 * here means adding/changing a baked-in feed; user network preferences live elsewhere
 * (see `src/config/networks.ts` and `chromatika_active_networks_v1`).
 */

/** map from our canonical symbol to CoinGecko coin ID */
export const COINGECKO_IDS: Record<string, string> = {
  ETH: 'ethereum',
  BTC: 'bitcoin',
  SOL: 'solana',
  SUI: 'sui',
  APT: 'aptos',
  BNB: 'binancecoin',
  AVAX: 'avalanche-2',
  POL: 'matic-network',
  MATIC: 'matic-network',
  /** CoinGecko id: if ika is not listed yet, all sources return null and UI shows no USD (not $0). */
  IKA: 'ika-network',
};

/** Pyth Hermes feed IDs for major assets */
export const PYTH_FEED_IDS: Record<string, string> = {
  BTC: '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
  ETH: '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
  SOL: '0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
  BNB: '0x2f95862b045670cd22bee3114c39763a4a08beeb663b145d283c31d7d1101c4f',
  AVAX: '0x93da3352f9f1d105fdfe4971cfa80e9dd777bfc5d0f683ebb6e1294b492137b0',
  APT: '0x03ae4db29ed4ae33d323568895aa00337e658e348b37509f5372ae51f0af00d5',
  SUI: '0x23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744',
};

/**
 * Chainlink price oracle endpoints. each entry pairs an RPC URL (used to read the
 * on-chain `latestRoundData` view) with the feed contract address. the RPCs here are
 * deliberately Chainlink-specific public endpoints; they are not user network RPCs.
 */
export const CHAINLINK_FEEDS: Partial<Record<string, { rpcUrl: string; feedAddress: string }>> = {
  ETH: {
    rpcUrl: 'https://ethereum-rpc.publicnode.com',
    feedAddress: '0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419',
  },
  BTC: {
    rpcUrl: 'https://ethereum-rpc.publicnode.com',
    feedAddress: '0xf4030086522a5beea4988f8ca5b36dbc97bee88c',
  },
  BNB: {
    rpcUrl: 'https://bsc-dataseed.binance.org',
    feedAddress: '0x0567f2323251f0aab15c8dfb1967e4e8a7d42aee',
  },
  AVAX: {
    rpcUrl: 'https://api.avax.network/ext/bc/C/rpc',
    feedAddress: '0x0a77230d17318075983913bc2145db16c7366156',
  },
  POL: {
    rpcUrl: 'https://polygon-rpc.com',
    feedAddress: '0xab594600376ec9fd91f8e885dadf0ce036862de0',
  },
  MATIC: {
    rpcUrl: 'https://polygon-rpc.com',
    feedAddress: '0xab594600376ec9fd91f8e885dadf0ce036862de0',
  },
};

/** GeckoTerminal DEX TWAP fallback routes (for assets without major centralized listings, e.g. IKA). */
export const DEX_PRICE_ROUTES: Partial<Record<string, { network: string; tokenAddress: string }>> = {
  IKA: {
    network: 'sui-network',
    tokenAddress: '0x7262fb2f7a3a14c888c438a3cd9b912469a58cf60f367352c46584262e8299aa::ika::IKA',
  },
};

export const CHAINLINK_ABI = [
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function decimals() view returns (uint8)',
];
