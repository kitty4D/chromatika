/**
 * UI-side helper for the offscreen media cache. Bypasses tRPC for the byte-heavy
 * path: chrome.runtime.sendMessage uses structured clone which preserves
 * ArrayBuffer cheaply, while superjson (the tRPC transformer) does not.
 *
 * Flow: ensure offscreen doc exists (asks the SW), then send the cache GET
 * directly. The offscreen listener at `src/offscreen/media-cache.ts` answers.
 */

import type { CacheGetResult } from '@/offscreen/media-cache';

let readyPromise: Promise<void> | null = null;

async function ensureOffscreenReady(): Promise<void> {
  if (readyPromise) return readyPromise;
  readyPromise = (async () => {
    const res = (await chrome.runtime.sendMessage({
      type: 'media-cache:ensure-ready',
    })) as { ok: boolean; error?: string } | undefined;
    if (!res?.ok) throw new Error(res?.error ?? 'media-cache offscreen failed to start');
  })();
  try {
    await readyPromise;
  } catch (e) {
    readyPromise = null; // allow retry on next call
    throw e;
  }
}

export async function fetchCachedMediaBytes(sourceUrl: string): Promise<CacheGetResult> {
  await ensureOffscreenReady();
  // ping the SW so its idle-close timer resets even though the request itself
  // bypasses the SW. fire-and-forget.
  try {
    void chrome.runtime.sendMessage({ type: 'media-cache:activity-ping' });
  } catch {
    /* noop */
  }
  const res = (await chrome.runtime.sendMessage({
    type: 'media-cache:get',
    sourceUrl,
  })) as CacheGetResult | undefined;
  if (!res) return { ok: false, reason: 'fetch-failed' };
  return res;
}
