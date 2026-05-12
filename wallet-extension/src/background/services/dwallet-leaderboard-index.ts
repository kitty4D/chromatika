/**
 * ChromaLab dWallet leaderboard - on-chain discovery layer.
 *
 * the user insight that drives this module: suivision/suiscan already enumerate
 * `coordinator_inner::DWalletCap` objects across the network. they're the right
 * gate because if a cap is destroyed, no one can sign with the underlying dWallet
 * and its value is unreachable - so caps-not-destroyed == dWallets-that-matter.
 *
 * we lean on the new `queryObjectsByTypeGraphQL` helper to paginate every
 * DWalletCap object on Sui via the vault's `SuiGraphQLClient`, extract each
 * cap's `dwallet_id` field (same multi-field reader used in `dwallet-discovery.ts`),
 * and persist the deduped set in `chrome.storage.local` keyed by `DWALLET_INDEX_V1`.
 *
 * known limitations called out at top so callers don't have to dig:
 *   - caps wrapped inside a shared `chromatika_policy::sign_gate::PolicyVault` are NOT
 *     returned by the cap-type query (wrapped objects aren't top-level addressable).
 *     v2 will run a parallel `objects(filter: { type: PolicyVault })` query and pull
 *     the inner cap's `dwallet_id`.
 *   - Solana-resident dWallets (where the dWallet itself is a Solana PDA) aren't
 *     reachable from Sui at all. Solana pre-alpha has no enumeration API; this is
 *     deferred until post pre-alpha. Sui-resident dWallets that *sign* Solana txs
 *     are fully covered via the existing ED25519 derivation.
 */

import { getSession } from '@/background/session';
import { queryObjectsByTypeGraphQL } from '@/background/sui-client';
import { STORAGE_KEYS } from '@/background/storage/keys';

/**
 * persisted shape for the dwallet id index. only keep what we strictly need to
 * sort, evict, and resume - the per-dwallet portfolio cache holds everything else.
 *
 * - `ids` is the deduped, sorted-by-firstSeen list of dwallet object ids.
 * - `firstSeenMs` / `lastSeenMs` are LRU-style maps so we can age out cold entries.
 * - `lastCursor` lets us resume an incremental walk without re-scanning the whole tail.
 * - `lastFullScanMs` records the most recent exhaustive walk; we only walk to the end
 *   periodically and otherwise top up from the head.
 */
export type DWalletIndexSnapshot = {
  ids: string[];
  firstSeenMs: Record<string, number>;
  lastSeenMs: Record<string, number>;
  lastCursor: string | null;
  lastFullScanMs: number | null;
  updatedAtMs: number;
};

/**
 * upper bound on observed dWallet ids we keep in the index. each id costs
 * ~13 RPC calls on a refresh tick so we don't want the long tail to balloon
 * the per-refresh cost. when we hit the cap, LRU-evict by `lastSeenMs` first
 * and `firstSeenMs` as tiebreaker (a dwallet that hasn't been seen in many
 * refresh ticks is probably gone or unfunded).
 */
export const DWALLET_INDEX_CAP = 500;

/** maximum cap-by-type pages to fetch per refresh tick (50 ids per page). */
const DEFAULT_MAX_PAGES_INCREMENTAL = 4;
const DEFAULT_MAX_PAGES_FULL_SCAN = 60; // 60 * 50 = 3000 ids - tail enumeration
const FULL_SCAN_INTERVAL_MS = 24 * 60 * 60 * 1000;

function emptySnapshot(): DWalletIndexSnapshot {
  return {
    ids: [],
    firstSeenMs: {},
    lastSeenMs: {},
    lastCursor: null,
    lastFullScanMs: null,
    updatedAtMs: 0,
  };
}

export async function readDWalletIndex(): Promise<DWalletIndexSnapshot> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get([STORAGE_KEYS.DWALLET_INDEX_V1], (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      const raw = result[STORAGE_KEYS.DWALLET_INDEX_V1];
      if (!raw || typeof raw !== 'object') {
        resolve(emptySnapshot());
        return;
      }
      const r = raw as Partial<DWalletIndexSnapshot>;
      resolve({
        ids: Array.isArray(r.ids) ? r.ids.filter((id): id is string => typeof id === 'string') : [],
        firstSeenMs: (typeof r.firstSeenMs === 'object' && r.firstSeenMs) ? r.firstSeenMs as Record<string, number> : {},
        lastSeenMs: (typeof r.lastSeenMs === 'object' && r.lastSeenMs) ? r.lastSeenMs as Record<string, number> : {},
        lastCursor: typeof r.lastCursor === 'string' ? r.lastCursor : null,
        lastFullScanMs: typeof r.lastFullScanMs === 'number' ? r.lastFullScanMs : null,
        updatedAtMs: typeof r.updatedAtMs === 'number' ? r.updatedAtMs : 0,
      });
    });
  });
}

async function writeDWalletIndex(snap: DWalletIndexSnapshot): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [STORAGE_KEYS.DWALLET_INDEX_V1]: snap }, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

export async function clearDWalletIndex(): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.remove([STORAGE_KEYS.DWALLET_INDEX_V1], () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

/**
 * `getObject({ objectId: capId, include: { json: true } }).object.json` returns the
 * Move struct fields. for `DWalletCap`, the `dwallet_id` field is what we want.
 * the field has shipped under a few different keys across SDK/RPC versions so we
 * check several. matches the multi-field reader at `dwallet-discovery.ts:124-145`.
 */
function extractDwalletIdFromCapJson(json: unknown): string | null {
  if (!json || typeof json !== 'object') return null;
  const j = json as Record<string, unknown>;
  const candidateKeys = ['dwallet_id', 'dwalletId', 'dWalletId', 'dwallet'];
  for (const k of candidateKeys) {
    const v = j[k];
    if (typeof v === 'string' && v.startsWith('0x') && v.length === 66) return v;
  }
  // sometimes wrapped: `dwallet_id_ref: { id: '0x...' }`
  const ref = j['dwallet_id_ref'];
  if (ref && typeof ref === 'object') {
    const id = (ref as { id?: unknown }).id;
    if (typeof id === 'string' && id.startsWith('0x') && id.length === 66) return id;
  }
  return null;
}

/**
 * cap types to enumerate. the original-package + current-package combo mirrors
 * `collectOwnedCaps` in `dwallet-discovery.ts:91` - ika upgrades replace the
 * current package address while old caps keep referencing the original.
 *
 * dedupes via `Set` so a no-op upgrade (where original === current) doesn't
 * double the query volume.
 */
function getDWalletCapTypes(): string[] {
  const s = getSession();
  if (!s) throw new Error('Wallet locked');
  const ik = s.ikaClient.ikaConfig.packages;
  return Array.from(new Set([
    `${ik.ikaDwallet2pcMpcOriginalPackage}::coordinator_inner::DWalletCap`,
    `${ik.ikaDwallet2pcMpcPackage}::coordinator_inner::DWalletCap`,
  ]));
}

/**
 * pull ONE page of caps for a single type. returns the extracted dwallet ids
 * (deduped within the page) plus the next cursor.
 */
async function crawlCapPage(
  capType: string,
  cursor: string | null,
): Promise<{ dwalletIds: string[]; hasNextPage: boolean; endCursor: string | null }> {
  const s = getSession();
  if (!s) throw new Error('Wallet locked');
  const page = await queryObjectsByTypeGraphQL(s.suiClient, {
    filter: { type: capType },
    first: 50,
    after: cursor,
  });
  const dwalletIds: string[] = [];
  const seen = new Set<string>();
  for (const node of page.nodes) {
    const id = extractDwalletIdFromCapJson(node.json);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    dwalletIds.push(id);
  }
  return { dwalletIds, hasNextPage: page.hasNextPage, endCursor: page.endCursor };
}

/**
 * merge a batch of freshly-observed dwallet ids into the snapshot. updates
 * `firstSeenMs` once, refreshes `lastSeenMs` every time, and evicts LRU when
 * we exceed `DWALLET_INDEX_CAP`.
 */
function mergeIds(snap: DWalletIndexSnapshot, observed: string[], nowMs: number): void {
  for (const id of observed) {
    if (!(id in snap.firstSeenMs)) {
      snap.firstSeenMs[id] = nowMs;
      snap.ids.push(id);
    }
    snap.lastSeenMs[id] = nowMs;
  }

  if (snap.ids.length <= DWALLET_INDEX_CAP) return;

  // LRU evict: sort by lastSeenMs desc (most-recent first), drop the tail.
  // ties broken by firstSeenMs desc so newer arrivals beat ancient cold ones.
  snap.ids.sort((a, b) => {
    const la = snap.lastSeenMs[a] ?? 0;
    const lb = snap.lastSeenMs[b] ?? 0;
    if (la !== lb) return lb - la;
    return (snap.firstSeenMs[b] ?? 0) - (snap.firstSeenMs[a] ?? 0);
  });
  const dropped = snap.ids.splice(DWALLET_INDEX_CAP);
  for (const id of dropped) {
    delete snap.firstSeenMs[id];
    delete snap.lastSeenMs[id];
  }
}

export type RefreshOptions = {
  /** force a full scan to the end of pagination, ignoring `FULL_SCAN_INTERVAL_MS`. */
  forceFullScan?: boolean;
  /** override max-pages for this single call (mostly for tests). */
  maxPages?: number;
};

export type RefreshResult = {
  observed: number;
  added: number;
  pagesWalked: number;
  hasNextPage: boolean;
  fullScan: boolean;
};

/**
 * refresh the persistent index. cheap by default (4 pages = 200 cap reads); promotes
 * to a full scan if 24h have passed since the last full walk OR `forceFullScan` is
 * set. always resumes from the previously-stored cursor on incremental ticks so we
 * follow the new-caps tail rather than re-scanning the head every time.
 *
 * pre-checks the session is unlocked - alarm-driven callers should already gate
 * via `isUnlocked()` upstream, but the explicit throw makes lock-time crashes
 * surface in logs rather than a silent no-op.
 */
export async function refreshDWalletIndex(opts: RefreshOptions = {}): Promise<RefreshResult> {
  const nowMs = Date.now();
  const snap = await readDWalletIndex();
  const isFullScan = Boolean(
    opts.forceFullScan
    || snap.lastFullScanMs == null
    || nowMs - snap.lastFullScanMs > FULL_SCAN_INTERVAL_MS,
  );
  const maxPages = opts.maxPages ?? (isFullScan ? DEFAULT_MAX_PAGES_FULL_SCAN : DEFAULT_MAX_PAGES_INCREMENTAL);

  const capTypes = getDWalletCapTypes();
  let totalObserved = 0;
  const beforeCount = snap.ids.length;
  let pagesWalked = 0;
  let hasNextPageAtEnd = false;
  let lastEndCursor: string | null = snap.lastCursor;

  // for a full scan we start from null cursor on each cap type; for incremental we
  // resume from the snapshot's lastCursor. multiple cap types share the same cursor
  // namespace at the GraphQL layer, so we accept the duplication - it's cheap.
  let cursor: string | null = isFullScan ? null : snap.lastCursor;
  outer: for (const capType of capTypes) {
    cursor = isFullScan ? null : snap.lastCursor;
    for (;;) {
      const page = await crawlCapPage(capType, cursor);
      pagesWalked += 1;
      totalObserved += page.dwalletIds.length;
      mergeIds(snap, page.dwalletIds, nowMs);
      lastEndCursor = page.endCursor;
      hasNextPageAtEnd = page.hasNextPage;
      if (!page.hasNextPage) break;
      cursor = page.endCursor;
      if (pagesWalked >= maxPages) break outer;
    }
  }

  snap.lastCursor = isFullScan && !hasNextPageAtEnd ? null : lastEndCursor;
  if (isFullScan && !hasNextPageAtEnd) snap.lastFullScanMs = nowMs;
  snap.updatedAtMs = nowMs;

  await writeDWalletIndex(snap);

  return {
    observed: totalObserved,
    added: snap.ids.length - beforeCount,
    pagesWalked,
    hasNextPage: hasNextPageAtEnd,
    fullScan: isFullScan,
  };
}

/** push a dwallet id into the index manually (e.g. from a paste-id action in the UI). */
export async function upsertDWalletIndexId(dwalletId: string): Promise<void> {
  const id = dwalletId.trim();
  if (!id.startsWith('0x') || id.length !== 66) throw new Error('not a sui dwallet object id');
  const snap = await readDWalletIndex();
  const nowMs = Date.now();
  mergeIds(snap, [id], nowMs);
  snap.updatedAtMs = nowMs;
  await writeDWalletIndex(snap);
}

/** remove a dwallet id (UI surfaces a hide-from-leaderboard action). */
export async function removeDWalletIndexId(dwalletId: string): Promise<void> {
  const snap = await readDWalletIndex();
  const idx = snap.ids.indexOf(dwalletId);
  if (idx === -1) return;
  snap.ids.splice(idx, 1);
  delete snap.firstSeenMs[dwalletId];
  delete snap.lastSeenMs[dwalletId];
  snap.updatedAtMs = Date.now();
  await writeDWalletIndex(snap);
}
