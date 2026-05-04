/**
 * super-pro scan chain registry. these are chains chromatika **probes for activity** during the
 * advanced "scan for additional accounts" flow but does NOT add to the main network selector
 * (the network selector would be unusable with 30+ chains; users opt in per chain when scanning).
 *
 * the scan probe runs `eth_getBalance` + `eth_getTransactionCount` for evm entries; esplora
 * `/address/{addr}` for bitcoin; aptos indexer `/accounts/{addr}/balance/0x1::aptos_coin::AptosCoin`
 * + `/accounts/{addr}/transactions?limit=1` for aptos. balance = native coin only; token / nft
 * checks live in `nft.ts` + `price.ts` and run on demand after the user picks a candidate.
 *
 * **registry source rule**: chromatika's main `BUILTIN_EVM` already includes ethereum / base /
 * arbitrum / optimism / polygon / bsc / avalanche / monad / ink because those are wallet-grade
 * networks (the user can send + receive on them). everything in this file is **scan-only** -
 * we don't yet ship send / receive ux for these chains, but they're real networks where a user
 * could plausibly have activity worth surfacing during restore.
 */

export type ScanChainEntry =
  | { kind: 'evm'; id: string; name: string; chainId: number; rpcUrl: string; symbol: string; explorerUrl?: string }
  | { kind: 'bitcoin'; id: string; name: string; esploraUrl: string; cluster: 'mainnet' | 'signet' | 'testnet3' }
  | { kind: 'aptos'; id: string; name: string; rpcUrl: string; cluster: 'mainnet' | 'testnet' }
  | { kind: 'deso'; id: string; name: string; cluster: 'mainnet' | 'testnet' }
  | { kind: 'cosmos'; id: string; name: string; restUrl: string; bech32Hrp: string; nativeDenom: string; nativeDecimals: number; nativeSymbol: string }
  | { kind: 'polkadot'; id: string; name: string; subscanApiUrl: string; ss58Prefix: number; nativeDecimals: number; nativeSymbol: string };

/**
 * EVM long-tail + emerging chains - probed only when the user opts in via the super-pro toggle.
 * chains that are also in `BUILTIN_EVM` are intentionally NOT duplicated here; the scan
 * orchestrator merges both registries. note that some entries point at testnet-grade rpcs because
 * the chain hasn't shipped mainnet (e.g. `MegaETH`, `Tempo`) - flagged in the `name` field.
 */
export const SUPER_PRO_EVM: Extract<ScanChainEntry, { kind: 'evm' }>[] = [
  { kind: 'evm', id: 'evm-324', name: 'zkSync Era', chainId: 324, rpcUrl: 'https://mainnet.era.zksync.io', symbol: 'ETH', explorerUrl: 'https://explorer.zksync.io' },
  { kind: 'evm', id: 'evm-59144', name: 'Linea', chainId: 59144, rpcUrl: 'https://rpc.linea.build', symbol: 'ETH', explorerUrl: 'https://lineascan.build' },
  { kind: 'evm', id: 'evm-534352', name: 'Scroll', chainId: 534352, rpcUrl: 'https://rpc.scroll.io', symbol: 'ETH', explorerUrl: 'https://scrollscan.com' },
  { kind: 'evm', id: 'evm-81457', name: 'Blast', chainId: 81457, rpcUrl: 'https://rpc.blast.io', symbol: 'ETH', explorerUrl: 'https://blastscan.io' },
  { kind: 'evm', id: 'evm-5000', name: 'Mantle', chainId: 5000, rpcUrl: 'https://rpc.mantle.xyz', symbol: 'MNT', explorerUrl: 'https://mantlescan.xyz' },
  { kind: 'evm', id: 'evm-130', name: 'Unichain', chainId: 130, rpcUrl: 'https://mainnet.unichain.org', symbol: 'ETH', explorerUrl: 'https://uniscan.xyz' },
  { kind: 'evm', id: 'evm-4689', name: 'IoTeX', chainId: 4689, rpcUrl: 'https://babel-api.mainnet.iotex.io', symbol: 'IOTX', explorerUrl: 'https://iotexscan.io' },
  { kind: 'evm', id: 'evm-200901', name: 'Bitlayer', chainId: 200901, rpcUrl: 'https://rpc.bitlayer.org', symbol: 'BTC', explorerUrl: 'https://www.btrscan.com' },
  { kind: 'evm', id: 'evm-2741', name: 'Abstract', chainId: 2741, rpcUrl: 'https://api.mainnet.abs.xyz', symbol: 'ETH', explorerUrl: 'https://abscan.org' },
  { kind: 'evm', id: 'evm-999', name: 'HyperEVM', chainId: 999, rpcUrl: 'https://rpc.hyperliquid.xyz/evm', symbol: 'HYPE', explorerUrl: 'https://hyperevmscan.io' },
  { kind: 'evm', id: 'evm-4326', name: 'MegaETH', chainId: 4326, rpcUrl: 'https://mainnet.megaeth.com/rpc', symbol: 'ETH', explorerUrl: 'https://megaeth.blockscout.com' },
  { kind: 'evm', id: 'evm-33139', name: 'ApeChain', chainId: 33139, rpcUrl: 'https://rpc.apechain.com', symbol: 'APE', explorerUrl: 'https://apescan.io' },
  { kind: 'evm', id: 'evm-1868', name: 'Soneium', chainId: 1868, rpcUrl: 'https://rpc.soneium.org', symbol: 'ETH', explorerUrl: 'https://soneium.blockscout.com' },
  // tempo: stripe l2 mainnet, chain id 4217 per chainlist.org. native currency is USD (USDC-pegged
  // gas token) - the probe still passes "USD" as the symbol and 18 decimals like other evm chains;
  // when chromatika ships fiat-priced gas display, this entry can flag the unit override.
  { kind: 'evm', id: 'evm-4217', name: 'Tempo Mainnet', chainId: 4217, rpcUrl: 'https://rpc.mainnet.tempo.xyz', symbol: 'USD', explorerUrl: 'https://explorer.tempo.xyz' },
  // deso: separate L1 (not evm), needs its own probe shape - tracked as a future entry, intentionally omitted here.
];

/** Bitcoin networks scanned in super-pro mode. mainnet + signet per the user's spec; testnet3 is supported but off by default. */
export const SUPER_PRO_BITCOIN: Extract<ScanChainEntry, { kind: 'bitcoin' }>[] = [
  { kind: 'bitcoin', id: 'btc-mainnet', name: 'Bitcoin Mainnet', esploraUrl: 'https://blockstream.info/api', cluster: 'mainnet' },
  { kind: 'bitcoin', id: 'btc-signet', name: 'Bitcoin Signet', esploraUrl: 'https://blockstream.info/signet/api', cluster: 'signet' },
];

/** Aptos networks scanned in super-pro mode. */
export const SUPER_PRO_APTOS: Extract<ScanChainEntry, { kind: 'aptos' }>[] = [
  { kind: 'aptos', id: 'apt-mainnet', name: 'Aptos Mainnet', rpcUrl: 'https://fullnode.mainnet.aptoslabs.com/v1', cluster: 'mainnet' },
  { kind: 'aptos', id: 'apt-testnet', name: 'Aptos Testnet', rpcUrl: 'https://fullnode.testnet.aptoslabs.com/v1', cluster: 'testnet' },
];

/**
 * DeSo (decentralized social) - separate L1 with its own REST API. probe encodes the candidate's
 * 33-byte secp256k1 compressed pubkey as a base58check address (`BC1Y...` mainnet) via
 * `encodeDeSoAddress`, then queries `getUsersStateless([address])` on the DeSo node for balance
 * + profile presence. uses chromatika's existing `deso-node-client` so the user's configured
 * node URL (`chromatika_deso_node_v1`) flows through automatically.
 *
 * node URL is resolved at probe time from chrome.storage; the entry below carries no URL on
 * purpose to keep the scan-chain registry shape consistent with non-rpc-bound entries.
 */
export const SUPER_PRO_DESO: Extract<ScanChainEntry, { kind: 'deso' }>[] = [
  { kind: 'deso', id: 'deso-mainnet', name: 'DeSo Mainnet', cluster: 'mainnet' },
  // testnet entry: same node API + bech32 prefix swap. user must point `chromatika_deso_node_v1`
  // at a testnet node for this entry to actually return testnet balances; the scan probe doesn't
  // pin per-cluster endpoints because chromatika treats node URL as a single user-config knob.
  { kind: 'deso', id: 'deso-testnet', name: 'DeSo Testnet', cluster: 'testnet' },
];

/**
 * Cosmos-SDK chains. shipped as the proof-of-extension for non-EVM long-tail support: each
 * entry's bech32 HRP + native denom is the only per-chain variation (Cosmos Hub uses `cosmos` /
 * `uatom`, Osmosis uses `osmo` / `uosmo`, Juno uses `juno` / `ujuno`, etc.). adding more chains
 * is a one-line append - the probe is HRP-driven and the REST shape is uniform across SDK
 * v0.45+. all use the chromatika-secp256k1 derivation rule (ripemd160(sha256(pubkey))).
 *
 * public RPC endpoints from publicnode + the chain's official archives. user-supplied node
 * overrides are a future enhancement.
 */
export const SUPER_PRO_COSMOS: Extract<ScanChainEntry, { kind: 'cosmos' }>[] = [
  {
    kind: 'cosmos',
    id: 'cosmos-hub',
    name: 'Cosmos Hub',
    restUrl: 'https://cosmos-rest.publicnode.com',
    bech32Hrp: 'cosmos',
    nativeDenom: 'uatom',
    nativeDecimals: 6,
    nativeSymbol: 'ATOM',
  },
  {
    kind: 'cosmos',
    id: 'osmosis',
    name: 'Osmosis',
    restUrl: 'https://osmosis-rest.publicnode.com',
    bech32Hrp: 'osmo',
    nativeDenom: 'uosmo',
    nativeDecimals: 6,
    nativeSymbol: 'OSMO',
  },
  {
    kind: 'cosmos',
    id: 'juno',
    name: 'Juno',
    restUrl: 'https://juno-rest.publicnode.com',
    bech32Hrp: 'juno',
    nativeDenom: 'ujuno',
    nativeDecimals: 6,
    nativeSymbol: 'JUNO',
  },
  {
    kind: 'cosmos',
    id: 'stargaze',
    name: 'Stargaze',
    restUrl: 'https://stargaze-rest.publicnode.com',
    bech32Hrp: 'stars',
    nativeDenom: 'ustars',
    nativeDecimals: 6,
    nativeSymbol: 'STARS',
  },
  {
    kind: 'cosmos',
    id: 'akash',
    name: 'Akash',
    restUrl: 'https://akash-rest.publicnode.com',
    bech32Hrp: 'akash',
    nativeDenom: 'uakt',
    nativeDecimals: 6,
    nativeSymbol: 'AKT',
  },
  {
    kind: 'cosmos',
    id: 'stride',
    name: 'Stride',
    restUrl: 'https://stride-rest.publicnode.com',
    bech32Hrp: 'stride',
    nativeDenom: 'ustrd',
    nativeDecimals: 6,
    nativeSymbol: 'STRD',
  },
  {
    kind: 'cosmos',
    id: 'sei',
    name: 'Sei',
    restUrl: 'https://sei-rest.publicnode.com',
    bech32Hrp: 'sei',
    nativeDenom: 'usei',
    nativeDecimals: 6,
    nativeSymbol: 'SEI',
  },
];

/**
 * Polkadot / Kusama / generic Substrate chains. Subscan REST API powers the probe (free tier,
 * rate-limited but no API key required for low volumes).
 *
 * **derivation note**: chromatika derives Polkadot ed25519 at `m/44'/354'/N'/0'/0'` via slip-10.
 * polkadot.js / Talisman / Nova default to sr25519 with substrate's native (non-slip10)
 * derivation, so the chromatika address from the same phrase will NOT match what those wallets
 * produce. recovery only works when the user creates their account in chromatika directly OR
 * uses ed25519 + slip-10 in another wallet. switch to substrate-native derivation is a future
 * slice if user demand surfaces.
 */
export const SUPER_PRO_POLKADOT: Extract<ScanChainEntry, { kind: 'polkadot' }>[] = [
  {
    kind: 'polkadot',
    id: 'polkadot-relay',
    name: 'Polkadot',
    subscanApiUrl: 'https://polkadot.api.subscan.io',
    ss58Prefix: 0,
    nativeDecimals: 10,
    nativeSymbol: 'DOT',
  },
  {
    kind: 'polkadot',
    id: 'kusama-relay',
    name: 'Kusama',
    subscanApiUrl: 'https://kusama.api.subscan.io',
    ss58Prefix: 2,
    nativeDecimals: 12,
    nativeSymbol: 'KSM',
  },
];

/**
 * **TON intentionally deferred.** TON addresses derive from a SHA-256 of the wallet's TVM
 * stateInit cell (`workchain || hash(stateInit)`), where stateInit is a TVM cell that includes
 * the wallet contract code (varies per wallet version: v3R1, v3R2, v4R1, v4R2, w5) plus the
 * pubkey + subwallet ID. computing this correctly requires either:
 *   1. importing `@ton/core` + `@ton/crypto` (~200kb minified, adds a TVM cell encoder + a BoC
 *      serializer), OR
 *   2. hand-rolling the cell hash math against a pinned wallet contract version.
 *
 * neither is justified for chromatika today: TON's user base on EVM-style HD phrases is small
 * (most TON users use the TonKeeper / MyTonWallet 24-word phrases that follow TON's own
 * derivation, not BIP44), and the TonAPI pubkey-lookup endpoint that would let us bypass the
 * stateInit math isn't documented as stable. revisit when a real user request lands; the
 * registry shape (`kind: 'ton'` variant + a `makeTonProbe`) follows the same pattern as Cosmos
 * / Polkadot / DeSo - bounded ~200 lines once the address derivation is settled.
 */

/** Flat catalog used by the scan orchestrator + super-pro chain picker UI. */
export const SUPER_PRO_CHAINS: ScanChainEntry[] = [
  ...SUPER_PRO_EVM,
  ...SUPER_PRO_BITCOIN,
  ...SUPER_PRO_APTOS,
  ...SUPER_PRO_DESO,
  ...SUPER_PRO_COSMOS,
  ...SUPER_PRO_POLKADOT,
];

export function findSuperProChainById(id: string): ScanChainEntry | undefined {
  return SUPER_PRO_CHAINS.find((c) => c.id === id);
}
