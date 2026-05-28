/**
 * UI-side helper for the offscreen media cache. Bypasses tRPC for the byte-heavy
 * path so the bytes don't ride through superjson (the tRPC transformer).
 *
 * IMPORTANT: `chrome.runtime.sendMessage` serializes messages as JSON on all current
 * Chrome (structured clone is opt-in only on Chrome 148+ via the manifest
 * `message_serialization` key, which isn't released yet). JSON drops ArrayBuffers -
 * they arrive as `{}` - so the offscreen doc sends the image bytes as base64 and we
 * decode them back into an ArrayBuffer here. Callers still get `{ bytes: ArrayBuffer }`.
 *
 * Flow: ensure offscreen doc exists (asks the SW), then send the cache GET directly.
 * The offscreen listener at `src/offscreen/media-cache.ts` answers.
 */

import type { CacheGetResult, CacheGetWireResult } from '@/offscreen/media-cache';

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

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
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
  })) as CacheGetWireResult | undefined;
  if (!res) return { ok: false, reason: 'fetch-failed' };
  if (!res.ok) return res;
  return { ok: true, contentType: res.contentType, bytes: base64ToArrayBuffer(res.bytesB64) };
}
