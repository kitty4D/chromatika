/**
 * DeSo network constants. confirmed via the upstream `lib/constants.go` in deso-protocol/core.
 *
 * **mainnet only for v0.** no public testnet node URL is published, the protocol still ships a
 * testnet base58 prefix for self-hosted nodes, but chromatika's MVP runs against the public
 * mainnet node. treat with mainnet-grade caution: small dust amounts during dev.
 *
 * reference: `wallet-extension/docs/DESO_SPIKE.md`.
 */

export type DeSoNetwork = 'mainnet' | 'testnet';

export const DESO_DEFAULT_NODE_MAINNET = 'https://node.deso.org';

import { STORAGE_KEYS } from '@/background/storage';

/** storage key for user-overridable node URL. empty / unset = default. */
export const DESO_NODE_STORAGE_KEY = STORAGE_KEYS.DESO_NODE_V1;

/** base58check prefix bytes per network. mainnet addresses start with `BC1`. */
export const DESO_ADDRESS_PREFIX: Record<DeSoNetwork, Uint8Array> = {
  mainnet: new Uint8Array([0xcd, 0x14, 0x00]),
  testnet: new Uint8Array([0x11, 0xc2, 0x00]),
};

/** 1 DESO = 10^9 nanos. */
export const DESO_NANOS_PER_DESO = 1_000_000_000n;

/** standard min-fee floor, fallback when the node doesn't expose a current rate. */
export const DESO_DEFAULT_MIN_FEE_RATE_NANOS_PER_KB = 1000;

/** API endpoints relative to the node base URL. */
export const DESO_ENDPOINTS = {
  sendDeso: '/api/v0/send-deso',
  submitPost: '/api/v0/submit-post',
  submitTransaction: '/api/v0/submit-transaction',
  getUsersStateless: '/api/v0/get-users-stateless',
  getSingleProfile: '/api/v0/get-single-profile',
} as const;

/**
 * network-registry entry shape for chromatika's networks list. mirrors the convention used by
 * other custom chain support (BTC esplora URL, EVM RPC URL, etc).
 */
export interface DeSoNetworkConfig {
  network: DeSoNetwork;
  nodeUrl: string;
}

export function makeDefaultDeSoNetwork(): DeSoNetworkConfig {
  return { network: 'mainnet', nodeUrl: DESO_DEFAULT_NODE_MAINNET };
}
