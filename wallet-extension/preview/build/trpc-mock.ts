/**
 * Replaces `@/lib/trpc` for the preview build. Vite alias points to this file.
 *
 * Returns a Proxy that mimics `createTRPCProxyClient<AppRouter>`: any path you walk
 * (e.g. `trpc.balances.query`, `trpc.addVaultHardware.mutate`) ends in a callable
 * that returns `Promise.resolve(<fixture>)`. The fixture is looked up by procedure
 * path in `./fixtures/registry`. Procedures without a registered fixture log a
 * warning and resolve to `null` so the calling component falls into its empty-state
 * path rather than crashing.
 *
 * Type cast as `CreateTRPCProxyClient<AppRouter>` is `import type` only - the bundler
 * never pulls in `@/server/router` runtime, so the entire background graph
 * (@ika.xyz/sdk, @mysten/sui, ledger libs, vault-store, etc.) tree-shakes cleanly.
 */

import type { CreateTRPCProxyClient } from '@trpc/client';
import type { AppRouter } from '@/server/router';
import { resolveFixture } from './fixtures/registry';

type ProcedureCall = 'query' | 'mutate' | 'subscribe';
const PROCEDURE_TERMINALS: ReadonlySet<string> = new Set([
  'query',
  'mutate',
  'subscribe',
] satisfies ProcedureCall[]);

function isProcedureTerminal(prop: string): prop is ProcedureCall {
  return PROCEDURE_TERMINALS.has(prop);
}

function makeProcedurePath(parts: string[]): unknown {
  return new Proxy(() => {}, {
    get(_t, prop) {
      if (typeof prop !== 'string') return undefined;
      if (isProcedureTerminal(prop)) {
        const procedure = parts.join('.');
        return (input?: unknown) => {
          const value = resolveFixture(procedure, input);
          return Promise.resolve(value);
        };
      }
      return makeProcedurePath([...parts, prop]);
    },
  });
}

export const trpc = makeProcedurePath([]) as CreateTRPCProxyClient<AppRouter>;
