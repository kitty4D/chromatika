/**
 * build explorer URLs from user prefs (`ExplorerPreferences`) + active `Networks` registry rows.
 * keep in sync with `config/explorers.ts` presets.
 */

import {
  buildSolanaExplorerUrl,
  buildSuiExplorerUrl,
  type ExplorerPreferences,
} from '@/config/explorers';
import type { Networks } from '@/ui/types';
import type { DwalletHomeGasIcon } from '@/background/chains/dwallet-home-gas';

export function stripEsploraApiSuffix(esploraUrl: string): string {
  return esploraUrl.replace(/\/api\/?$/, '');
}

export function evmAddressExplorerUrl(explorerBase: string | undefined, address: string): string | null {
  const b = explorerBase?.trim();
  if (!b || !address.trim()) return null;
  const base = b.replace(/\/$/, '');
  return `${base}/address/${encodeURIComponent(address)}`;
}

export function aptosAccountExplorerUrl(networks: Networks | null, address: string): string | null {
  if (!networks || !address.trim()) return null;
  const id = networks.active.aptNetworkId;
  const network =
    id.includes('devnet') ? 'devnet' : id.includes('testnet') ? 'testnet' : 'mainnet';
  return `https://explorer.aptoslabs.com/account/${encodeURIComponent(address)}?network=${network}`;
}

export function btcAddressExplorerUrl(networks: Networks | null, address: string): string | null {
  if (!networks || !address.trim()) return null;
  const net = networks.bitcoin.find((n) => n.id === networks.active.btcNetworkId);
  const base = stripEsploraApiSuffix(net?.esploraUrl ?? 'https://blockstream.info/api');
  return `${base}/address/${encodeURIComponent(address)}`;
}

/** EVM transaction hash (0x-prefixed). */
export function evmTxExplorerUrl(explorerBase: string | undefined, txHash: string): string | null {
  const b = explorerBase?.trim();
  if (!b || !txHash.trim()) return null;
  const base = b.replace(/\/$/, '');
  return `${base}/tx/${encodeURIComponent(txHash)}`;
}

/** Bitcoin transaction id (esplora `.../tx/{txid}`). */
export function btcTxExplorerUrl(networks: Networks | null, txid: string): string | null {
  if (!networks || !txid.trim()) return null;
  const net = networks.bitcoin.find((n) => n.id === networks.active.btcNetworkId);
  const base = stripEsploraApiSuffix(net?.esploraUrl ?? 'https://blockstream.info/api');
  return `${base}/tx/${encodeURIComponent(txid)}`;
}

/** activity row digest / tx id / signature (per chain). */
export function activityTxExplorerHref(
  prefs: ExplorerPreferences,
  networks: Networks | null,
  chain: 'sui' | 'evm' | 'solana' | 'bitcoin',
  digest: string,
): string | null {
  if (!networks || !digest.trim()) return null;
  switch (chain) {
    case 'sui':
      return buildSuiExplorerUrl(prefs, networks.active.suiNetworkId, 'tx', digest);
    case 'evm': {
      const net = networks.evm.find((n) => n.chainId === networks.active.evmChainId);
      return evmTxExplorerUrl(net?.explorerUrl, digest);
    }
    case 'solana':
      return buildSolanaExplorerUrl(prefs, networks.active.solNetworkId, 'tx', digest);
    case 'bitcoin':
      return btcTxExplorerUrl(networks, digest);
    default:
      return null;
  }
}

/** fee payer on Sui (address) or Solana (address). */
export function feePayerExplorerHref(
  prefs: ExplorerPreferences,
  networks: Networks | null,
  feeAddress: string,
  ikaBase: 'sui' | 'solana' | undefined,
  balancesNetworkSlug: string,
): string | null {
  if (!feeAddress.trim()) return null;
  if (ikaBase === 'solana') {
    const id = networks?.active.solNetworkId ?? 'sol-devnet';
    return buildSolanaExplorerUrl(prefs, id, 'address', feeAddress);
  }
  const suiId = networks?.active.suiNetworkId ?? balancesNetworkIdFromSlug(balancesNetworkSlug);
  return buildSuiExplorerUrl(prefs, suiId, 'address', feeAddress);
}

function balancesNetworkIdFromSlug(slug: string): string {
  if (slug === 'testnet') return 'sui-testnet';
  return 'sui-mainnet';
}

/** dWallet object id (Sui `0x...`) or Solana base58 account. */
export function dwalletObjectExplorerHref(
  prefs: ExplorerPreferences,
  networks: Networks | null,
  dwalletId: string,
): string | null {
  if (!dwalletId.trim() || dwalletId === 'unknown') return null;
  if (dwalletId.startsWith('0x')) {
    const suiId = networks?.active.suiNetworkId ?? 'sui-mainnet';
    return buildSuiExplorerUrl(prefs, suiId, 'object', dwalletId);
  }
  const solId = networks?.active.solNetworkId ?? 'sol-devnet';
  return buildSolanaExplorerUrl(prefs, solId, 'address', dwalletId);
}

/** dWalletCap object on Sui, or `solana:...` program ref on Solana. */
export function capObjectExplorerHref(
  prefs: ExplorerPreferences,
  networks: Networks | null,
  capObjectId: string,
): string | null {
  if (!capObjectId.trim()) return null;
  if (capObjectId.startsWith('solana:')) {
    const key = capObjectId.slice('solana:'.length);
    const solId = networks?.active.solNetworkId ?? 'sol-devnet';
    return buildSolanaExplorerUrl(prefs, solId, 'address', key);
  }
  const suiId = networks?.active.suiNetworkId ?? 'sui-mainnet';
  return buildSuiExplorerUrl(prefs, suiId, 'object', capObjectId);
}

export function gasRowAddressExplorerHref(
  prefs: ExplorerPreferences,
  networks: Networks | null,
  icon: DwalletHomeGasIcon,
  address: string | null,
  evmChainIdFromRowKey?: number,
): string | null {
  if (!address?.trim() || !networks) return null;
  const addr = address.trim();
  switch (icon) {
    case 'eth':
    case 'evm': {
      const chainId = evmChainIdFromRowKey ?? networks.active.evmChainId;
      const evmNet = networks.evm.find((n) => n.chainId === chainId);
      return evmAddressExplorerUrl(evmNet?.explorerUrl, addr);
    }
    case 'sui':
      return buildSuiExplorerUrl(prefs, networks.active.suiNetworkId, 'address', addr);
    case 'sol':
      return buildSolanaExplorerUrl(prefs, networks.active.solNetworkId, 'address', addr);
    case 'apt':
      return aptosAccountExplorerUrl(networks, addr);
    case 'btc':
      return btcAddressExplorerUrl(networks, addr);
    default:
      return null;
  }
}

/** parse `evm-{chainId}` from `DwalletHomeGasRow.rowKey` when present. */
export function evmChainIdFromGasRowKey(rowKey: string): number | undefined {
  const m = /^evm-(\d+)$/.exec(rowKey);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : undefined;
}

/** first populated rail on a cap (same order as bar: evm -> sui -> solana). */
export function capPrimaryAddressExplorerHref(
  prefs: ExplorerPreferences,
  networks: Networks | null,
  chainAddresses: { evm?: string; sui?: string; solana?: string; aptos?: string } | undefined,
): string | null {
  if (!networks || !chainAddresses) return null;
  const evm = chainAddresses.evm?.trim();
  if (evm) {
    const net = networks.evm.find((n) => n.chainId === networks.active.evmChainId);
    return evmAddressExplorerUrl(net?.explorerUrl, evm);
  }
  const sui = chainAddresses.sui?.trim();
  if (sui) return buildSuiExplorerUrl(prefs, networks.active.suiNetworkId, 'address', sui);
  const sol = chainAddresses.solana?.trim();
  if (sol) return buildSolanaExplorerUrl(prefs, networks.active.solNetworkId, 'address', sol);
  const apt = chainAddresses.aptos?.trim();
  if (apt) return aptosAccountExplorerUrl(networks, apt);
  return null;
}
