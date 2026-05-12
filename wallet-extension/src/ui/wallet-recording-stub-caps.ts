/**
 * seeded `listOwnedDWalletCaps` rows for `dev=1&walletRecordingStub=1` so marketing / playwright
 * runs show a plausible dWallet bar + home deck without a live ika session or session unlock.
 */

import type { trpc } from '@/lib/trpc';

export type ListedDwalletCap = Awaited<ReturnType<typeof trpc.listOwnedDWalletCaps.query>>[number];

export const RECORDING_STUB_DWALLET_CAPS: ListedDwalletCap[] = [
  {
    capObjectId: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    dwalletId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    curve: 'SECP256K1',
    status: 'Active',
    needsZeroTrustCompletion: false,
    chainAddresses: {
      evm: '0x71C7656EC7ab88b098defB751B7401B5f6d8976F',
      btcP2wpkh: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
      btcP2tr: 'bc1psh7rv7wznpprppamrhe0ttlfcq423un9rftcl6wne7s4xthm6lgsn8w8zs',
    },
  },
];
