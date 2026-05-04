// --- type definitions (trust wallet registry.json-inspired) ---

export type EvmNetwork = {
  id: string;
  name: string;
  chainId: number;
  rpcUrl: string;
  symbol: string;
  decimals: number;
  explorerUrl?: string;
  isCustom: boolean;
};

export type SolanaNetwork = {
  id: string;
  name: string;
  rpcUrl: string;
  type: 'solana';
  isCustom: boolean;
};

export type SuiNetwork = {
  id: string;
  name: string;
  /** SuiGraphQLClient endpoint */
  rpcUrl: string;
  type: 'sui';
  isCustom: boolean;
};

export type AptosNetwork = {
  id: string;
  name: string;
  rpcUrl: string;
  type: 'aptos';
  isCustom: boolean;
};

export type BitcoinNetwork = {
  id: string;
  name: string;
  esploraUrl: string;
  type: 'bitcoin';
  isCustom: boolean;
};

export type AnyNetwork = EvmNetwork | SolanaNetwork | SuiNetwork | AptosNetwork | BitcoinNetwork;

// --- built-in EVM networks ---

export const BUILTIN_EVM: EvmNetwork[] = [
  {
    id: 'evm-1',
    name: 'Ethereum',
    chainId: 1,
    rpcUrl: 'https://ethereum-rpc.publicnode.com',
    symbol: 'ETH',
    decimals: 18,
    explorerUrl: 'https://etherscan.io',
    isCustom: false,
  },
  {
    id: 'evm-8453',
    name: 'Base',
    chainId: 8453,
    rpcUrl: 'https://mainnet.base.org',
    symbol: 'ETH',
    decimals: 18,
    explorerUrl: 'https://basescan.org',
    isCustom: false,
  },
  {
    id: 'evm-42161',
    name: 'Arbitrum One',
    chainId: 42161,
    rpcUrl: 'https://arb1.arbitrum.io/rpc',
    symbol: 'ETH',
    decimals: 18,
    explorerUrl: 'https://arbiscan.io',
    isCustom: false,
  },
  {
    id: 'evm-10',
    name: 'Optimism',
    chainId: 10,
    rpcUrl: 'https://mainnet.optimism.io',
    symbol: 'ETH',
    decimals: 18,
    explorerUrl: 'https://optimistic.etherscan.io',
    isCustom: false,
  },
  {
    id: 'evm-137',
    name: 'Polygon',
    chainId: 137,
    rpcUrl: 'https://polygon-rpc.com',
    symbol: 'POL',
    decimals: 18,
    explorerUrl: 'https://polygonscan.com',
    isCustom: false,
  },
  {
    id: 'evm-56',
    name: 'BNB Smart Chain',
    chainId: 56,
    rpcUrl: 'https://bsc-dataseed.binance.org',
    symbol: 'BNB',
    decimals: 18,
    explorerUrl: 'https://bscscan.com',
    isCustom: false,
  },
  {
    id: 'evm-43114',
    name: 'Avalanche C-Chain',
    chainId: 43114,
    rpcUrl: 'https://api.avax.network/ext/bc/C/rpc',
    symbol: 'AVAX',
    decimals: 18,
    explorerUrl: 'https://snowtrace.io',
    isCustom: false,
  },
  {
    id: 'evm-143',
    name: 'Monad',
    chainId: 143,
    rpcUrl: 'https://rpc.monad.xyz',
    symbol: 'MON',
    decimals: 18,
    explorerUrl: 'https://monadvision.com',
    isCustom: false,
  },
  {
    id: 'evm-57073',
    name: 'Ink',
    chainId: 57073,
    rpcUrl: 'https://rpc-gel.inkonchain.com',
    symbol: 'ETH',
    decimals: 18,
    explorerUrl: 'https://explorer.inkonchain.com',
    isCustom: false,
  },
];

// --- built-in Solana networks ---

function trimViteHeliusKey(): string {
  const raw = import.meta.env.VITE_HELIUS_KEY;
  return typeof raw === 'string' ? raw.trim() : '';
}

/**
 * Helius JSON-RPC (same `VITE_HELIUS_KEY` as DAS in `nft.ts`). extensions often get 403 from the public
 * Solana Labs mainnet endpoint, so presets prefer Helius when the key is set at build time.
 */
export function tryHeliusSolanaRpcUrl(cluster: 'mainnet' | 'devnet'): string | null {
  const k = trimViteHeliusKey();
  if (!k) return null;
  const host = cluster === 'mainnet' ? 'mainnet.helius-rpc.com' : 'devnet.helius-rpc.com';
  return `https://${host}/?api-key=${encodeURIComponent(k)}`;
}

function builtinSolanaPresetRpcUrl(preset: 'mainnet' | 'devnet' | 'testnet'): string {
  if (preset === 'mainnet') {
    return tryHeliusSolanaRpcUrl('mainnet') ?? 'https://rpc.ankr.com/solana';
  }
  if (preset === 'devnet') {
    return tryHeliusSolanaRpcUrl('devnet') ?? 'https://api.devnet.solana.com';
  }
  return 'https://api.testnet.solana.com';
}

export const BUILTIN_SOLANA: SolanaNetwork[] = [
  {
    id: 'sol-mainnet',
    name: 'Solana Mainnet Beta',
    rpcUrl: builtinSolanaPresetRpcUrl('mainnet'),
    type: 'solana',
    isCustom: false,
  },
  {
    id: 'sol-devnet',
    name: 'Solana Devnet',
    rpcUrl: builtinSolanaPresetRpcUrl('devnet'),
    type: 'solana',
    isCustom: false,
  },
  {
    id: 'sol-testnet',
    name: 'Solana Testnet',
    rpcUrl: builtinSolanaPresetRpcUrl('testnet'),
    type: 'solana',
    isCustom: false,
  },
];

/** pre-release default cluster: ika Solana is devnet-first; mainnet stays in the registry for later. */
export const CHROMATIKA_DEFAULT_SOLANA_NETWORK_ID = 'sol-devnet' as const;

export function resolveBuiltinSolanaPreset(networkId: string | undefined): SolanaNetwork {
  if (networkId) {
    const hit = BUILTIN_SOLANA.find((n) => n.id === networkId);
    if (hit) return hit;
  }
  return (
    BUILTIN_SOLANA.find((n) => n.id === CHROMATIKA_DEFAULT_SOLANA_NETWORK_ID) ?? BUILTIN_SOLANA[0]!
  );
}

// --- built-in Sui networks (GraphQL endpoints for SuiGraphQLClient) ---

export const BUILTIN_SUI: SuiNetwork[] = [
  {
    id: 'sui-mainnet',
    name: 'Sui Mainnet',
    rpcUrl: 'https://graphql.mainnet.sui.io/graphql',
    type: 'sui',
    isCustom: false,
  },
  {
    id: 'sui-testnet',
    name: 'Sui Testnet',
    rpcUrl: 'https://graphql.testnet.sui.io/graphql',
    type: 'sui',
    isCustom: false,
  },
];

// --- built-in Aptos networks ---

export const BUILTIN_APTOS: AptosNetwork[] = [
  {
    id: 'apt-mainnet',
    name: 'Aptos Mainnet',
    rpcUrl: 'https://fullnode.mainnet.aptoslabs.com/v1',
    type: 'aptos',
    isCustom: false,
  },
  {
    id: 'apt-testnet',
    name: 'Aptos Testnet',
    rpcUrl: 'https://fullnode.testnet.aptoslabs.com/v1',
    type: 'aptos',
    isCustom: false,
  },
  {
    id: 'apt-devnet',
    name: 'Aptos Devnet',
    rpcUrl: 'https://fullnode.devnet.aptoslabs.com/v1',
    type: 'aptos',
    isCustom: false,
  },
];

// --- built-in Bitcoin networks (esplora API) ---

export const BUILTIN_BITCOIN: BitcoinNetwork[] = [
  {
    id: 'btc-mainnet',
    name: 'Bitcoin Mainnet',
    esploraUrl: 'https://blockstream.info/api',
    type: 'bitcoin',
    isCustom: false,
  },
  {
    id: 'btc-testnet3',
    name: 'Bitcoin Testnet3',
    esploraUrl: 'https://blockstream.info/testnet/api',
    type: 'bitcoin',
    isCustom: false,
  },
  {
    id: 'btc-signet',
    name: 'Bitcoin Signet',
    esploraUrl: 'https://blockstream.info/signet/api',
    type: 'bitcoin',
    isCustom: false,
  },
];

// --- lookup helpers ---

/**
 * built-in registry plus custom rows from settings (`chromatika_custom_networks_v1`).
 * custom wins on matching `chainId` so user-edited RPCs replace the built-in default for that chain.
 */
export function mergeEvmNetworksWithCustom(custom: EvmNetwork[]): EvmNetwork[] {
  const m = new Map<number, EvmNetwork>();
  for (const n of BUILTIN_EVM) m.set(n.chainId, n);
  for (const n of custom) m.set(n.chainId, n);
  return [...m.values()];
}

/** resolve the effective EVM network row (rpcUrl, symbol, etc.) for `chainId`, same merge as settings registry. */
export function findEvmNetwork(chainId: number, custom: EvmNetwork[] = []): EvmNetwork | undefined {
  return mergeEvmNetworksWithCustom(custom).find((n) => n.chainId === chainId);
}
