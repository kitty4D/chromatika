import type { DwalletHomeGasIcon } from '@/background/chains/dwallet-home-gas';

function evmLogoFile(chainId: number): string | null {
  switch (chainId) {
    case 1:
      return 'eth.svg';
    case 8453:
      return 'eth.svg';
    case 42161:
    case 42170:
      return 'arb.svg';
    case 10:
      return 'opt.svg';
    case 137:
      return 'poly.svg';
    case 56:
      return 'bnb.svg';
    case 43114:
      return 'avax.svg';
    case 5000:
      return 'mnt.svg';
    case 728126428:
      return 'trx.svg';
    default:
      return null;
  }
}

/** basename under `logos/`, or null when we should fall back to the letter glyph. */
export function dwalletChainLogoFile(rowKey: string, icon: DwalletHomeGasIcon): string | null {
  switch (icon) {
    case 'btc':
      return 'btc.svg';
    case 'eth':
      return 'eth.svg';
    case 'sui':
      return 'sui.svg';
    case 'sol':
      return 'sol.svg';
    case 'apt':
      return 'apt.svg';
    case 'evm': {
      const m = /^evm-(\d+)$/.exec(rowKey);
      if (!m) return null;
      return evmLogoFile(Number(m[1]));
    }
    default:
      return null;
  }
}

/** absolute extension URL or `/logos/...` for non-extension contexts. */
export function dwalletChainLogoUrl(rowKey: string, icon: DwalletHomeGasIcon): string | null {
  const file = dwalletChainLogoFile(rowKey, icon);
  if (!file) return null;
  const rel = `logos/${file}`;
  if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) {
    return chrome.runtime.getURL(rel);
  }
  return `/${rel}`;
}
