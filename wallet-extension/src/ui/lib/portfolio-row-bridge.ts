/**
 * translate a `PortfolioAssetTable` row (EVM / native / SPL / pcToken) into a `SendTokenRow`
 * shape the new Send flow's Confirm step can consume. portfolio quick-send icons hand the row
 * off to MainWalletShell which calls `setSendNav({ initialStage: 'select-recipient', preselectedToken: ... })`.
 *
 * the new SendPage re-fetches price + USD lazily on the Confirm step if missing here (e.g. SPL
 * tokens that don't carry USD in the portfolio rail).
 */

import type {
  EvmTokenRow,
  NativeAssetRow,
  PcTokenAssetRow,
  SolanaSplRow,
} from '@/ui/components/PortfolioAssetTable';
import type { DwalletCapChainAddresses } from '@/background/chains/dwallet-derived-addresses';
import type { SendTokenChain, SendTokenRow } from '@/background/services/send-token-types';

export type PortfolioTableRowShape =
  | { kind: 'evm'; row: EvmTokenRow; chainId: number; networkLabel: string }
  | { kind: 'native'; row: NativeAssetRow; railKey: 'sui' | 'solana' | 'aptos' | 'btcP2wpkh' | 'btcP2tr'; networkLabel: string }
  | { kind: 'spl'; row: SolanaSplRow; networkLabel: string }
  | { kind: 'pcToken'; row: PcTokenAssetRow; networkLabel: string };

const NATIVE_SUI_COIN_TYPE = '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';

function addressHash8(addr: string): string {
  let h = 0;
  for (let i = 0; i < addr.length; i++) {
    h = ((h << 5) - h + addr.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0').slice(0, 8);
}

export function tableRowToSendTokenRow(
  input: PortfolioTableRowShape,
  context: {
    ownerLabel: string;
    chainAddresses: DwalletCapChainAddresses;
    dwalletId: string;
  },
): SendTokenRow | null {
  const { ownerLabel, chainAddresses, dwalletId } = context;

  switch (input.kind) {
    case 'evm': {
      const ownerAddress = chainAddresses.evm;
      if (!ownerAddress) return null;
      const decimals = input.row.decimals ?? 18;
      const balanceRaw = parseDecimalToRaw(input.row.balanceFormatted, decimals);
      const balanceFloat = Number.parseFloat(input.row.balanceFormatted) || 0;
      const pricePerTokenUsd =
        input.row.usdValue != null && balanceFloat > 0 ? input.row.usdValue / balanceFloat : null;
      return {
        key: `evm:${addressHash8(ownerAddress)}:${(input.row.contractAddress ?? 'native').toLowerCase()}`,
        ownerAddress,
        ownerLabel,
        ownerDwalletId: dwalletId,
        chain: 'evm',
        networkLabel: input.networkLabel,
        chainId: input.chainId,
        symbol: input.row.symbol,
        name: input.row.name,
        decimals,
        contractAddress: input.row.contractAddress ?? undefined,
        balanceRaw,
        balanceFormatted: input.row.balanceFormatted,
        pricePerTokenUsd,
        totalUsdValue: input.row.usdValue ?? null,
      };
    }
    case 'native': {
      const owner = ownerForNativeRail(chainAddresses, input.railKey);
      if (!owner) return null;
      const chain = chainForNativeRail(input.railKey);
      const decimals = decimalsForNativeRail(input.railKey, input.row.symbol);
      const balanceRaw = parseDecimalToRaw(input.row.balanceFormatted, decimals);
      const balanceFloat = Number.parseFloat(input.row.balanceFormatted) || 0;
      const pricePerTokenUsd =
        input.row.usdValue != null && balanceFloat > 0 ? input.row.usdValue / balanceFloat : null;
      const coinType =
        input.railKey === 'sui' && input.row.symbol.toUpperCase() === 'SUI' ? NATIVE_SUI_COIN_TYPE : undefined;
      return {
        key: `${chain}:${addressHash8(owner)}:${input.row.symbol.toLowerCase()}`,
        ownerAddress: owner,
        ownerLabel,
        ownerDwalletId: dwalletId,
        chain,
        networkLabel: input.networkLabel,
        symbol: input.row.symbol,
        name: input.row.name,
        decimals,
        coinType,
        balanceRaw,
        balanceFormatted: input.row.balanceFormatted,
        pricePerTokenUsd,
        totalUsdValue: input.row.usdValue ?? null,
      };
    }
    case 'spl': {
      const owner = chainAddresses.solana;
      if (!owner) return null;
      return {
        key: `solana:${addressHash8(owner)}:${input.row.mint}`,
        ownerAddress: owner,
        ownerLabel,
        ownerDwalletId: dwalletId,
        chain: 'solana',
        networkLabel: input.networkLabel,
        symbol: input.row.symbol,
        name: `SPL ${input.row.mint.slice(0, 6)}...`,
        decimals: input.row.decimals,
        mint: input.row.mint,
        balanceRaw: input.row.balanceRaw,
        balanceFormatted: input.row.balanceFormatted,
        pricePerTokenUsd: null,
        totalUsdValue: null,
      };
    }
    case 'pcToken':
      // pcToken hidden transfers route through the dedicated HiddenTransferForm; bridging into
      // the unified Send flow would lose the hidden semantics. let pcToken rows keep their
      // existing onSendPcToken path - the new Send flow won't be reachable from those rows.
      return null;
  }
}

function ownerForNativeRail(
  a: DwalletCapChainAddresses,
  rail: 'sui' | 'solana' | 'aptos' | 'btcP2wpkh' | 'btcP2tr',
): string | undefined {
  switch (rail) {
    case 'sui':
      return a.sui;
    case 'solana':
      return a.solana;
    case 'aptos':
      return a.aptos;
    case 'btcP2wpkh':
      return a.btcP2wpkh;
    case 'btcP2tr':
      return a.btcP2tr;
  }
}

function chainForNativeRail(rail: 'sui' | 'solana' | 'aptos' | 'btcP2wpkh' | 'btcP2tr'): SendTokenChain {
  if (rail === 'sui') return 'sui';
  if (rail === 'solana') return 'solana';
  if (rail === 'aptos') return 'aptos';
  return 'btc';
}

function decimalsForNativeRail(
  rail: 'sui' | 'solana' | 'aptos' | 'btcP2wpkh' | 'btcP2tr',
  symbol: string,
): number {
  if (rail === 'sui') {
    if (symbol.toUpperCase() === 'IKA') return 9;
    return 9;
  }
  if (rail === 'solana') return 9;
  if (rail === 'aptos') return 8;
  // btc
  return 8;
}

function parseDecimalToRaw(formatted: string, decimals: number): string {
  const trimmed = formatted.replace(/,/g, '').trim();
  if (!trimmed) return '0';
  const [whole, frac = ''] = trimmed.split('.');
  const fracPadded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  try {
    const bi = BigInt(whole || '0') * BigInt(10) ** BigInt(decimals) + BigInt(fracPadded || '0');
    return bi.toString();
  } catch {
    return '0';
  }
}
