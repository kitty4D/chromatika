/**
 * Indexed activity store - foundation for serving as a "personal indexer" of the user's
 * vault wallets. Phase 1 ships the schema, storage layer, and lookup primitives; the
 * per-chain workers that walk pagination back through provider APIs land in Phase 2.
 *
 * Why IndexedDB (not chrome.storage.local):
 *  - `chrome.storage.local` serializes the entire row on every write. A vault with 10k
 *    indexed txs across chains is 5-15 MB; rewriting that on every new tx is unworkable.
 *  - IndexedDB supports per-key writes, real indices, and range queries - all of which
 *    we need for the first-time-recipient lookup and incremental sync cursors.
 *  - MV3 service workers fully support IDB; we just reopen the DB on each SW wake (the
 *    same pattern the offscreen media cache uses).
 *
 * NO false-confidence guardrail (user's explicit requirement):
 *  - Every (vaultId, chain, address) tuple carries a `coverage` state with four levels:
 *      'never'              -> nothing indexed for this address yet
 *      'partial'            -> walker ran but didn't finish (cancelled / errored / in progress)
 *      'complete-to-retention'  -> walker reached the provider's retention horizon, but the
 *                                  provider is known to retain less than chain history
 *                                  (Solana free RPCs only keep ~2-3 epochs)
 *      'complete-to-genesis'    -> walker paginated to chain genesis with archival coverage
 *  - The UI must NEVER claim "you've never sent here" without checking that coverage is
 *    `'complete-to-genesis'` AND `lastSyncedAt` is recent. Helpers below expose the state
 *    so callers can render the right confidence tier.
 *
 * What we index (only what's needed for first-time-recipient detection + future personal
 * indexer queries):
 *  - one row per outbound tx: digest, chain, sender, recipient, amount (best-effort), token
 *    symbol, blockNumber/slot, timestampMs, providerSource
 *  - we DO NOT index inbound txs in Phase 1 - first-time-recipient only needs outbound,
 *    and inbound doubles the storage. Phase 2 can add inbound for a richer activity view.
 *  - we DO NOT index internal subcalls / token-transfer events as separate rows yet -
 *    for now, one row = one tx with a single primary counterparty.
 */

const DB_NAME = 'chromatika_activity_index_v1';
/** schema v2 (2026-05-18): added `kind`/`swapMeta`/`memo`/`status`/`pendingMeta`/`priceUsdAtSync`
 * fields on the `tx` store and a new `byStatus` index for fast pending-row enumeration.
 * existing v1 rows are migrated in-place: every old row gets `status: 'success'` (we only
 * ever indexed completed txs in v1) and `kind: 'unknown'` (re-classified on the next
 * walker pass). The DB_NAME stays the same; bumping the suffix would force users to re-
 * index everything which is wasteful when an additive schema migration handles it. */
const DB_VERSION = 2;
const STORE_TX = 'tx';
const STORE_COVERAGE = 'coverage';

/** how recent a sync must be before we treat `'complete-to-genesis'` as confidence-eligible.
 * 30 minutes is generous - the user can re-trigger sync from the activity page if they want
 * a tighter window. tighter than 30s would force a re-sync on every confirm-step render. */
export const COVERAGE_RECENT_WINDOW_MS = 30 * 60 * 1000;

export type ActivityIndexChain = 'sui' | 'evm' | 'solana' | 'btc' | 'aptos';

export type CoverageStatus =
  | 'never'
  | 'partial'
  | 'complete-to-retention'
  | 'complete-to-genesis';

export type IndexedTx = {
  /** stable key: `${chain}:${vaultId}:${digest}` so the same digest under different vaults
   * indexes independently (a multi-vault user with the same imported wallet would otherwise
   * dedup across vaults, which is wrong - per-vault scoping is the unit of trust). */
  key: string;
  vaultId: string;
  chain: ActivityIndexChain;
  /** chain-native tx id (EVM hash, Sui digest, Solana sig, BTC txid). */
  digest: string;
  /** the wallet address this row was indexed UNDER (the perspective). may equal sender for
   * outbound or recipient for inbound (Phase 1 only indexes outbound). */
  perspectiveAddress: string;
  /** the OTHER party. for outbound: recipient. comparison is case-insensitive on hex
   * chains, case-sensitive on Solana / BTC. */
  counterparty: string | null;
  /** for sortability and incremental-sync cursoring. EVM = block number, Sui = checkpoint,
   * Solana = slot, BTC = block height, Aptos = version. bigint-as-string. */
  position: string;
  timestampMs: number | null;
  /** best-effort token symbol (native or token-name). null when we couldn't tell. */
  symbol: string | null;
  /** raw amount in base units. bigint-as-string. null when not applicable / not parseable. */
  amountRaw: string | null;
  /** which upstream we got this row from (alchemy / blockscout / esplora / helius / mysten / etc.).
   * useful for debugging completeness mismatches. */
  source: string;

  // ---- v2 fields (added 2026-05-18). all optional in the IDB row so v1 reads are safe. ----

  /** semantic tx kind for UI rendering. set by the per-chain classifier
   * (`activity-classifier/*`). `'unknown'` when the classifier couldn't pattern-match. */
  kind?: IndexedTxKind;
  /** for swap rows: the from/to asset metadata so the UI can render "X SUI <-> Y IKA"
   * without a follow-up RPC. populated by the classifier when `kind === 'swap'`. */
  swapMeta?: {
    fromSymbol: string | null;
    fromAmountRaw: string | null;
    toSymbol: string | null;
    toAmountRaw: string | null;
  };
  /** chain-native memo when present (Solana Memo Program / Aptos note / Stellar memo /
   * Cosmos memo). distinct from `SignedTxRecord.encryptedNote` which is the
   * user-attached, ed25519-encrypted personal note. */
  memo?: string | null;
  /** pending-tx tracking (Bucket A). default `'success'` for v1-migrated rows; rows
   * inserted via `insertPendingTx` start as `'pending'` and get flipped by the
   * reconciler. */
  status?: 'pending' | 'success' | 'failure';
  pendingMeta?: {
    broadcastAtMs: number;
    lastPolledAtMs: number;
    attemptCount: number;
    /** for L2 hash replacement (Arbitrum sequencer reorgs, etc.); carry the originally-
     * broadcast hash so reconciler can rewrite the row in place if the chain settles
     * the same logical tx under a different hash. */
    originalDigest: string;
    /** EVM chainId the tx was broadcast on (e.g. 42161 for Arbitrum). reconciler uses
     * this to point `eth_getTransactionReceipt` at the right RPC instead of guessing
     * from the wallet's currently-active EVM chain. ignored for non-EVM rows. */
    chainId?: number;
    /** dapp origin captured at broadcast time. lets the UI render the origin pill on
     * pending rows before the explorer fetch picks up the same digest + overlays its
     * own origin from tx-record. */
    origin?: string | null;
  };
  /** USD value at the time the row was indexed (NOT at tx time). UI labels this clearly
   * as "current value, as of <syncTime>" so users don't confuse it with historical
   * price. null when no spot price available or symbol unknown. */
  priceUsdAtSync?: number | null;
};

export type IndexedTxKind =
  | 'transfer'
  | 'transferNFT'
  | 'swap'
  | 'tokenApproval'
  | 'stakeDelegate'
  | 'stakeUndelegate'
  | 'stakeRewards'
  | 'stakeWithdraw'
  | 'assetActivation'
  | 'smartContractCall'
  | 'unknown';

export type CoverageRecord = {
  /** key: `${chain}:${vaultId}:${address.toLowerCase()}` */
  key: string;
  vaultId: string;
  chain: ActivityIndexChain;
  address: string;
  /** see CoverageStatus jsdoc. */
  status: CoverageStatus;
  /** newest position the walker has reached (= cursor for incremental sync). null when
   * the walker hasn't started. bigint-as-string. */
  newestPosition: string | null;
  /** oldest position the walker has reached. null when the walker hasn't started. */
  oldestPosition: string | null;
  /** wall-clock ms of the most recent successful walker run. null = never run. */
  lastSyncedAtMs: number | null;
  /** for `'partial'`: where the walker was when it stopped, so resume can pick up. */
  resumeCursor: string | null;
  /** if last run errored, the human message; cleared on next successful sync. */
  lastError: string | null;
  /** total number of indexed rows for this address (cached running total; recomputed
   * during background maintenance to absorb drift from any direct deletes). */
  rowCount: number;
};

// ---------------------------------------------------------------------------
// IDB plumbing
// ---------------------------------------------------------------------------

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      const oldVersion = (event as IDBVersionChangeEvent).oldVersion;
      // v0 -> v1 (fresh install): create stores + initial indexes.
      if (oldVersion < 1) {
        const store = db.createObjectStore(STORE_TX, { keyPath: 'key' });
        store.createIndex('byPerspective', ['vaultId', 'chain', 'perspectiveAddress', 'position']);
        store.createIndex('byCounterparty', ['vaultId', 'counterparty']);
        db.createObjectStore(STORE_COVERAGE, { keyPath: 'key' });
      }
      // v1 -> v2: add `byStatus` index, backfill v1 rows with `status: 'success'` +
      // `kind: 'unknown'`. The upgradeneeded transaction is auto-readwrite by spec;
      // we walk the existing rows via openCursor + put.
      if (oldVersion < 2) {
        const txn = req.transaction!;
        const store = txn.objectStore(STORE_TX);
        if (!store.indexNames.contains('byStatus')) {
          store.createIndex('byStatus', ['vaultId', 'status', 'position']);
        }
        // backfill: every v1 row gets `status: 'success'` (we only indexed completed txs)
        // and `kind: 'unknown'` (classifier reclassifies on next walker pass).
        const cursorReq = store.openCursor();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor) return;
          const row = cursor.value as IndexedTx;
          let dirty = false;
          if (row.status == null) {
            row.status = 'success';
            dirty = true;
          }
          if (row.kind == null) {
            row.kind = 'unknown';
            dirty = true;
          }
          if (dirty) cursor.update(row);
          cursor.continue();
        };
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexeddb open failed'));
  });
  return dbPromise;
}

function coverageKey(vaultId: string, chain: ActivityIndexChain, address: string): string {
  // EVM + Sui + Aptos are case-insensitive on the address side; Solana + BTC keep case.
  const norm = chain === 'evm' || chain === 'sui' || chain === 'aptos'
    ? address.toLowerCase()
    : address;
  return `${chain}:${vaultId}:${norm}`;
}

/** stable per-tx key. Phase 2 walkers call this when building rows. exported so workers
 * in `wallet-extension/src/background/services/activity-index-workers/` (Phase 2) can
 * produce identical keys without re-importing the formula. */
export function makeTxKey(chain: ActivityIndexChain, vaultId: string, digest: string): string {
  return `${chain}:${vaultId}:${digest}`;
}

function idbGet<T>(db: IDBDatabase, store: string, key: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error ?? new Error('idb get failed'));
  });
}

function idbPut<T>(db: IDBDatabase, store: string, value: T): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value as unknown as Parameters<IDBObjectStore['put']>[0]);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('idb put failed'));
  });
}

function idbCountByIndex(
  db: IDBDatabase,
  store: string,
  indexName: string,
  range: IDBKeyRange,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const idx = tx.objectStore(store).index(indexName);
    const req = idx.count(range);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('idb count failed'));
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** bulk lookup by digest set, returning a Map<digest, IndexedTx>. used by the live
 * activity feed merge to overlay `kind` / `swapMeta` / `memo` / `priceUsdAtSync` from
 * the indexed-activity store onto explorer-fetched rows.
 *
 * uses byCounterparty index isn't right - the digest isn't directly indexed because
 * `key` already encodes it. instead we open the tx store and iterate (the chain+vault
 * filter is enforced by the lookup map). performant enough because the feed is bounded
 * to a few hundred digests per call and a single IDB transaction covers them all. */
export async function getIndexedTxsByDigests(
  vaultId: string,
  digests: Array<{ chain: ActivityIndexChain; digest: string }>,
): Promise<Map<string, IndexedTx>> {
  if (digests.length === 0) return new Map();
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const out = new Map<string, IndexedTx>();
    const tx = db.transaction(STORE_TX, 'readonly');
    const store = tx.objectStore(STORE_TX);
    let remaining = digests.length;
    const finish = () => {
      if (remaining === 0) resolve(out);
    };
    for (const { chain, digest } of digests) {
      const key = makeTxKey(chain, vaultId, digest);
      const req = store.get(key);
      req.onsuccess = () => {
        const v = req.result as IndexedTx | undefined;
        if (v) out.set(digest, v);
        remaining -= 1;
        finish();
      };
      req.onerror = () => {
        remaining -= 1;
        finish();
      };
    }
    tx.onerror = () => reject(tx.error ?? new Error('idb bulk-get failed'));
  });
}

/** read one indexed tx by key. used by the pending-tx reconciler to fetch the current
 * row state before mutating it. returns `undefined` when not present. */
export async function getIndexedTx(key: string): Promise<IndexedTx | undefined> {
  const db = await openDb();
  return idbGet<IndexedTx>(db, STORE_TX, key);
}

/** delete one indexed tx by key. used by the pending-tx reconciler when handling L2 hash
 * replacement (the new row gets inserted under a different key; the old key is dropped). */
export async function deleteIndexedTx(key: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_TX, 'readwrite');
    tx.objectStore(STORE_TX).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('idb delete failed'));
  });
}

/** list all rows with a given status for a vault. used by the reconciler to find pending
 * rows on SW startup, and by the activity feed to overlay pending rows at the head. */
export async function listIndexedTxsByStatus(
  vaultId: string,
  status: 'pending' | 'success' | 'failure',
): Promise<IndexedTx[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_TX, 'readonly');
    const idx = tx.objectStore(STORE_TX).index('byStatus');
    // byStatus is keyed on [vaultId, status, position]. range over the whole [vaultId, status, *] band.
    const lo: [string, string, string] = [vaultId, status, ''];
    const hi: [string, string, string] = [vaultId, status, '￿'];
    const req = idx.openCursor(IDBKeyRange.bound(lo, hi), 'prev');
    const out: IndexedTx[] = [];
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) {
        resolve(out);
        return;
      }
      out.push(cursor.value as IndexedTx);
      cursor.continue();
    };
    req.onerror = () => reject(req.error ?? new Error('idb byStatus cursor failed'));
  });
}

/**
 * record one or more outbound txs from a single walker pass. dedupes by key; idempotent on
 * repeat calls with the same digest. callers should batch reasonable chunks (~100-500 rows)
 * per call to keep transaction commits responsive.
 */
export async function recordIndexedTxs(rows: IndexedTx[]): Promise<void> {
  if (rows.length === 0) return;
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_TX, 'readwrite');
    const store = tx.objectStore(STORE_TX);
    for (const r of rows) store.put(r);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('idb batch put failed'));
  });
}

/** read the current coverage record for `(vaultId, chain, address)`. returns a `'never'`
 * synthetic record when no entry exists, so callers always get a usable shape. */
export async function getCoverage(
  vaultId: string,
  chain: ActivityIndexChain,
  address: string,
): Promise<CoverageRecord> {
  const db = await openDb();
  const key = coverageKey(vaultId, chain, address);
  const hit = await idbGet<CoverageRecord>(db, STORE_COVERAGE, key);
  if (hit) return hit;
  return {
    key,
    vaultId,
    chain,
    address,
    status: 'never',
    newestPosition: null,
    oldestPosition: null,
    lastSyncedAtMs: null,
    resumeCursor: null,
    lastError: null,
    rowCount: 0,
  };
}

/** update one field or multiple on the coverage record. creates the record if it doesn't
 * exist. callers typically use this on walker phase transitions: started, partial, complete. */
export async function patchCoverage(
  vaultId: string,
  chain: ActivityIndexChain,
  address: string,
  patch: Partial<Omit<CoverageRecord, 'key' | 'vaultId' | 'chain' | 'address'>>,
): Promise<CoverageRecord> {
  const db = await openDb();
  const current = await getCoverage(vaultId, chain, address);
  const updated: CoverageRecord = { ...current, ...patch };
  await idbPut(db, STORE_COVERAGE, updated);
  return updated;
}

/**
 * has the user (under this vault) ever sent to `counterparty` according to the indexed
 * history? returns one of:
 *   { hit: true, sample } - found at least one outbound tx; `sample` is the most recent
 *   { hit: false } - no rows for this counterparty
 *
 * NOTE: this is a raw lookup. callers that surface a "first time" claim to the user MUST
 * also consult `getCoverage` and only claim "never sent here" when coverage is
 * `'complete-to-genesis'` AND `lastSyncedAtMs` is within `COVERAGE_RECENT_WINDOW_MS`.
 * see `evaluateFirstTimeRecipient` for the policy wrapper.
 */
export async function indexHasOutboundTo(
  vaultId: string,
  counterparty: string,
): Promise<{ hit: true; sample: IndexedTx } | { hit: false }> {
  const db = await openDb();
  // EVM + Sui + Aptos counterparties were normalized to lower-case at write time; Solana +
  // BTC keep case. Try lowercased first, then raw as fallback for cross-chain queries.
  const candidates = [counterparty, counterparty.toLowerCase()];
  for (const c of candidates) {
    const found = await new Promise<IndexedTx | null>((resolve, reject) => {
      const tx = db.transaction(STORE_TX, 'readonly');
      const idx = tx.objectStore(STORE_TX).index('byCounterparty');
      const req = idx.openCursor(IDBKeyRange.only([vaultId, c]), 'prev');
      req.onsuccess = () => {
        const cursor = req.result;
        resolve(cursor ? (cursor.value as IndexedTx) : null);
      };
      req.onerror = () => reject(req.error ?? new Error('idb cursor failed'));
    });
    if (found) return { hit: true, sample: found };
  }
  return { hit: false };
}

/** count indexed rows for `(vaultId, chain, perspectiveAddress)`. used by the UI to show
 * "1,243 txs indexed" next to an address row on the activity page. cheap. */
export async function countIndexedRows(
  vaultId: string,
  chain: ActivityIndexChain,
  perspectiveAddress: string,
): Promise<number> {
  const db = await openDb();
  const lo: [string, ActivityIndexChain, string, string] = [vaultId, chain, perspectiveAddress, ''];
  const hi: [string, ActivityIndexChain, string, string] = [vaultId, chain, perspectiveAddress, '￿'];
  return idbCountByIndex(db, STORE_TX, 'byPerspective', IDBKeyRange.bound(lo, hi));
}

// ---------------------------------------------------------------------------
// First-time-recipient policy wrapper - the trust-tier translator
// ---------------------------------------------------------------------------

export type FirstTimeRecipientVerdict = {
  /** when true, we found NO outbound row to this counterparty in indexed history. when
   * false, we found one - so it's NOT a first-time recipient regardless of coverage tier. */
  noPriorIndexedSend: boolean;
  /** the strongest claim we can honestly make to the user. */
  confidence:
    | 'chromatika-only'        // we only know about chromatika-signed sends; index has nothing
    | 'partial-indexed'        // some history is indexed but coverage is incomplete
    | 'retention-bounded'      // walked to provider retention horizon (Solana)
    | 'full-genesis-recent';   // walked to genesis AND lastSyncedAt is fresh
  /** display copy explaining the claim in non-technical language. */
  displayText: string;
  /** raw coverage records consulted, for the UI to optionally render a "what we checked" expander. */
  consulted: CoverageRecord[];
};

/**
 * evaluate first-time-recipient claim for `(vaultId, chain, counterparty)`. The caller
 * should usually look across ALL their addresses on this chain (every dWallet's derived
 * address + the vault fee-payer for that chain), so this function accepts an array of
 * perspective addresses and unions their coverage states.
 *
 * the policy is intentionally conservative:
 *   - if ANY perspective address has `'complete-to-genesis'` coverage with a recent sync,
 *     and the index has no hit -> we can say "you've never sent here from this vault"
 *   - if ANY perspective address has `'complete-to-retention'`, we degrade to
 *     "we don't see it within the indexed window"
 *   - if all addresses are `'partial'` or `'never'`, we fall back to the chromatika-only
 *     claim (which is what the today's UI already says)
 */
export async function evaluateFirstTimeRecipient(opts: {
  vaultId: string;
  chain: ActivityIndexChain;
  counterparty: string;
  perspectiveAddresses: string[];
  nowMs?: number;
}): Promise<FirstTimeRecipientVerdict> {
  const now = opts.nowMs ?? Date.now();
  // raw lookup first - if it's a hit, no further coverage analysis needed.
  const hit = await indexHasOutboundTo(opts.vaultId, opts.counterparty);
  const noPriorIndexedSend = !hit.hit;

  const consulted: CoverageRecord[] = [];
  for (const addr of opts.perspectiveAddresses) {
    consulted.push(await getCoverage(opts.vaultId, opts.chain, addr));
  }

  // find the best (highest-confidence) coverage state across all perspectives. tier order:
  // complete-to-genesis > complete-to-retention > partial > never.
  const TIER_ORDER: Record<CoverageStatus, number> = {
    'never': 0,
    'partial': 1,
    'complete-to-retention': 2,
    'complete-to-genesis': 3,
  };
  const best = consulted.reduce<CoverageRecord | null>((acc, c) => {
    if (!acc) return c;
    return TIER_ORDER[c.status] > TIER_ORDER[acc.status] ? c : acc;
  }, null);

  // hit means we know it's NOT a first-time recipient; copy is unambiguous regardless of coverage.
  if (!noPriorIndexedSend) {
    return {
      noPriorIndexedSend: false,
      confidence: 'chromatika-only',
      displayText: 'You have sent to this address before.',
      consulted,
    };
  }

  if (best?.status === 'complete-to-genesis' && best.lastSyncedAtMs != null
      && now - best.lastSyncedAtMs < COVERAGE_RECENT_WINDOW_MS) {
    return {
      noPriorIndexedSend: true,
      confidence: 'full-genesis-recent',
      displayText: 'No record of you sending to this address from this vault (full chain history scanned).',
      consulted,
    };
  }
  if (best?.status === 'complete-to-retention') {
    return {
      noPriorIndexedSend: true,
      confidence: 'retention-bounded',
      displayText: `No record in indexed history. Note: the indexer for this chain only retains recent history, so older sends may exist beyond the indexed window.`,
      consulted,
    };
  }
  if (best?.status === 'partial') {
    return {
      noPriorIndexedSend: true,
      confidence: 'partial-indexed',
      displayText: 'No record in Chromatika including the partial history we have indexed. Run a full index from the Activity tab for a stronger guarantee.',
      consulted,
    };
  }
  return {
    noPriorIndexedSend: true,
    confidence: 'chromatika-only',
    displayText: 'First time sending to this address with Chromatika.',
    consulted,
  };
}
