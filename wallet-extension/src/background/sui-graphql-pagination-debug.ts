/**
 * in-memory capture of Sui GraphQL `getDynamicFields` pages (ika table_vec walks, etc.).
 * wired from the service worker fetch wrapper; inspect via settings (advanced) or tRPC.
 */

export type GraphqlDynamicFieldsPageEvent = {
  ts: number;
  label: string;
  parentId: string;
  /** cursor sent with the request; null/empty means first page */
  reqCursorTail: string;
  nodesLen: number;
  hasNextPage: boolean;
  endCursorTail: string;
  /** same endCursor seen before for this parent while pagination claimed more */
  duplicateEndCursor: boolean;
  /** true once we saw a repeated endCursor for this parent */
  cycleDetected: boolean;
};

type ParentAgg = {
  pages: number;
  seenEndCursors: Set<string>;
  cycleDetected: boolean;
  lastHasNextPage: boolean;
  lastNodesLen: number;
};

const MAX_EVENTS = 120;
const MAX_SEEN_CURSORS_PER_PARENT = 50_000;

let events: GraphqlDynamicFieldsPageEvent[] = [];
const byParent = new Map<string, ParentAgg>();

function tail(s: string | null | undefined, n = 18): string {
  if (s == null || s === '') return '(first page)';
  return s.length <= n ? s : `…${s.slice(-n)}`;
}

function getOrCreateParent(parentId: string): ParentAgg {
  let a = byParent.get(parentId);
  if (!a) {
    a = {
      pages: 0,
      seenEndCursors: new Set(),
      cycleDetected: false,
      lastHasNextPage: false,
      lastNodesLen: 0,
    };
    byParent.set(parentId, a);
  }
  return a;
}

/**
 * call from GraphQL fetch wrapper after a successful JSON response.
 */
export function recordGetDynamicFieldsPage(
  label: string,
  variables: { parentId?: string; cursor?: string | null },
  json: unknown,
): void {
  const rec = json as {
    data?: {
      address?: {
        dynamicFields?: {
          pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
          nodes?: unknown[];
        };
      };
    };
  };
  const df = rec.data?.address?.dynamicFields;
  if (!df) return;

  const parentId = variables.parentId ?? '';
  const nodes = Array.isArray(df.nodes) ? df.nodes : [];
  const hasNextPage = Boolean(df.pageInfo?.hasNextPage);
  const endCursor = df.pageInfo?.endCursor ?? null;

  const agg = getOrCreateParent(parentId);
  agg.pages += 1;
  agg.lastHasNextPage = hasNextPage;
  agg.lastNodesLen = nodes.length;

  let duplicateEndCursor = false;
  if (endCursor) {
    if (agg.seenEndCursors.has(endCursor)) {
      duplicateEndCursor = true;
      agg.cycleDetected = true;
    } else if (agg.seenEndCursors.size < MAX_SEEN_CURSORS_PER_PARENT) {
      agg.seenEndCursors.add(endCursor);
    }
  }

  const ev: GraphqlDynamicFieldsPageEvent = {
    ts: Date.now(),
    label,
    parentId: parentId || '(missing parentId)',
    reqCursorTail: tail(variables.cursor ?? null),
    nodesLen: nodes.length,
    hasNextPage,
    endCursorTail: tail(endCursor),
    duplicateEndCursor,
    cycleDetected: agg.cycleDetected,
  };
  events.push(ev);
  if (events.length > MAX_EVENTS) events.shift();
}

export type GraphqlPaginationDebugSnapshot = {
  eventsNewestFirst: GraphqlDynamicFieldsPageEvent[];
  parents: Record<
    string,
    {
      pages: number;
      uniqueEndCursors: number;
      cycleDetected: boolean;
      lastHasNextPage: boolean;
      lastNodesLen: number;
    }
  >;
};

export function getGraphqlPaginationDebugSnapshot(): GraphqlPaginationDebugSnapshot {
  const parents: GraphqlPaginationDebugSnapshot['parents'] = {};
  for (const [id, agg] of byParent) {
    parents[id] = {
      pages: agg.pages,
      uniqueEndCursors: agg.seenEndCursors.size,
      cycleDetected: agg.cycleDetected,
      lastHasNextPage: agg.lastHasNextPage,
      lastNodesLen: agg.lastNodesLen,
    };
  }
  return {
    eventsNewestFirst: [...events].reverse(),
    parents,
  };
}

export function resetGraphqlPaginationDebug(): void {
  events = [];
  byParent.clear();
}
