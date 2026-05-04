import { KioskClient } from '@mysten/kiosk';
import type { OwnedKiosks, KioskData } from '@mysten/kiosk';
import { getActiveNetworks } from '@/background/network/active-network';
import { createSuiGraphQLClientFromRegistryNetworkId } from '@/background/sui-client';

// @mysten/kiosk 1.1.3 accepts SuiGraphQLClient as KioskCompatibleClient, so the
// whole kiosk path runs on the vault GraphQL transport (retry + throttle included).
const SUI_KIOSK_NETWORK: Record<string, 'mainnet' | 'testnet'> = {
  'sui-mainnet': 'mainnet',
  'sui-testnet': 'testnet',
};

async function buildKioskClient(): Promise<KioskClient> {
  const { suiNetworkId } = await getActiveNetworks();
  const network = SUI_KIOSK_NETWORK[suiNetworkId] ?? 'mainnet';
  const client = createSuiGraphQLClientFromRegistryNetworkId(suiNetworkId);
  return new KioskClient({ client, network });
}

export type OwnedKioskSummary = OwnedKiosks;

/** returns all kiosks owned or managed by the given Sui address. */
export async function getOwnedKiosks(address: string): Promise<OwnedKioskSummary> {
  const kc = await buildKioskClient();
  return kc.getOwnedKiosks({ address });
}

/** returns full kiosk data (items, listings, extensions) for one kiosk. */
export async function getKioskData(kioskId: string): Promise<KioskData> {
  const kc = await buildKioskClient();
  return kc.getKiosk({
    id: kioskId,
    options: {
      withKioskFields: true,
      withListingPrices: true,
    },
  });
}
