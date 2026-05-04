import { SuiGraphQLClient } from '@mysten/sui/graphql';
import { graphqlUrlForNetwork, registrySuiIdToSuiNetworkId, type SuiNetworkId } from '@/config/sui';
import {
  createSuiGraphqlDebugFetch,
  createSuiGraphqlPaginationCaptureFetch,
  isSuiGraphqlDebugEnabled,
  isSuiGraphqlPaginationDebugEnabled,
} from '@/background/sui-graphql-debug-fetch';

const GRAPHQL_RETRY_MAX_ATTEMPTS = 5;
const GRAPHQL_RETRY_BASE_DELAY_MS = 500;

/** HTTP status codes worth retrying - transient server/gateway issues. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

// ---------------------------------------------------------------------------
// global request throttle
// ---------------------------------------------------------------------------
// public Sui GraphQL endpoints rate-limit on burst volume. ika signing fires
// many requests in rapid succession (coordinator init, encryption keys, presign
// polling, coin listings, cap lookups, execute, etc.). a per-request retry
// helps with isolated blips, but once you're 429'd every subsequent request
// also gets 429'd and blows through its retry budget. this throttle serializes
// requests through a global queue with a minimum gap between dispatches.

const THROTTLE_MIN_GAP_MS = 120;
const THROTTLE_429_COOLDOWN_MS = 4_000;

let lastDispatchMs = 0;
let cooldownUntilMs = 0;

async function throttleGate(): Promise<void> {
  const now = Date.now();
  // if a 429 was recently seen, wait out the cooldown first
  if (now < cooldownUntilMs) {
    await new Promise((r) => setTimeout(r, cooldownUntilMs - now));
  }
  const sinceLast = Date.now() - lastDispatchMs;
  if (sinceLast < THROTTLE_MIN_GAP_MS) {
    await new Promise((r) => setTimeout(r, THROTTLE_MIN_GAP_MS - sinceLast));
  }
  lastDispatchMs = Date.now();
}

function on429Seen(): void {
  cooldownUntilMs = Date.now() + THROTTLE_429_COOLDOWN_MS;
}

// ---------------------------------------------------------------------------
// per-request retry with exponential backoff
// ---------------------------------------------------------------------------

/**
 * wrap fetch so transient GraphQL failures are retried with exponential backoff:
 * - HTTP 429/502/503/504 - server / gateway errors
 * - fetch() throws (TypeError "Failed to fetch", network connectivity blips)
 * these cover the ika SDK's "Failed to fetch encryption keys" / "Network error" paths.
 */
function fetchWithRetryOnTransient(inner: typeof fetch): typeof fetch {
  return (input: RequestInfo | URL, init?: RequestInit) =>
    (async () => {
      let lastErr: unknown;
      for (let attempt = 0; attempt < GRAPHQL_RETRY_MAX_ATTEMPTS; attempt++) {
        await throttleGate();
        let res: Response;
        try {
          res = await inner(input, init);
        } catch (e) {
          lastErr = e;
          if (attempt < GRAPHQL_RETRY_MAX_ATTEMPTS - 1) {
            await new Promise((r) => setTimeout(r, GRAPHQL_RETRY_BASE_DELAY_MS * 2 ** attempt));
          }
          continue;
        }
        if (res.status === 429) {
          on429Seen();
        }
        if (!isRetryableStatus(res.status)) return res;
        lastErr = new Error(`GraphQL HTTP ${res.status}`);
        if (attempt < GRAPHQL_RETRY_MAX_ATTEMPTS - 1) {
          const delay = res.status === 429
            ? Math.max(THROTTLE_429_COOLDOWN_MS, GRAPHQL_RETRY_BASE_DELAY_MS * 2 ** attempt)
            : GRAPHQL_RETRY_BASE_DELAY_MS * 2 ** attempt;
          await new Promise((r) => setTimeout(r, delay));
        }
      }
      if (lastErr) throw lastErr;
      throw new Error('GraphQL fetch failed after retries');
    })();
}

/**
 * Sui GraphQL servers reject POST bodies over ~5000 bytes; `client.core.getObjects` defaults
 * to chunking 50 ids per call which blows past that for non-trivial NFT / kiosk / ika object
 * graphs. replaces the (since-removed) `@mysten/sui@2.13.2` patch with a runtime override:
 * chunks 12 ids per call + 100ms gap between batches to stay under common GraphQL rate limits.
 *
 * apply at every `new SuiGraphQLClient(...)` site so all callers benefit transparently.
 *
 * if a future Mysten SDK ships its own chunking, this becomes a no-op (the wrap still chunks
 * 12 → 12 → ..., which is harmless). drop the wrapper when Mysten chunks ≤ 12 by default.
 */
function installGetObjectsChunking<T extends SuiGraphQLClient>(client: T): T {
  const core = client.core as unknown as {
    getObjects: (options: { objectIds: string[]; [k: string]: unknown }) => Promise<{ objects: unknown[] }>;
  };
  const original = core.getObjects.bind(client.core);
  core.getObjects = async (options) => {
    const ids = options?.objectIds ?? [];
    if (!Array.isArray(ids) || ids.length <= 12) return original(options);
    const merged: unknown[] = [];
    for (let i = 0; i < ids.length; i += 12) {
      const slice = ids.slice(i, i + 12);
      const page = await original({ ...options, objectIds: slice });
      merged.push(...(page?.objects ?? []));
      if (i + 12 < ids.length) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    return { objects: merged };
  };
  return client;
}

/**
 * GraphQL client for a settings registry id (`sui-mainnet`, `sui-testnet`).
 * delegates to `createSuiGraphQLClient` (ika + PTBs use GraphQL core API).
 */
export function createSuiGraphQLClientFromRegistryNetworkId(registryId: string): SuiGraphQLClient {
  return createSuiGraphQLClient(registrySuiIdToSuiNetworkId(registryId));
}

/**
 * single `SuiGraphQLClient` per Mysten `SuiNetworkId` (mainnet | testnet).
 */
export function createSuiGraphQLClient(network: SuiNetworkId): SuiGraphQLClient {
  const url = graphqlUrlForNetwork(network);
  const label = `SuiGraphQLClient(${network})`;
  let chainFetch: typeof fetch = globalThis.fetch.bind(globalThis);
  if (isSuiGraphqlPaginationDebugEnabled()) {
    chainFetch = createSuiGraphqlPaginationCaptureFetch(label, chainFetch);
  }
  if (isSuiGraphqlDebugEnabled()) {
    chainFetch = createSuiGraphqlDebugFetch(label, chainFetch);
  }
  return installGetObjectsChunking(
    new SuiGraphQLClient({
      url,
      network,
      fetch: fetchWithRetryOnTransient(chainFetch),
    }),
  );
}

// ---------------------------------------------------------------------------
// transactionBlocks GraphQL helper
// ---------------------------------------------------------------------------
// `@mysten/sui@2.13.2`'s `client.core.*` only has `getTransaction(digest)` - no
// filtered `transactionBlocks` wrapper. until Mysten ships one, hit Sui GraphQL
// directly with a small hand-rolled document. two call sites consume this:
// the user activity feed (affectedAddress filter) and the chroma lab explorer
// (changedObject + sentAddress parallel queries).

/** GraphQL filter shape - superset of the subset we actually use. */
export type SuiTxBlocksFilter = {
  affectedAddress?: string;
  sentAddress?: string;
  changedObject?: string;
};

export type SuiTxSummary = {
  digest: string;
  timestampMs: number | null;
  status: 'success' | 'failure';
  sender: string | null;
  /** transaction kind `__typename`, e.g. `ProgrammableTransactionBlock`. */
  kind: string | null;
  /** object ids the tx created (from `objectChanges` where `idCreated`). */
  createdObjectIds: string[];
  /** raw `contents.json` values for each event - walked by `idsFromEvents`. */
  eventJsons: unknown[];
};

type GqlTxNode = {
  digest: string;
  effects?: {
    timestamp?: string | null;
    status?: string | null;
    transaction?: {
      kind?: { __typename?: string } | null;
      sender?: { address?: string | null } | null;
    } | null;
    objectChanges?: {
      nodes?: Array<{
        idCreated?: boolean | null;
        outputState?: { address?: string | null } | null;
      }> | null;
    } | null;
  } | null;
  events?: {
    nodes?: Array<{ contents?: { json?: unknown } | null }> | null;
  } | null;
};

type GqlTxBlocksResponse = {
  data?: {
    transactionBlocks?: {
      nodes?: GqlTxNode[] | null;
    } | null;
  };
  errors?: Array<{ message?: string }>;
};

const TX_BLOCKS_QUERY = /* GraphQL */ `
  query ChromatikaTxBlocks(
    $filter: TransactionBlockFilter
    $first: Int
    $includeEvents: Boolean!
  ) {
    transactionBlocks(filter: $filter, first: $first) {
      nodes {
        digest
        effects {
          timestamp
          status
          transaction {
            kind {
              __typename
            }
            sender {
              address
            }
          }
          objectChanges(first: 50) {
            nodes {
              idCreated
              outputState {
                address
              }
            }
          }
        }
        events @include(if: $includeEvents) {
          nodes {
            contents {
              json
            }
          }
        }
      }
    }
  }
`;

function normalizeSuiTxNode(node: GqlTxNode): SuiTxSummary {
  const effects = node.effects ?? undefined;
  const rawTs = effects?.timestamp ?? null;
  // GraphQL timestamp is ISO-8601; JSON-RPC side used epoch-ms strings.
  // parse ISO to ms; if already numeric, fall through.
  let timestampMs: number | null = null;
  if (rawTs != null) {
    const n = Number(rawTs);
    if (Number.isFinite(n)) {
      timestampMs = n;
    } else {
      const parsed = Date.parse(rawTs);
      timestampMs = Number.isFinite(parsed) ? parsed : null;
    }
  }
  const status: 'success' | 'failure' =
    (effects?.status ?? '').toUpperCase() === 'SUCCESS' ? 'success' : 'failure';
  const sender = effects?.transaction?.sender?.address ?? null;
  const kind = effects?.transaction?.kind?.__typename ?? null;
  const createdObjectIds: string[] = [];
  for (const row of effects?.objectChanges?.nodes ?? []) {
    const id = row?.outputState?.address;
    if (row?.idCreated && typeof id === 'string' && id.startsWith('0x') && id.length === 66) {
      createdObjectIds.push(id);
    }
  }
  const eventJsons: unknown[] = (node.events?.nodes ?? [])
    .map((n) => n?.contents?.json)
    .filter((v): v is unknown => v !== undefined && v !== null);
  return { digest: node.digest, timestampMs, status, sender, kind, createdObjectIds, eventJsons };
}

/**
 * run `transactionBlocks` with a filter. returns a normalized `SuiTxSummary[]`
 * sorted descending by `timestampMs` (nulls last) to match the old JSON-RPC
 * `order: 'descending'` contract.
 */
export async function queryTransactionBlocksGraphQL(
  client: SuiGraphQLClient,
  opts: {
    filter: SuiTxBlocksFilter;
    limit: number;
    includeEvents?: boolean;
  },
): Promise<SuiTxSummary[]> {
  const includeEvents = opts.includeEvents ?? false;
  const res = (await client.query({
    query: TX_BLOCKS_QUERY,
    variables: {
      filter: opts.filter,
      first: opts.limit,
      includeEvents,
    },
  })) as GqlTxBlocksResponse;
  if (res.errors?.length) {
    const msg = res.errors.map((e) => e?.message).filter(Boolean).join('; ');
    throw new Error(`Sui GraphQL transactionBlocks: ${msg}`);
  }
  const nodes = res.data?.transactionBlocks?.nodes ?? [];
  const rows = nodes.map(normalizeSuiTxNode);
  rows.sort((a, b) => (b.timestampMs ?? 0) - (a.timestampMs ?? 0));
  return rows;
}
