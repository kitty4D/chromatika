# Offscreen media cache

> status: 2026-05-10 - shipped. Centralized fetch + IndexedDB cache for third-party NFT/Ordinals imagery, hosted in a `chrome.offscreen` document. Replaces direct `<img src={remoteUrl}>` rendering in the NFT grid.

## why offscreen rather than fetching in the SW

A service worker COULD `fetch()` the bytes directly. The reason we use an offscreen document:

- **Lifecycle predictability.** SW is event-driven and chrome can suspend it mid-fetch; the offscreen doc stays alive while it has an active `reason` (`BLOBS` here). IndexedDB writes started in the SW can be lost on suspension; in offscreen they complete reliably.
- **Cross-surface dedupe.** Popup, side panel, and any future extension page hit the same offscreen cache (one chrome-mandated singleton). Without it, each surface would maintain its own in-memory blob URLs and re-fetch.
- **Privacy hardening in one place.** All fetches go through one chokepoint: `credentials: 'omit'`, `referrerPolicy: 'no-referrer'`, response size + content-type validation. Hosts can't set cookies or read the user's IP via referer the way they could from `<img src>` requests.

The MV3 spec disclaimer caveat: chrome currently allows ONE offscreen document per extension. We reuse it for media-cache and design future surfaces to coexist or accept a different lifecycle.

## scope

In:
- NFT and Ordinals imagery from third-party hosts (Alchemy, Helius, Hiro, Aptos indexer, IPFS gateways, Arweave gateways)

Out:
- Vault avatars (already inline SVG / data URIs)
- Bundled extension assets (`chrome.runtime.getURL` is already free)
- Image scrubbing or EXIF stripping (browser handles)
- Pre-warming on NFT list fetch (lazy load on view is sufficient)

## architecture

```
UI (popup, side panel)
  |
  | tRPC: mediaCache.getBytes({ sourceUrl })
  v
service worker (mediaCacheBridge)
  | ensure offscreen doc exists -> chrome.runtime.sendMessage({ type: 'media-cache:get', sourceUrl })
  v
offscreen document (offscreen.html + media-cache.ts)
  | check IndexedDB
  | if miss: fetch + validate + store
  | return { bytes: ArrayBuffer, contentType: string } | null
  v
back through SW -> back to UI
  | UI: URL.createObjectURL(new Blob([bytes], { type: contentType }))
  | render <img src={blobUrl}>
  | revoke on unmount
```

**Why bytes, not blob URLs.** Blob URLs are origin-scoped to the document that minted them; an offscreen-minted URL is unusable in side-panel.html. The cache stores bytes; each UI surface mints its own blob URL when consuming. UI components revoke on unmount.

## components

| File | Role |
|---|---|
| `wallet-extension/public/offscreen.html` | Single `<script type="module" src="/src/offscreen/media-cache.ts"></script>`. No DOM. |
| `wallet-extension/src/offscreen/media-cache.ts` | IndexedDB store, fetcher, in-flight dedupe Map, in-memory negative cache, message listener. |
| `wallet-extension/src/background/media-cache-bridge.ts` | SW-side: ensure offscreen doc exists, forward request via `chrome.runtime.sendMessage`, idle-close after 5 min. |
| `wallet-extension/src/server/routers/media-cache.ts` | tRPC procedure `getBytes({ sourceUrl })` -> calls bridge. |
| `wallet-extension/src/ui/components/NftImage.tsx` | React wrapper: `useMediaBlobUrl(sourceUrl)` hook + `<img>` render with placeholder fallback. |
| `wallet-extension/src/manifest.json` | Add `"offscreen"` to `permissions`. |

## data shapes

```ts
type CacheEntry = {
  url: string;             // primary key
  contentType: string;     // 'image/png' etc.
  bytes: ArrayBuffer;
  byteLength: number;      // pre-computed for eviction math
  fetchedAtMs: number;
  lastUsedAtMs: number;    // updated on every cache hit; basis for LRU
};

type CacheGetResult =
  | { ok: true; contentType: string; bytes: ArrayBuffer }
  | { ok: false; reason: 'filtered' | 'fetch-failed' | 'too-large' | 'wrong-type' | 'timeout' };
```

## policy choices (approved 2026-05-10)

| Choice | Value | Rationale |
|---|---|---|
| Total cache size cap | 100 MB | Conservative for `unlimitedStorage` extension; LRU evicts when exceeded. |
| Per-entry max size | 25 MB | Fits high-res NFT JPEGs / PNGs. Reject larger. |
| TTL | 7 days | NFT images rarely change. Refresh on miss after expiry. |
| Negative cache | In-memory, 5 min | Avoid hammering broken URLs without persisting failures. Cleared on offscreen close. |
| Offscreen lifecycle | Lazy create, close after 5 min idle | First request pays ~50 ms startup; reclaims memory between bursts. Tracked via `chrome.alarms` "media-cache-idle-check" every 60 s. |
| Fetch timeout | 15 s | `AbortSignal.timeout(15_000)`. |
| Fetch options | `credentials: 'omit'`, `referrerPolicy: 'no-referrer'` | No cookies, no referer leak. |

## MediaSafetyMode integration

`filterImageUrl()` runs UI-side before any cache call. If it returns null (mode `none` or non-IPFS in `ipfs_arweave` mode), `<NftImage>` skips the bridge entirely and renders the placeholder. The cache is a layer beneath an already-filtered URL; no change to MediaSafetyMode itself.

## eviction

On every successful `set`, the offscreen doc:
1. Sums `byteLength` across all entries via the `lastUsedAtMs` index.
2. If total > 100 MB, opens a cursor sorted by `lastUsedAtMs` ascending and deletes until total <= 90 MB (10 MB headroom to avoid thrashing).

## concurrency

`Map<url, Promise<CacheGetResult>>` in offscreen. New requests for an in-flight URL await the existing promise. Map entry deleted on resolve/reject.

## failure modes and surfacing

- Filtered URL: `{ ok: false, reason: 'filtered' }` -> UI placeholder, no retry needed.
- Fetch error / timeout: `{ ok: false, reason: 'fetch-failed' | 'timeout' }` -> UI placeholder, negative-cache 5 min.
- Wrong content-type (non-image): `{ ok: false, reason: 'wrong-type' }` -> placeholder, negative-cache 5 min.
- Too large: `{ ok: false, reason: 'too-large' }` -> placeholder, negative-cache 5 min (the URL won't shrink).
- Cache hit but bytes corrupt (decode error in browser): handled by `<img>` `onError` -> placeholder. Cache entry untouched (next refresh after TTL).

## migration

- `NftsPage.tsx`: swap `<img src={nft.imageUrl}>` -> `<NftImage src={nft.imageUrl} alt={nft.name} />`.
- Other current `<img>` usages (vault avatars, kiosk-list thumbnails if any, settings UI) are NOT migrated in this slice. They use either inline SVG, data URIs, or extension-bundled assets, none of which benefit from the cache.

## what this does NOT do

- Does not replace MediaSafetyMode (`filterImageUrl` still runs first).
- Does not encrypt cache contents (NFT images are public; threat model is privacy from external hosts, not local-disk).
- Does not pre-warm; lazy-on-render is sufficient for the gallery use case.
- Does not share cache entries across vaults (one global cache; no per-vault scoping).

## test plan

- Unit: `media-cache.test.ts` - LRU eviction math, negative-cache TTL, in-flight dedupe, content-type/size validation. (Fake `fetch` + fake-indexeddb.)
- Manual: open NFT page in side panel + popup simultaneously, confirm exactly one network request per unique URL. Toggle MediaSafetyMode `ipfs_arweave` -> `all` -> confirm new (non-IPFS) URLs flow through cache.

## future

- Per-host LRU buckets (Alchemy NFTs vs Hiro inscriptions can have separate eviction pools).
- Cache warming when NFT list resolves (not just on render).
- ServiceWorker `Cache` API as a secondary tier for fast HTTP-cache reuse.
- Promote to a generic "remote-asset cache" usable by other surfaces (e.g. token logos from CoinGecko).
