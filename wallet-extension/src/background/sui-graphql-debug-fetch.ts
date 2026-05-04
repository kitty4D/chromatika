/**
 * wraps global fetch for SuiGraphQLClient so we can see which GraphQL calls fail in the
 * service worker console (chrome://extensions → service worker → Inspect).
 *
 * enable console logging via `VITE_DEBUG_GRAPHQL=true` in `.env` (or `import.meta.env.DEV`).
 *
 * optional allowlist: `VITE_DEBUG_GRAPHQL_OPS=multiGetObjects,getObject,_anon_` (comma-separated,
 * case-insensitive). when set, only matching operation hints log request/response/body noise;
 * errors (`!res.ok`, fetch throws) still log. use `_anon_` for bodies we could not name.
 *
 * pagination capture for `getDynamicFields` (separate flag so you can record without console spam):
 * `VITE_DEBUG_GRAPHQL_PAGINATION=true`, or any time console graphql debug / dev is on.
 */

import { recordGetDynamicFieldsPage } from '@/background/sui-graphql-pagination-debug';

function graphqlOperationHintFromBody(body: unknown): string | undefined {
  if (typeof body !== 'string') return undefined;
  try {
    const j = JSON.parse(body) as { operationName?: string; query?: string };
    if (j.operationName) return j.operationName;
    const m = j.query?.match(/\b(?:query|mutation|subscription)\s+(\w+)/);
    if (m?.[1]) return m[1];
    return undefined;
  } catch {
    return undefined;
  }
}

export function isSuiGraphqlDebugEnabled(): boolean {
  return Boolean(import.meta.env.DEV || import.meta.env.VITE_DEBUG_GRAPHQL === 'true');
}

/** record `getDynamicFields` pages into `getGraphqlPaginationDebugSnapshot()` for UI / tRPC. */
export function isSuiGraphqlPaginationDebugEnabled(): boolean {
  return Boolean(
    import.meta.env.DEV ||
      import.meta.env.VITE_DEBUG_GRAPHQL === 'true' ||
      import.meta.env.VITE_DEBUG_GRAPHQL_PAGINATION === 'true',
  );
}

/** when set (comma-separated), only those operation hints are logged for request/response/body diagnostics. */
const GRAPHQL_DEBUG_ANON_TOKEN = '_anon_';

function graphqlDebugOpsAllowlist(): Set<string> | null {
  const raw = import.meta.env.VITE_DEBUG_GRAPHQL_OPS;
  if (raw == null || String(raw).trim() === '') return null;
  const set = new Set(
    String(raw)
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  return set.size === 0 ? null : set;
}

/** `null` allowlist = log every op. otherwise only matching hints (add `_anon_` for requests we could not name). */
function graphqlDebugShouldLogOpHint(op: string | undefined, allow: Set<string> | null): boolean {
  if (!allow) return true;
  if (allow.has(GRAPHQL_DEBUG_ANON_TOKEN) && (op == null || op === '')) return true;
  if (op == null || op === '') return false;
  return allow.has(op.toLowerCase());
}

/**
 * intercepts GraphQL POSTs whose document contains `getDynamicFields`, clones the JSON response,
 * and records pagination + cycle hints (duplicate `endCursor` per parent).
 */
export function createSuiGraphqlPaginationCaptureFetch(label: string, inner: typeof fetch): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    let vars: { parentId?: string; cursor?: string | null } | null = null;
    if (typeof init?.body === 'string') {
      try {
        const j = JSON.parse(init.body) as { query?: string; variables?: Record<string, unknown> };
        if (j.query?.includes('getDynamicFields')) {
          const v = j.variables ?? {};
          vars = {
            parentId: typeof v.parentId === 'string' ? v.parentId : undefined,
            cursor: typeof v.cursor === 'string' ? v.cursor : null,
          };
        }
      } catch {
        /* ignore */
      }
    }

    const res = await inner(input, init);
    if (vars && res.ok) {
      void res
        .clone()
        .json()
        .then((json: unknown) => {
          recordGetDynamicFieldsPage(label, vars!, json);
        })
        .catch(() => {});
    }
    return res;
  };
}

/**
 * logs each GraphQL request/response when `isSuiGraphqlDebugEnabled()`.
 * pass `inner` to chain after pagination capture (or other wrappers).
 */
export function createSuiGraphqlDebugFetch(label: string, inner: typeof fetch = globalThis.fetch.bind(globalThis)): typeof fetch {
  const debug = isSuiGraphqlDebugEnabled();
  const opAllow = graphqlDebugOpsAllowlist();

  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : 'url' in input
            ? input.url
            : String(input);
    const op = graphqlOperationHintFromBody(init?.body);
    const loud = graphqlDebugShouldLogOpHint(op, opAllow);
    const t0 = typeof performance !== 'undefined' ? performance.now() : 0;

    if (debug && loud) {
       
      console.info(`[chromatika graphql] ${label} request`, {
        url,
        operationName: op ?? '(anonymous / no operationName in body)',
      });
    }

    try {
      const res = await inner(input, init);
      const ms = typeof performance !== 'undefined' ? Math.round(performance.now() - t0) : 0;
      const contentLengthHdr = res.headers.get('content-length');
      if (debug && loud) {
         
        console.info(`[chromatika graphql] ${label} response`, {
          url,
          status: res.status,
          ok: res.ok,
          ms,
          contentLength: contentLengthHdr,
        });
      }
      // HTTP 200 with an empty body still looks "ok" here - `SuiGraphQLClient` then throws on `res.json()`.
      if (debug && res.ok && loud) {
        void res
          .clone()
          .text()
          .then((t) => {
            if (t.length === 0) {
               
              console.warn(`[chromatika graphql] ${label} HTTP 200 but empty body (next JSON parse → unexpected end of input)`, {
                url,
                operationName: op ?? '(unknown)',
                ms,
                contentLengthHeader: contentLengthHdr,
              });
            } else if (t.length < 4) {
               
              console.warn(`[chromatika graphql] ${label} HTTP 200 but tiny body (${t.length} chars)`, {
                url,
                operationName: op ?? '(unknown)',
                ms,
                preview: t,
                contentLengthHeader: contentLengthHdr,
              });
            } else {
              try {
                JSON.parse(t);
              } catch (je) {
                const msg = je instanceof Error ? je.message : String(je);
                 
                console.warn(`[chromatika graphql] ${label} HTTP 200 but body is not valid JSON`, {
                  url,
                  operationName: op ?? '(unknown)',
                  ms,
                  bodyChars: t.length,
                  contentLengthHeader: contentLengthHdr,
                  preview: t.slice(0, 600),
                  parseError: msg,
                });
              }
              // short payloads (e.g. 35b) are worth eyeballing next to multiGetObjects polls
              if (t.length <= 160) {
                 
                console.info(`[chromatika graphql] ${label} small JSON body`, {
                  url,
                  operationName: op ?? '(unknown)',
                  bodyChars: t.length,
                  body: t,
                });
              }
            }
          })
          .catch((e) => {
             
            console.warn(`[chromatika graphql] ${label} response body clone/read failed (debug)`, {
              url,
              operationName: op,
              message: e instanceof Error ? e.message : String(e),
            });
          });
      }
      if (!res.ok && debug) {
        const text = await res.clone().text().catch(() => '');
         
        console.warn(`[chromatika graphql] ${label} non-ok body (truncated)`, text.slice(0, 800));
      }
      return res;
    } catch (e) {
      const ms = typeof performance !== 'undefined' ? Math.round(performance.now() - t0) : 0;
      const err = e instanceof Error ? e : new Error(String(e));
       
      console.error(`[chromatika graphql] ${label} fetch threw after ${ms}ms`, {
        url,
        operationName: op,
        name: err.name,
        message: err.message,
        cause: (err as Error & { cause?: unknown }).cause,
      });
      throw e;
    }
  };
}
