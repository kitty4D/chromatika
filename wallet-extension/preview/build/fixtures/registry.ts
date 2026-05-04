/**
 * Procedure path → fixture lookup for the preview trpc-mock.
 *
 * Add an entry here when a screen needs a specific shape. Procedures without an
 * entry log a console warning and resolve to `null`, which most chromatika components
 * tolerate (their loading / empty-state branch fires).
 *
 * Layout-only changes in the wallet do NOT need a fixture update. Only data-shape
 * changes do (e.g. a new field on the Activity row, a new tRPC procedure).
 */

import { DAVID } from './personas';
import { DEFAULT_EXPLORER_PREFERENCES } from '@/config/explorers';
import { BALANCES_DEFAULT } from './balances';
import { NETWORKS } from './networks';
import { ACTIVITY_DAVID } from './activity';
import {
  DWALLET_CAPS_DAVID,
  DWALLET_ADDRESS_BOOK,
  DWALLET_DISPLAY_NAMES,
  DWALLET_CARD_ORDER,
  EVM_TOKEN_BALANCES,
  PORTFOLIO_RAIL_BALANCES_SUI,
  PORTFOLIO_RAIL_BALANCES_SOLANA,
  PORTFOLIO_RAIL_BALANCES_BTC,
  PORTFOLIO_RAIL_BALANCES_APTOS,
  VAULT_SUMMARIES,
} from './dwallets';

type FixtureValue = unknown;
type FixtureFactory = (input: unknown) => FixtureValue;
type FixtureEntry = FixtureValue | FixtureFactory;

const REGISTRY: Record<string, FixtureEntry> = {
  // Hooks every wallet-shell screen touches on mount. Without these, screens flash
  // a loading state before settling into the demo content.
  'getIkaBaseMode': 'sui',
  'getExplorerPreferences': DEFAULT_EXPLORER_PREFERENCES,
  'balances': BALANCES_DEFAULT,
  'getNetworks': NETWORKS,
  'walletExists': true,
  'lockState': { locked: false, vaultExists: true, autoLockMinutes: 30 },
  'activeVaultId': DAVID.id,
  'getActivity': ACTIVITY_DAVID,
  'listVaults': VAULT_SUMMARIES,
  'listOwnedDWalletCaps': DWALLET_CAPS_DAVID,
  'dwalletAddressBook': DWALLET_ADDRESS_BOOK,
  'getDwalletDisplayNames': DWALLET_DISPLAY_NAMES,
  'getDwalletCardOrder': DWALLET_CARD_ORDER,
  'getEvmTokenBalances': EVM_TOKEN_BALANCES,
  'portfolioRailBalances': (input: unknown) => {
    const rail = (input as { rail?: string } | undefined)?.rail;
    if (rail === 'sui') return PORTFOLIO_RAIL_BALANCES_SUI;
    if (rail === 'solana') return PORTFOLIO_RAIL_BALANCES_SOLANA;
    if (rail === 'btcP2wpkh' || rail === 'btcP2tr') return PORTFOLIO_RAIL_BALANCES_BTC;
    if (rail === 'aptos') return PORTFOLIO_RAIL_BALANCES_APTOS;
    return [];
  },
  // returns null - no chroma-lab refs / pending dwallets / nft rows for the demo
  'getChromaLabRefs': { secp256k1: null, ed25519: null },
  'getDwalletHomeGasMany': { byDwalletId: {} },
  'getPendingDwalletStates': [],
  'getDappPermissions': [],
  'getVaultNameHints': new Map(),
  'getNftsCollectibles': { items: [], cursor: null },
  'getNftKiosks': { items: [], cursor: null },
};

let WARNED = new Set<string>();

export function resolveFixture(procedure: string, input: unknown): unknown {
  const entry = REGISTRY[procedure];
  if (entry === undefined) {
    if (!WARNED.has(procedure)) {
      WARNED.add(procedure);
      // surface in console so we know which procedures the rendered screens hit -
      // tells us what fixtures to fill in next
      console.info(`[chromatika preview] no fixture for trpc.${procedure} - resolving null`);
    }
    return null;
  }
  if (typeof entry === 'function') return (entry as FixtureFactory)(input);
  return entry;
}

export function registerFixture(procedure: string, value: FixtureEntry): void {
  REGISTRY[procedure] = value;
}

// Re-export for convenience so registry callers don't have to import personas separately.
export { DAVID };
