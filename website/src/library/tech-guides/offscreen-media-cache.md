# offscreen media cache

IndexedDB-backed cache for third-party NFT / Ordinals imagery, running in chromatika's offscreen document (`offscreen.html`). isolates untrusted image fetches from the service worker and the UI's origin, dedupes across popup + side panel, and survives SW suspension.

## why offscreen

- the MV3 service worker has no DOM and can't decode images
- fetching directly from the side panel / popup means each surface re-fetches independently
- offscreen docs run in their own origin context, so cookies and referrer from NFT hosts can't leak to the extension's main origin

## configuration

| constant | value | purpose |
|----------|-------|---------|
| DB name | `chromatika_media_cache_v1` | IndexedDB database |
| hard cap | 100 MB | total cache size ceiling |
| evict target | 90 MB | LRU eviction target (avoids thrash) |
| per-entry max | 25 MB | reject single images larger than this |
| TTL | 7 days | entries older than this are evicted |
| fetch timeout | 15 seconds | per-image fetch deadline |
| negative cache TTL | 5 minutes | in-memory; avoids re-fetching known failures |

## privacy

every fetch goes `credentials: 'omit'` + `referrerPolicy: 'no-referrer'` so NFT hosts can't set cookies or read referer. blob URLs minted per-instance in the UI are origin-scoped, so the offscreen doc can't share its own URLs with the side panel.

## data model

```ts
type CacheEntry = {
  url: string;
  contentType: string;
  bytes: Uint8Array;
  byteLength: number;
  fetchedAtMs: number;
  lastUsedAtMs: number;
};

type FailureReason = 'fetch-failed' | 'too-large' | 'wrong-type' | 'timeout';
type CacheGetResult = { ok: true; contentType: string; bytes: Uint8Array }
                    | { ok: false; reason: FailureReason };
```

## LRU eviction

`maybeEvict()` runs after each write. if total cache size exceeds the hard cap, entries are sorted by `lastUsedAtMs` (oldest first) and deleted until total drops below evict target. TTL-expired entries (>7 days since `fetchedAtMs`) are always evicted first.

## SW bridge

`src/background/media-cache-bridge.ts` lazy-creates the offscreen document and forwards cache requests from the service worker. closes the offscreen doc after 5 minutes idle via the `chromatika-media-cache-idle` alarm.

chrome allows ONE offscreen doc per extension. any future feature needing one (audio playback, clipboard read in SW context) must coexist with media-cache or accept different lifecycle.

## UI consumption

`<NftImage>` (`src/ui/components/NftImage.tsx`) requests image bytes from the cache bridge, receives raw bytes, and mints a per-instance blob URL. blob URLs are origin-scoped, so the offscreen doc's URLs can't be shared to the side panel directly (the bytes cross the bridge, not the URL).

## MediaSafetyMode interaction

the cache respects the user's `MediaSafetyMode` setting:
- `all` - fetch from any URL
- `ipfs/arweave` (default) - only fetch from IPFS gateways and Arweave
- `none` - no images fetched (cache is bypassed entirely)

## files

- `wallet-extension/offscreen.html` - offscreen document entry
- `src/offscreen/media-cache.ts` - IndexedDB cache implementation
- `src/background/media-cache-bridge.ts` - SW bridge + lazy lifecycle
- `src/ui/components/NftImage.tsx` - UI consumer
- `wallet-extension/docs/OFFSCREEN_MEDIA_CACHE.md` - detailed implementation doc

## related

- [nft-api-providers.md](/library/tech/nft-api-providers) - where the image URLs come from
- [chrome-storage-local-and-session.md](/library/tech/chrome-storage-local-and-session) - other storage patterns
- `media-safety-mode` user guide - the user-facing setting
