/**
 * Offscreen media cache - centralized fetch + IndexedDB cache for third-party
 * NFT/Ordinals imagery. Lives in the chrome.offscreen document so the cache
 * survives service worker suspension and dedupes across popup + side panel.
 *
 * See `wallet-extension/docs/OFFSCREEN_MEDIA_CACHE.md` for the architecture
 * and policy choices (caps, TTL, negative-cache, etc.).
 */

const DB_NAME = 'chromatika_media_cache_v1';
const STORE = 'entries';
const TOTAL_CAP_BYTES = 100 * 1024 * 1024; // 100 MB hard cap
const EVICT_TARGET_BYTES = 90 * 1024 * 1024; // evict down to 90 MB to avoid thrash
const PER_ENTRY_MAX_BYTES = 25 * 1024 * 1024; // 25 MB per image
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const FETCH_TIMEOUT_MS = 15_000;
const NEGATIVE_TTL_MS = 5 * 60 * 1000; // 5 min in-memory negative cache

type CacheEntry = {
  url: string;
  contentType: string;
  bytes: ArrayBuffer;
  byteLength: number;
  fetchedAtMs: number;
  lastUsedAtMs: number;
};

export type FailureReason = 'fetch-failed' | 'too-large' | 'wrong-type' | 'timeout';

export type CacheGetResult =
  | { ok: true; contentType: string; bytes: ArrayBuffer }
  | { ok: false; reason: FailureReason };

const inflight = new Map<string, Promise<CacheGetResult>>();
const negativeCache = new Map<string, { failedAtMs: number; reason: FailureReason }>();

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'url' });
        store.createIndex('lastUsedAtMs', 'lastUsedAtMs');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexeddb open failed'));
  });
  return dbPromise;
}

function idbGet(db: IDBDatabase, url: string): Promise<CacheEntry | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(url);
    req.onsuccess = () => resolve(req.result as CacheEntry | undefined);
    req.onerror = () => reject(req.error ?? new Error('indexeddb get failed'));
  });
}

function idbPut(db: IDBDatabase, entry: CacheEntry): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(entry);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('indexeddb put failed'));
  });
}

function idbTouch(db: IDBDatabase, url: string, lastUsedAtMs: number): Promise<void> {
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const getReq = store.get(url);
    getReq.onsuccess = () => {
      const entry = getReq.result as CacheEntry | undefined;
      if (!entry) {
        resolve();
        return;
      }
      entry.lastUsedAtMs = lastUsedAtMs;
      store.put(entry);
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve(); // touch failure is not fatal
  });
}

/** Walks the LRU index and deletes oldest entries until total size <= EVICT_TARGET_BYTES. */
async function maybeEvict(db: IDBDatabase): Promise<void> {
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const index = store.index('lastUsedAtMs');
    let total = 0;
    const all: { key: IDBValidKey; byteLength: number; lastUsedAtMs: number }[] = [];
    index.openCursor().onsuccess = (e) => {
      const cursor = (e.target as IDBRequest<IDBCursorWithValue | null>).result;
      if (cursor) {
        const v = cursor.value as CacheEntry;
        total += v.byteLength;
        all.push({ key: cursor.primaryKey, byteLength: v.byteLength, lastUsedAtMs: v.lastUsedAtMs });
        cursor.continue();
        return;
      }
      if (total <= TOTAL_CAP_BYTES) {
        resolve();
        return;
      }
      // sort ascending by lastUsedAtMs (oldest first), delete until under target
      all.sort((a, b) => a.lastUsedAtMs - b.lastUsedAtMs);
      let running = total;
      for (const candidate of all) {
        if (running <= EVICT_TARGET_BYTES) break;
        store.delete(candidate.key);
        running -= candidate.byteLength;
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

async function fetchBytes(url: string): Promise<CacheGetResult> {
  let response: Response;
  try {
    response = await fetch(url, {
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    const isTimeout = e instanceof DOMException && e.name === 'TimeoutError';
    return { ok: false, reason: isTimeout ? 'timeout' : 'fetch-failed' };
  }
  if (!response.ok) return { ok: false, reason: 'fetch-failed' };

  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  if (!contentType.startsWith('image/')) return { ok: false, reason: 'wrong-type' };

  const declaredLength = Number(response.headers.get('content-length') ?? 0);
  if (declaredLength > PER_ENTRY_MAX_BYTES) return { ok: false, reason: 'too-large' };

  let bytes: ArrayBuffer;
  try {
    bytes = await response.arrayBuffer();
  } catch {
    return { ok: false, reason: 'fetch-failed' };
  }
  if (bytes.byteLength > PER_ENTRY_MAX_BYTES) return { ok: false, reason: 'too-large' };

  return { ok: true, contentType: contentType.split(';')[0]!.trim(), bytes };
}

async function getMediaBytes(sourceUrl: string): Promise<CacheGetResult> {
  // negative cache: skip retry within TTL of last failure
  const neg = negativeCache.get(sourceUrl);
  if (neg && Date.now() - neg.failedAtMs < NEGATIVE_TTL_MS) {
    return { ok: false, reason: neg.reason };
  } else if (neg) {
    negativeCache.delete(sourceUrl);
  }

  // in-flight dedupe
  const existing = inflight.get(sourceUrl);
  if (existing) return existing;

  const work = (async (): Promise<CacheGetResult> => {
    const db = await openDb();
    const cached = await idbGet(db, sourceUrl);
    if (cached && Date.now() - cached.fetchedAtMs < TTL_MS) {
      void idbTouch(db, sourceUrl, Date.now());
      return { ok: true, contentType: cached.contentType, bytes: cached.bytes };
    }

    const fresh = await fetchBytes(sourceUrl);
    if (!fresh.ok) {
      negativeCache.set(sourceUrl, { failedAtMs: Date.now(), reason: fresh.reason });
      return fresh;
    }

    const now = Date.now();
    const entry: CacheEntry = {
      url: sourceUrl,
      contentType: fresh.contentType,
      bytes: fresh.bytes,
      byteLength: fresh.bytes.byteLength,
      fetchedAtMs: now,
      lastUsedAtMs: now,
    };
    try {
      await idbPut(db, entry);
      void maybeEvict(db);
    } catch {
      // storage failure is not fatal - return the bytes anyway, cache misses next time
    }
    return { ok: true, contentType: fresh.contentType, bytes: fresh.bytes };
  })();

  inflight.set(sourceUrl, work);
  try {
    return await work;
  } finally {
    inflight.delete(sourceUrl);
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'media-cache:get') return undefined;
  const sourceUrl = typeof message.sourceUrl === 'string' ? message.sourceUrl : '';
  if (!sourceUrl) {
    sendResponse({ ok: false, reason: 'fetch-failed' satisfies FailureReason });
    return undefined;
  }
  void getMediaBytes(sourceUrl).then((r) => sendResponse(r));
  return true; // keep the channel open for async sendResponse
});
