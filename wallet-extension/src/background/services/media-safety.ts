/**
 * MediaSafetyMode: controls which image URLs are surfaced in the UI.
 *
 * 'all'          - all image URLs, no filtering (trust everyone, literally lol)
 * 'ipfs_arweave' - (default) only IPFS and Arweave URLs pass through
 * 'none'         - no images at all, total blackout mode
 */

import { STORAGE_KEYS } from '@/background/storage';

export type MediaSafetyMode = 'all' | 'ipfs_arweave' | 'none';

const KEY = STORAGE_KEYS.MEDIA_SAFETY_V1;

export async function getMediaSafetyMode(): Promise<MediaSafetyMode> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get([KEY], (r) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve((r[KEY] as MediaSafetyMode) ?? 'ipfs_arweave');
    });
  });
}

export async function setMediaSafetyMode(mode: MediaSafetyMode): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [KEY]: mode }, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

/**
 * returns the url if allowed by the current mode, null otherwise.
 * call this before rendering any NFT/kiosk image.
 */
export function filterImageUrl(url: string | null | undefined, mode: MediaSafetyMode): string | null {
  if (mode === 'none' || !url) return null;
  if (mode === 'all') return url;

  // ipfs_arweave: only IPFS or Arweave content passes
  const lower = url.toLowerCase();
  const isIpfs =
    lower.startsWith('ipfs://') ||
    lower.includes('/ipfs/') ||
    lower.includes('.ipfs.') ||
    lower.includes('ipfs.io') ||
    lower.includes('cloudflare-ipfs.com') ||
    lower.includes('.ipfs.dweb.link') ||
    lower.includes('nftstorage.link');
  const isArweave = lower.startsWith('ar://') || lower.includes('arweave.net');
  return isIpfs || isArweave ? url : null;
}
