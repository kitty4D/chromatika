/**
 * read ika Solana devnet dWallet accounts (pre-alpha program) for discovery + adapter reads.
 * layout: skills/ika-solana-prealpha/references/account-layouts.md - DWallet table.
 */

import { Connection } from '@solana/web3.js';
import type { ZeroTrustDWallet } from '@ika.xyz/sdk';
import { fetchSolanaDWalletAccount } from '@/background/ika/solana-dwallet-account-read';
import { deriveChainAddressesFromActivePublicOutput } from '@/background/chains/dwallet-derived-addresses';
import type { DwalletCapChainAddresses } from '@/background/chains/dwallet-derived-addresses';

export {
  fetchSolanaDWalletAccount,
  parseSolanaDWalletAccountData,
  isSuiIkaDwalletObjectId,
} from '@/background/ika/solana-dwallet-account-read';

export async function chainAddressesForSolanaDwalletId(
  connection: Connection,
  dwalletIdB58: string,
): Promise<DwalletCapChainAddresses | undefined> {
  try {
    const { curveKey, publicOutput } = await fetchSolanaDWalletAccount(connection, dwalletIdB58);
    return await deriveChainAddressesFromActivePublicOutput(curveKey, publicOutput, 'mainnet');
  } catch (err) {
    console.warn('[chromatika][dwallet-derive] solana chain-addresses failed', {
      dwallet: dwalletIdB58,
      err: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/** minimal `ZeroTrustDWallet` shape for reads that only inspect curve + Active public_output. */
export async function buildSyntheticZeroTrustDWalletFromSolanaAccount(
  connection: Connection,
  dwalletIdB58: string,
): Promise<ZeroTrustDWallet> {
  const { publicOutput, curveSdk } = await fetchSolanaDWalletAccount(connection, dwalletIdB58);
  const synthetic = {
    kind: 'zero-trust' as const,
    curve: curveSdk,
    state: {
      $kind: 'Active' as const,
      Active: {
        public_output: Array.from(publicOutput),
      },
    },
  };
  return synthetic as unknown as ZeroTrustDWallet;
}
