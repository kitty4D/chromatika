/**
 * "Index history" panel for the Activity page. Renders a list of every vault wallet
 * (vault keypair + fee-payer + every dWallet's chain addresses) with its coverage
 * status and a Start / Resume / Cancel affordance per row.
 *
 * UX shape:
 *   - hidden behind a single "Index history" button on the page header; expands inline
 *     so users who don't care don't see the noise.
 *   - per-row chip with the chain + truncated address + coverage badge + row count.
 *   - the start/resume action is one click. cancel is exposed only when a job is
 *     running for that row. progress lives in the global `OperationProgressBanner`
 *     mounted in `MainWalletShell`; we don't duplicate it here.
 *   - explicit copy disambiguating `'complete-to-retention'` vs `'complete-to-genesis'`
 *     so users understand the tier-aware first-time-recipient claim downstream.
 *
 * polling: re-fetches `listVaultIndexTargets` every 4s while expanded so coverage row
 * counts + isRunning flags update live without manual refresh. The poll stops when
 * collapsed.
 */

import { useCallback, useEffect, useState } from 'react';
import { Database, ChevronDown, ChevronUp, Play, Square, RefreshCw } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import type { CoverageStatus } from '@/background/services/activity-index';

type Targets = Awaited<ReturnType<typeof trpc.listVaultIndexTargets.query>>;
type Target = Targets['targets'][number];

const COVERAGE_BADGE: Record<CoverageStatus, { label: string; bg: string; fg: string; border: string }> = {
  never: {
    label: 'not indexed',
    bg: 'rgba(255,255,255,0.04)',
    fg: 'rgba(255,255,255,0.6)',
    border: 'rgba(255,255,255,0.12)',
  },
  partial: {
    label: 'partial',
    bg: 'rgba(251, 191, 36, 0.10)',
    fg: '#fde68a',
    border: 'rgba(251, 191, 36, 0.40)',
  },
  'complete-to-retention': {
    label: 'complete (provider retention)',
    bg: 'rgba(96, 165, 250, 0.10)',
    fg: '#93c5fd',
    border: 'rgba(96, 165, 250, 0.40)',
  },
  'complete-to-genesis': {
    label: 'complete (full chain history)',
    bg: 'rgba(46, 160, 67, 0.10)',
    fg: '#86efac',
    border: 'rgba(46, 160, 67, 0.40)',
  },
};

function shortAddr(a: string): string {
  if (a.length <= 14) return a;
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function formatLastSynced(ms: number | null): string {
  if (!ms) return 'never synced';
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'synced just now';
  if (diff < 3_600_000) return `synced ${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `synced ${Math.floor(diff / 3_600_000)}h ago`;
  return `synced ${Math.floor(diff / 86_400_000)}d ago`;
}

export function IndexHistoryPanel() {
  const [expanded, setExpanded] = useState(false);
  const [targets, setTargets] = useState<Target[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    trpc.listVaultIndexTargets
      .query()
      .then((r) => {
        setTargets(r.targets);
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    if (!expanded) return;
    refresh();
    const t = window.setInterval(refresh, 4000);
    return () => window.clearInterval(t);
  }, [expanded, refresh]);

  async function startIndex(t: Target) {
    setBusy(true);
    try {
      await trpc.startActivityIndex.mutate({
        chain: t.chain,
        address: t.address,
        chainId: t.chainId,
      });
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function cancelIndex(t: Target) {
    setBusy(true);
    try {
      await trpc.cancelActivityIndex.mutate({
        chain: t.chain,
        address: t.address,
      });
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sp-section" style={{ marginTop: 12 }}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="sp-btn"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          width: '100%',
          justifyContent: 'space-between',
        }}
        aria-expanded={expanded}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Database size={14} aria-hidden />
          Index history
        </span>
        {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>

      {expanded && (
        <div style={{ marginTop: 8 }}>
          <div className="sp-muted" style={{ fontSize: 11, lineHeight: 1.45, marginBottom: 8 }}>
            Index any of this vault's wallets so Chromatika can serve as your personal
            on-chain history archive. Indexed history powers a stronger "first time
            sending here" check on the Send screen. Per chain:
            <ul style={{ paddingLeft: 16, margin: '4px 0 0' }}>
              <li><strong>Sui / EVM / BTC</strong>: indexers paginate to genesis.</li>
              <li>
                <strong>Solana</strong>: free / public RPCs only retain ~6 days. We mark
                Solana coverage as "complete to provider retention" - older history isn't
                accessible without a paid archival provider.
              </li>
            </ul>
          </div>

          {error && (
            <div className="sp-error" style={{ fontSize: 11, marginBottom: 8 }}>
              {error}
            </div>
          )}

          {targets === null ? (
            <div className="sp-muted" style={{ fontSize: 11 }}>loading wallets…</div>
          ) : targets.length === 0 ? (
            <div className="sp-muted" style={{ fontSize: 11 }}>
              no addresses to index. create a dWallet first.
            </div>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {targets.map((t) => {
                const badge = COVERAGE_BADGE[t.coverage.status];
                return (
                  <li
                    key={`${t.chain}:${t.address}`}
                    style={{
                      padding: '8px 10px',
                      borderRadius: 6,
                      background: 'rgba(255,255,255,0.04)',
                      border: '1px solid rgba(255,255,255,0.08)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 4,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 12, fontWeight: 600 }}>{t.label}</span>
                      <span className="sp-muted" style={{ fontSize: 10, fontFamily: 'ui-monospace, monospace' }}>
                        {shortAddr(t.address)}
                      </span>
                      <span
                        style={{
                          fontSize: 10,
                          padding: '1px 6px',
                          borderRadius: 999,
                          background: badge.bg,
                          color: badge.fg,
                          border: `1px solid ${badge.border}`,
                          marginLeft: 'auto',
                        }}
                      >
                        {badge.label}
                      </span>
                    </div>
                    <div className="sp-muted" style={{ fontSize: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <span>{t.rowCount.toLocaleString()} indexed</span>
                      <span>{formatLastSynced(t.coverage.lastSyncedAtMs)}</span>
                      {t.coverage.lastError && (
                        <span style={{ color: 'oklch(0.72 0.18 25)' }}>
                          error: {t.coverage.lastError}
                        </span>
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: 4 }}>
                      {!t.indexingSupported ? (
                        <span className="sp-muted" style={{ fontSize: 10 }}>
                          {t.chain === 'evm'
                            ? 'EVM indexing requires VITE_ALCHEMY_KEY at build time.'
                            : t.chain === 'aptos'
                              ? 'Aptos indexing not implemented in this build.'
                              : `indexing not available for ${t.chain}`}
                        </span>
                      ) : t.isRunning ? (
                        <button
                          type="button"
                          className="sp-btn sp-btn--xs"
                          onClick={() => void cancelIndex(t)}
                          disabled={busy}
                          style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                        >
                          <Square size={10} /> cancel
                        </button>
                      ) : t.coverage.status === 'partial' ? (
                        <button
                          type="button"
                          className="sp-btn sp-btn--xs sp-btnPrimary"
                          onClick={() => void startIndex(t)}
                          disabled={busy}
                          style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                        >
                          <Play size={10} /> resume
                        </button>
                      ) : t.coverage.status === 'never' ? (
                        <button
                          type="button"
                          className="sp-btn sp-btn--xs sp-btnPrimary"
                          onClick={() => void startIndex(t)}
                          disabled={busy}
                          style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                        >
                          <Play size={10} /> start indexing
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="sp-btn sp-btn--xs"
                          onClick={() => void startIndex(t)}
                          disabled={busy}
                          title="Re-fetch from the newest position for incremental updates"
                          style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                        >
                          <RefreshCw size={10} /> refresh
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
