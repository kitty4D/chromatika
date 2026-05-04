import { useState, useEffect } from 'react';
import { trpc } from '@/lib/trpc';
import { EmptyState, LoadingState } from '@/ui/components/StateViews';

export function DAppsPage({ onBack }: { onBack: () => void }) {
  const [perms, setPerms] = useState<Awaited<ReturnType<typeof trpc.getDappPermissions.query>> | null>(null);
  const [debugItems, setDebugItems] = useState<Awaited<ReturnType<typeof trpc.dappBridgeDebug.query>>>([]);
  const [revoking, setRevoking] = useState<string | null>(null);

  useEffect(() => {
    trpc.getDappPermissions.query().then(setPerms).catch(() => setPerms({}));
    trpc.dappBridgeDebug.query().then(setDebugItems).catch(() => setDebugItems([]));
  }, []);

  async function revoke(origin: string) {
    setRevoking(origin);
    try {
      await trpc.revokeDappPermission.mutate({ origin });
      setPerms((p) => {
        const n = { ...p };
        delete n[origin];
        return n;
      });
    } finally {
      setRevoking(null);
    }
  }

  const entries = Object.entries(perms ?? {}).sort((a, b) => b[1].grantedAt - a[1].grantedAt);

  return (
    <div className="sp-page">
      <div className="sp-pageHeader">
        <button type="button" className="sp-backBtn" onClick={onBack}>
          ← back
        </button>
        <div className="sp-pageTitle" style={{ marginBottom: 0 }}>
          connected dapps
        </div>
      </div>

      {perms === null && (
        <LoadingState title="loading sites…" skeleton="rows" count={3} />
      )}

      {perms !== null && entries.length === 0 && (
        <EmptyState
          icon="🔌"
          title="no connected sites"
          description="sites you approve will appear here"
        />
      )}

      {entries.map(([origin, rec]) => (
        <div key={origin} className="sp-dappRow">
          <div className="sp-dappInfo">
            <div className="sp-dappOrigin">{origin}</div>
            <div className="sp-dappDate">{new Date(rec.grantedAt).toLocaleDateString()}</div>
            <div className="sp-muted" style={{ fontSize: 11 }}>
              scopes: {rec.scope.accounts ? 'accounts' : 'none'}
              {rec.scope.canSendTransaction ? ', sendTx' : ''}
              {rec.scope.canSignPersonal ? ', personal_sign' : ''}
              {rec.scope.canSignTypedData ? ', typedData' : ''}
              {rec.scope.chainIds.length ? `, chains=${rec.scope.chainIds.join(',')}` : ', chains=all'}
            </div>
          </div>
          <button type="button" className="sp-revokeBtn" disabled={revoking === origin} onClick={() => revoke(origin)}>
            {revoking === origin ? '…' : 'revoke'}
          </button>
        </div>
      ))}

      {debugItems.some((x) => x.solanaEncryptProgram) && (
        <div className="sp-section" style={{ marginTop: 14 }}>
          <div className="sp-sectionTitle">recent Encrypt-tagged Solana bridge calls</div>
          {debugItems
            .filter((x) => x.solanaEncryptProgram)
            .slice(-12)
            .reverse()
            .map((x, i) => (
              <div key={`enc-${x.at}-${i}`} className="sp-muted" style={{ fontSize: 11, marginTop: 6 }}>
                {new Date(x.at).toLocaleTimeString()} - {x.origin} - {x.method} - {x.ok ? 'ok' : 'fail'} -{' '}
                {x.reason ?? '—'}
              </div>
            ))}
        </div>
      )}

      {debugItems.length > 0 && (
        <div className="sp-section" style={{ marginTop: 14 }}>
          <div className="sp-sectionTitle">recent bridge errors</div>
          {debugItems
            .filter((x) => !x.ok)
            .slice(0, 5)
            .map((x, i) => (
              <div key={`${x.at}-${i}`} className="sp-muted" style={{ fontSize: 11, marginTop: 6 }}>
                {new Date(x.at).toLocaleTimeString()} - {x.origin} - {x.method} - {x.reason ?? 'unknown'}
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
