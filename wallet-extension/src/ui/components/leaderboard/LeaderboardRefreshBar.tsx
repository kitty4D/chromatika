/**
 * top bar for the dWallet leaderboard page. shows index freshness + the
 * three actions a user can take: refresh now, paste an id, disable the feature.
 */

import { Loader2, Plus, Power, RefreshCw } from 'lucide-react';

function formatAgo(ms: number | null): string {
  if (!ms || ms <= 0) return 'never';
  const delta = Date.now() - ms;
  if (delta < 60_000) return `${Math.max(1, Math.floor(delta / 1000))}s ago`;
  if (delta < 60 * 60_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 24 * 60 * 60_000) return `${Math.floor(delta / (60 * 60_000))}h ago`;
  return `${Math.floor(delta / (24 * 60 * 60_000))}d ago`;
}

export function LeaderboardRefreshBar({
  total,
  indexUpdatedAtMs,
  lastFullScanMs,
  refreshing,
  onRefresh,
  onAddManual,
  onDisable,
}: {
  total: number;
  indexUpdatedAtMs: number;
  lastFullScanMs: number | null;
  refreshing: boolean;
  onRefresh: () => void;
  onAddManual: () => void;
  onDisable: () => void;
}) {
  return (
    <div
      className="ch-leaderboardRefreshBar"
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 8,
        margin: '8px 0 10px 0',
        padding: '8px 10px',
        borderRadius: 10,
        background: 'rgba(234,240,255,0.04)',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', flex: '1 1 auto', minWidth: 140 }}>
        <span style={{ fontSize: 12, fontWeight: 600 }}>{total} dWallets observed</span>
        <span className="sp-muted" style={{ fontSize: 10 }}>
          last scan {formatAgo(indexUpdatedAtMs || null)}
          {lastFullScanMs ? ` · full ${formatAgo(lastFullScanMs)}` : ''}
        </span>
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button
          type="button"
          className="sp-btn"
          onClick={onAddManual}
          title="paste a dWallet object id to track"
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <Plus size={12} /> add id
          </span>
        </button>
        <button
          type="button"
          className="sp-btn sp-btnPrimary"
          onClick={onRefresh}
          disabled={refreshing}
          aria-busy={refreshing}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            {refreshing ? <Loader2 size={12} className="ch-spin" /> : <RefreshCw size={12} />}
            {refreshing ? 'refreshing' : 'refresh'}
          </span>
        </button>
        <button
          type="button"
          className="sp-btn"
          onClick={onDisable}
          title="turn off the leaderboard (also pauses background refresh)"
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <Power size={12} /> off
          </span>
        </button>
      </div>
    </div>
  );
}
