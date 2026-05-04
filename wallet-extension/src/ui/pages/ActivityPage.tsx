import { useState, useEffect, useCallback } from 'react';
import { Plus, Globe } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import type { ActivityItem } from '@/background/services/activity';
import type { Balances, Networks } from '@/ui/types';
import { activityTxExplorerHref } from '@/lib/explorer-href';
import { useExplorerPreferences } from '@/lib/use-explorer-preferences';
import { ExplorerValueRow } from '@/ui/components/ExplorerValueRow';
import { EncryptedNoteBadge } from '@/ui/components/EncryptedNoteBadge';
import { NoteEditModal } from '@/ui/components/NoteEditModal';
import { EmptyState, LoadingState } from '@/ui/components/StateViews';
import { HiddenSendBadge } from '@/ui/components/HiddenSendBadge';

const TYPE_ICON: Record<string, string> = {
  sent: '↑',
  received: '↓',
  contract: '⚙',
  unknown: '•',
};

function originHostname(origin: string): string {
  try {
    return new URL(origin).hostname;
  } catch {
    return origin;
  }
}

export function ActivityPage({
  balances,
  advanced,
  networks,
}: {
  balances: Balances | null;
  advanced: boolean;
  networks: Networks | null;
}) {
  const explorerPrefs = useExplorerPreferences();
  const [items, setItems] = useState<ActivityItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [noteEdit, setNoteEdit] = useState<{ txHash: string; label?: string } | null>(null);
  const rawAddr = balances && !balances.locked ? balances.canonicalReceiveAddress : null;
  const address = typeof rawAddr === 'string' && rawAddr.trim() ? rawAddr.trim() : null;

  const refresh = useCallback(() => {
    if (!address) return;
    setItems(null);
    setError(null);
    trpc.getActivity
      .query({ limit: 20 })
      .then(setItems)
      .catch((e) => setError(e instanceof Error ? e.message : 'failed to load activity'));
  }, [address]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  function formatTime(ms: number | null) {
    if (!ms) return '';
    const d = new Date(ms);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  return (
    <div className="sp-page">
      <div className="sp-pageTitle">activity</div>

      {!address && <EmptyState icon="🔒" title="unlock wallet to view activity" />}

      {address && items === null && !error && <LoadingState title="loading activity…" skeleton="rows" count={5} />}

      {error && <div className="sp-error">{error}</div>}

      {items !== null && items.length === 0 && (
        <EmptyState
          icon="📋"
          title="no activity yet"
          description="sui, evm (blockscout explorers), solana, and bitcoin txs merge here"
        />
      )}

      {items?.map((item) => {
        const canAttachNote = item.signedByThisWallet === true;
        const hasNote = item.hasEncryptedNote === true;
        const isHiddenPcTx =
          item.recordKind === 'pc-wrap' ||
          item.recordKind === 'pc-transfer-hidden' ||
          item.recordKind === 'pc-unwrap';
        const pcLabel =
          item.recordKind === 'pc-wrap'
            ? 'wrap → pcUSDC'
            : item.recordKind === 'pc-transfer-hidden'
              ? 'private send · pcUSDC'
              : item.recordKind === 'pc-unwrap'
                ? 'unwrap pcUSDC →'
                : null;
        return (
          <div key={`${item.chain}-${item.digest}`} className={`sp-activityRow sp-activityRow--${item.status}`}>
            <div className="sp-activityIcon">{TYPE_ICON[item.type] ?? '•'}</div>
            <div className="sp-activityInfo">
              <div className="sp-activityLabel">
                <span className="sp-muted" style={{ fontSize: 10, marginRight: 6 }}>
                  {item.chain}
                </span>
                {pcLabel ?? item.label}
                {isHiddenPcTx && <HiddenSendBadge />}
                {hasNote && <EncryptedNoteBadge />}
              </div>
              {item.origin ? (
                <div
                  className="sp-activityOrigin sp-muted"
                  style={{ fontSize: 11, display: 'inline-flex', alignItems: 'center', gap: 4, marginTop: 2 }}
                  title={item.origin}
                >
                  <Globe size={10} />
                  {originHostname(item.origin)}
                </div>
              ) : null}
              <div className="sp-activityMeta">
                {formatTime(item.timestampMs)}
                {advanced ? (
                  <div className="sp-activityDigestRow" style={{ marginTop: 6 }}>
                    <ExplorerValueRow
                      fullValue={item.digest}
                      href={activityTxExplorerHref(explorerPrefs, networks, item.chain, item.digest)}
                      truncateMid={{ head: 8, tail: 6 }}
                      copyLabel="Copy transaction id"
                    />
                  </div>
                ) : null}
              </div>
              {canAttachNote && (
                <div style={{ marginTop: 6 }}>
                  <button
                    type="button"
                    onClick={() => setNoteEdit({ txHash: item.digest, label: item.label })}
                    className="sp-btn sp-btn--ghost"
                    style={{ fontSize: 11, padding: '2px 6px', display: 'inline-flex', alignItems: 'center', gap: 4 }}
                    aria-label={hasNote ? 'view encrypted note' : 'add encrypted note'}
                  >
                    {hasNote ? (
                      <>view note</>
                    ) : (
                      <>
                        <Plus size={10} /> note
                      </>
                    )}
                  </button>
                </div>
              )}
            </div>
            <div className={`sp-activityStatus sp-activityStatus--${item.status}`}>
              {item.status === 'success' ? '✓' : '✗'}
            </div>
          </div>
        );
      })}

      {noteEdit && (
        <NoteEditModal
          txHash={noteEdit.txHash}
          txLabel={noteEdit.label}
          onClose={() => setNoteEdit(null)}
          onChanged={refresh}
        />
      )}
    </div>
  );
}
