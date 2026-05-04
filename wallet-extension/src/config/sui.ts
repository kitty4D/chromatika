/**
 * official Sui GraphQL HTTP API (see sui docs / GraphiQL).
 * vault `network` picks which host `SuiGraphQLClient` uses for balances, PTB
 * execution, NFT / kiosk / activity reads, and SuiNS lookups. the wallet no
 * longer talks Mysten JSON-RPC at all.
 */
export const SUI_GRAPHQL_URL = {
  mainnet: 'https://graphql.mainnet.sui.io/graphql',
  testnet: 'https://graphql.testnet.sui.io/graphql',
} as const;

export type SuiNetworkId = keyof typeof SUI_GRAPHQL_URL;

/** maps settings registry id (`sui-mainnet`, `sui-testnet`) to vault ika `SuiNetworkId`. */
export function registrySuiIdToSuiNetworkId(registryId: string): SuiNetworkId {
  if (registryId === 'sui-testnet') return 'testnet';
  return 'mainnet';
}

export function graphqlUrlForNetwork(network: SuiNetworkId): string {
  return SUI_GRAPHQL_URL[network];
}
