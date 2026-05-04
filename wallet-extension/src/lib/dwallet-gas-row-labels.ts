import { BUILTIN_EVM } from '@/config/networks';

/** short ticker-style labels for dWallet home gas rows (full name stays in chainLabel for tooltips). */
const EVM_CHAIN_TAG_BY_ID: Record<number, string> = {
  1: 'ETH',
  8453: 'BASE',
  42161: 'ARB',
  42170: 'ARB',
  10: 'OP',
  137: 'POL',
  56: 'BNB',
  43114: 'AVAX',
  143: 'MON',
};

export function evmChainTag(chainId: number, nativeSymbol: string): string {
  return EVM_CHAIN_TAG_BY_ID[chainId] ?? nativeSymbol.slice(0, 5).toUpperCase();
}

/** stable short tag from rowKey for skeleton rows (matches gas row keys). */
export function chainTagFromRowKey(rowKey: string): string {
  if (rowKey === 'btc-p2wpkh') return 'BTC(seg)';
  if (rowKey === 'btc-p2tr') return 'BTC(tr)';
  if (rowKey === 'evm-1') return 'ETH';
  const m = /^evm-(\d+)$/.exec(rowKey);
  if (m) {
    const id = Number(m[1]);
    const preset = BUILTIN_EVM.find((n) => n.chainId === id);
    return evmChainTag(id, preset?.symbol ?? 'ETH');
  }
  if (rowKey === 'sui') return 'SUI';
  if (rowKey === 'sol') return 'SOL';
  if (rowKey === 'apt') return 'APT';
  return rowKey;
}
