import type { IkaClient } from '@ika.xyz/sdk';
import { deriveChainAddressesFromActivePublicOutput } from '@/background/chains/dwallet-derived-addresses';

/** prefer ED25519 `public_output` Sui address from anchor dWallet; else fee payer. */
export async function resolveAnchoredDiscoverySuiAddress(
  ikaClient: IkaClient,
  anchorDwalletId: string,
  fallbackSuiAddress: string,
): Promise<string> {
  try {
    const d = await ikaClient.getDWallet(anchorDwalletId);
    const state = d.state as { Active?: { public_output?: number[] }; $kind?: string };
    if (state?.$kind === 'Active' && state.Active?.public_output?.length) {
      const addrs = await deriveChainAddressesFromActivePublicOutput(
        'ED25519',
        Uint8Array.from(state.Active.public_output),
        'mainnet',
      );
      if (addrs.sui) return addrs.sui;
    }
  } catch {
    /* use fallback */
  }
  return fallbackSuiAddress;
}
