/**
 * SW-side bridge for the offscreen media cache.
 *
 * The offscreen document at `offscreen.html` owns the IndexedDB cache + fetcher
 * (see `src/offscreen/media-cache.ts`). The SW only manages lifecycle:
 *   - lazily create the offscreen doc on first request
 *   - close it after IDLE_CLOSE_MS of inactivity to reclaim memory
 *
 * Wired to a chrome.alarms tick from `src/background/index.ts` and to the
 * `media-cache:ensure-ready` runtime message handler.
 */

const OFFSCREEN_PATH = 'offscreen.html';
const OFFSCREEN_REASONS = ['BLOBS' as chrome.offscreen.Reason];
const OFFSCREEN_JUSTIFICATION =
  'Cache + decode third-party NFT/Ordinals media in a sandboxed context';

const IDLE_CLOSE_MS = 5 * 60 * 1000;

let lastActivityAtMs = 0;
let ensurePromise: Promise<void> | null = null;

async function hasOffscreenDoc(): Promise<boolean> {
  // chrome.runtime.getContexts is the supported MV3 way to check for an existing
  // offscreen document; falls back to false if the API isn't available.
  const getContexts = (chrome.runtime as unknown as {
    getContexts?: (filter: { contextTypes: string[] }) => Promise<{ contextType: string }[]>;
  }).getContexts;
  if (typeof getContexts !== 'function') return false;
  try {
    const contexts = await getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    return contexts.length > 0;
  } catch {
    return false;
  }
}

export async function ensureMediaCacheOffscreenDoc(): Promise<void> {
  lastActivityAtMs = Date.now();
  if (ensurePromise) return ensurePromise;
  ensurePromise = (async () => {
    if (await hasOffscreenDoc()) return;
    try {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_PATH,
        reasons: OFFSCREEN_REASONS,
        justification: OFFSCREEN_JUSTIFICATION,
      });
    } catch (e) {
      // a concurrent caller may have created it between our check and create call
      const message = e instanceof Error ? e.message : String(e);
      if (!/already an offscreen document/i.test(message)) throw e;
    }
  })();
  try {
    await ensurePromise;
  } finally {
    ensurePromise = null;
  }
}

export function notifyMediaCacheActivity(): void {
  lastActivityAtMs = Date.now();
}

export async function maybeCloseIdleOffscreenDoc(): Promise<void> {
  if (lastActivityAtMs === 0) return;
  if (Date.now() - lastActivityAtMs < IDLE_CLOSE_MS) return;
  if (!(await hasOffscreenDoc())) {
    lastActivityAtMs = 0;
    return;
  }
  try {
    await chrome.offscreen.closeDocument();
    lastActivityAtMs = 0;
  } catch {
    // benign if already closed
  }
}

export const MEDIA_CACHE_IDLE_ALARM = 'chromatika-media-cache-idle';
