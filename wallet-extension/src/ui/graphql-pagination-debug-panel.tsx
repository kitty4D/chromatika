import { useCallback, useEffect, useState } from 'react';
import { trpc } from '@/lib/trpc';

export function GraphqlPaginationDebugPanel() {
  const [snap, setSnap] = useState<Awaited<ReturnType<typeof trpc.graphqlPaginationDebugSnapshot.query>> | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showEvents, setShowEvents] = useState(false);

  const refresh = useCallback(async () => {
    setErr(null);
    try {
      const s = await trpc.graphqlPaginationDebugSnapshot.query();
      setSnap(s);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), 2000);
    return () => window.clearInterval(id);
  }, [refresh]);

  async function onReset() {
    setBusy(true);
    setErr(null);
    try {
      await trpc.graphqlPaginationDebugReset.mutate();
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const parentRows = snap ? Object.entries(snap.parents) : [];
  const cycleAny = parentRows.some(([, p]) => p.cycleDetected);

  return (
    <div className="sp-section sp-advancedSection" style={{ marginTop: 12 }}>
      <div className="sp-sectionTitle">graphql pagination debug</div>
      <p className="sp-muted" style={{ fontSize: 11, lineHeight: 1.45, margin: '0 0 10px' }}>
        records <code style={{ fontSize: 10 }}>getDynamicFields</code> when{' '}
        <code style={{ fontSize: 10 }}>VITE_DEBUG_GRAPHQL</code>,{' '}
        <code style={{ fontSize: 10 }}>VITE_DEBUG_GRAPHQL_PAGINATION</code>, or dev build is on. unlock
        wallet + reload extension after changing <code style={{ fontSize: 10 }}>.env</code>.
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
        <button type="button" className="sp-btn" disabled={busy} onClick={() => void refresh()}>
          refresh now
        </button>
        <button type="button" className="sp-btn" disabled={busy} onClick={() => void onReset()}>
          reset capture
        </button>
        <button type="button" className="sp-btn" onClick={() => setShowEvents((v) => !v)}>
          {showEvents ? 'hide' : 'show'} recent events
        </button>
      </div>
      {err && <div className="sp-error" style={{ marginBottom: 8 }}>{err}</div>}
      {cycleAny && (
        <div
          style={{
            fontSize: 12,
            padding: '8px 10px',
            borderRadius: 10,
            marginBottom: 10,
            background: 'rgba(239, 68, 68, 0.15)',
            border: '1px solid rgba(248, 113, 113, 0.45)',
            color: 'rgba(254, 226, 226, 0.95)',
          }}
        >
          duplicate <code>endCursor</code> seen for at least one parent — pagination may be cycling (bug or
          stuck indexer).
        </div>
      )}
      {parentRows.length === 0 ? (
        <div className="sp-muted" style={{ fontSize: 12 }}>
          no <code>getDynamicFields</code> captured yet. trigger DKG or enable debug fetch + reload background.
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', fontSize: 10, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'rgba(234,240,255,0.55)' }}>
                <th style={{ padding: '4px 6px' }}>parent</th>
                <th style={{ padding: '4px 6px' }}>pages</th>
                <th style={{ padding: '4px 6px' }}>uniq cursors</th>
                <th style={{ padding: '4px 6px' }}>last #nodes</th>
                <th style={{ padding: '4px 6px' }}>hasNext</th>
                <th style={{ padding: '4px 6px' }}>cycle?</th>
              </tr>
            </thead>
            <tbody>
              {parentRows.map(([id, p]) => (
                <tr key={id} style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                  <td style={{ padding: '6px', wordBreak: 'break-all', fontFamily: 'ui-monospace, monospace' }}>
                    {id.slice(0, 10)}…{id.slice(-6)}
                  </td>
                  <td style={{ padding: '6px' }}>{p.pages}</td>
                  <td style={{ padding: '6px' }}>{p.uniqueEndCursors}</td>
                  <td style={{ padding: '6px' }}>{p.lastNodesLen}</td>
                  <td style={{ padding: '6px' }}>{p.lastHasNextPage ? 'yes' : 'no'}</td>
                  <td style={{ padding: '6px', color: p.cycleDetected ? '#fca5a5' : 'inherit' }}>
                    {p.cycleDetected ? 'yes' : 'no'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {showEvents && snap && snap.eventsNewestFirst.length > 0 && (
        <pre
          style={{
            marginTop: 12,
            fontSize: 9,
            lineHeight: 1.35,
            maxHeight: 220,
            overflow: 'auto',
            padding: 8,
            borderRadius: 8,
            background: 'rgba(0,0,0,0.28)',
            border: '1px solid rgba(255,255,255,0.08)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
          }}
        >
          {snap.eventsNewestFirst
            .map(
              (e) =>
                `${new Date(e.ts).toISOString().slice(11, 23)} ${e.label} parent=${e.parentId.slice(0, 8)}… ` +
                `nodes=${e.nodesLen} hasNext=${e.hasNextPage} dupEnd=${e.duplicateEndCursor} cycle=${e.cycleDetected} ` +
                `req=${e.reqCursorTail} end=${e.endCursorTail}`,
            )
            .join('\n')}
        </pre>
      )}
    </div>
  );
}
