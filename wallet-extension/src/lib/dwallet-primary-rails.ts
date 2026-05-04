/**
 * sync primary rails for dWallet home cards (no RPC). keeps UI rows stable while gas loads.
 */
import type { OwnedDWalletCapView } from '@/background/ika/dwallet-discovery';
import {
  BUILTIN_APTOS,
  BUILTIN_EVM,
  BUILTIN_SUI,
  resolveBuiltinSolanaPreset,
} from '@/config/networks';
import { chainTagFromRowKey } from '@/lib/dwallet-gas-row-labels';

export type DwalletPrimaryRailIcon = 'btc' | 'eth' | 'evm' | 'sui' | 'sol' | 'apt';

export type DwalletPrimaryRail = {
  rowKey: string;
  icon: DwalletPrimaryRailIcon;
  /** full network name for tooltip */
  chainLabel: string;
  /** short label shown in the grid, e.g. ARB, BTC(seg) */
  chainTag: string;
  address: string;
};

export type PrimaryRailNetworkHint = {
  suiNetworkId?: string;
  solNetworkId?: string;
  aptNetworkId?: string;
  /** active registry evm chain, adds a skeleton gas row for this L2 in addition to Ethereum mainnet */
  activeEvmChainId?: number;
  activeEvmChainName?: string;
};

function suiLabelForHint(id?: string): string {
  return BUILTIN_SUI.find((n) => n.id === id)?.name ?? BUILTIN_SUI[0]!.name;
}

function solLabelForHint(id?: string): string {
  return resolveBuiltinSolanaPreset(id).name;
}

function aptLabelForHint(id?: string): string {
  return BUILTIN_APTOS.find((n) => n.id === id)?.name ?? BUILTIN_APTOS[0]!.name;
}

export function primaryRailSkeletonsForCap(
  cap: OwnedDWalletCapView,
  hint?: PrimaryRailNetworkHint | null,
): DwalletPrimaryRail[] {
  const ca = cap.chainAddresses;
  const rows: DwalletPrimaryRail[] = [];
  if (cap.curve === 'SECP256K1') {
    if (ca?.btcP2wpkh) {
      rows.push({
        rowKey: 'btc-p2wpkh',
        icon: 'btc',
        chainLabel: 'Bitcoin (segwit)',
        chainTag: chainTagFromRowKey('btc-p2wpkh'),
        address: ca.btcP2wpkh,
      });
    }
    if (ca?.btcP2tr) {
      rows.push({
        rowKey: 'btc-p2tr',
        icon: 'btc',
        chainLabel: 'Bitcoin (taproot)',
        chainTag: chainTagFromRowKey('btc-p2tr'),
        address: ca.btcP2tr,
      });
    }
    const evm = ca?.evm?.trim();
    if (evm) {
      const eth = BUILTIN_EVM.find((n) => n.chainId === 1);
      rows.push({
        rowKey: 'evm-1',
        icon: 'eth',
        chainLabel: eth?.name ?? 'Ethereum',
        chainTag: chainTagFromRowKey('evm-1'),
        address: evm,
      });
      const ac = hint?.activeEvmChainId;
      if (ac != null && ac !== 1) {
        const rk = `evm-${ac}`;
        rows.push({
          rowKey: rk,
          icon: 'evm',
          chainLabel: hint?.activeEvmChainName ?? `EVM ${ac}`,
          chainTag: chainTagFromRowKey(rk),
          address: evm,
        });
      }
    }
  } else if (cap.curve === 'ED25519') {
    if (ca?.sui) {
      rows.push({
        rowKey: 'sui',
        icon: 'sui',
        chainLabel: suiLabelForHint(hint?.suiNetworkId),
        chainTag: chainTagFromRowKey('sui'),
        address: ca.sui,
      });
    }
    if (ca?.solana) {
      rows.push({
        rowKey: 'sol',
        icon: 'sol',
        chainLabel: solLabelForHint(hint?.solNetworkId),
        chainTag: chainTagFromRowKey('sol'),
        address: ca.solana,
      });
    }
    if (ca?.aptos) {
      rows.push({
        rowKey: 'apt',
        icon: 'apt',
        chainLabel: aptLabelForHint(hint?.aptNetworkId),
        chainTag: chainTagFromRowKey('apt'),
        address: ca.aptos,
      });
    }
  }
  return rows;
}
