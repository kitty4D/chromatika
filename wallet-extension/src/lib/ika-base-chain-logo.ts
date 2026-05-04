import type { BaseChain } from '@/background/ika/ika-adapter';

/** `public/logos/*.svg` basename for ika vault base chain (fee / dkg coordinator surface). */
export function ikaBaseChainLogoRel(baseChain: BaseChain): `logos/${string}` {
  return baseChain === 'solana' ? 'logos/sol.svg' : 'logos/sui.svg';
}

/** extension URL or `/logos/...` for dev HTML. */
export function ikaBaseChainLogoUrl(baseChain: BaseChain): string {
  const rel = ikaBaseChainLogoRel(baseChain);
  if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) {
    return chrome.runtime.getURL(rel);
  }
  return `/${rel}`;
}
