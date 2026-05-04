/**
 * Active networks fixture - field names match what the wallet's UI helpers actually
 * read at runtime: `networks.bitcoin` (not `btc`), `suiNetworkId` (not `suiNetwork`),
 * `evm[i].explorerUrl` (not `explorer`), `aptNetworkId` (not `aptosNetworkId`).
 *
 * Real shape comes from `trpc.getNetworks.query`. Cast to `Networks` at consumer
 * boundary - vite preview-build skips tsc so the shape only needs to match runtime
 * reads, not the full inferred type.
 */

export const NETWORKS = {
  active: {
    evmChainId: 1,
    suiNetworkId: 'sui-mainnet',
    solNetworkId: 'sol-mainnet',
    btcNetworkId: 'btc-mainnet',
    aptNetworkId: 'aptos-mainnet',
  },
  evm: [
    { chainId: 1, name: 'Ethereum', symbol: 'ETH', decimals: 18, rpcUrl: 'https://eth.llamarpc.com', explorerUrl: 'https://etherscan.io' },
    { chainId: 8453, name: 'Base', symbol: 'ETH', decimals: 18, rpcUrl: 'https://mainnet.base.org', explorerUrl: 'https://basescan.org' },
    { chainId: 42161, name: 'Arbitrum', symbol: 'ETH', decimals: 18, rpcUrl: 'https://arb1.arbitrum.io/rpc', explorerUrl: 'https://arbiscan.io' },
    { chainId: 10, name: 'Optimism', symbol: 'ETH', decimals: 18, rpcUrl: 'https://mainnet.optimism.io', explorerUrl: 'https://optimistic.etherscan.io' },
    { chainId: 137, name: 'Polygon', symbol: 'POL', decimals: 18, rpcUrl: 'https://polygon-rpc.com', explorerUrl: 'https://polygonscan.com' },
  ],
  sui: [
    { id: 'sui-mainnet', name: 'Sui Mainnet', graphqlUrl: 'https://sui-mainnet.mystenlabs.com/graphql' },
  ],
  solana: [
    { id: 'sol-mainnet', name: 'Solana Mainnet', rpcUrl: 'https://api.mainnet-beta.solana.com' },
  ],
  bitcoin: [
    { id: 'btc-mainnet', name: 'Bitcoin Mainnet', esploraUrl: 'https://blockstream.info/api' },
  ],
  aptos: [
    { id: 'aptos-mainnet', name: 'Aptos Mainnet', restUrl: 'https://api.mainnet.aptoslabs.com' },
  ],
} as const;
