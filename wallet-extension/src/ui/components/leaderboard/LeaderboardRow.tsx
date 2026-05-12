/**
 * one row on the dWallet leaderboard. shows rank, truncated id with explorer +
 * copy affordances (per CLAUDE.md "wallet ui - explorer links and copy" rule),
 * USD total, freshness chip, and an expandable per-chain breakdown.
 */

import { useCallback, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, Loader2, RefreshCw, X } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { ExplorerValueRow } from '@/ui/components/ExplorerValueRow';
import { useExplorerPreferences } from '@/lib/use-explorer-preferences';
import { dwalletObjectExplorerHref } from '@/lib/explorer-href';
import type { LeaderboardEntry, LeaderboardPortfolio } from '@/lib/use-leaderboard';

function microsToUsdDisplay(microsStr: string): string {
  let micros: bigint;
  try {
    micros = BigInt(microsStr);
  } catch {
    return '—';
  }
  // 1 USD = 1_000_000 micros. show 2 decimals, with thousands separators.
  const negative = micros < 0n;
  const abs = negative ? -micros : micros;
  const whole = abs / 1_000_000n;
  const frac = abs % 1_000_000n;
  const wholeStr = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const cents = Math.floor(Number(frac) / 10_000).toString().padStart(2, '0');
  return `${negative ? '-' : ''}$${wholeStr}.${cents}`;
}

function formatAgo(ms: number | null): string {
  if (!ms) return 'never';
  const delta = Date.now() - ms;
  if (delta < 60_000) return `${Math.max(1, Math.floor(delta / 1000))}s ago`;
  if (delta < 60 * 60_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 24 * 60 * 60_000) return `${Math.floor(delta / (60 * 60_000))}h ago`;
  return `${Math.floor(delta / (24 * 60 * 60_000))}d ago`;
}

export function LeaderboardRow({
  row,
  rank,
  onRefreshed,
}: {
  row: LeaderboardEntry;
  rank: number;
  onRefreshed: () => Promise<void> | void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState<LeaderboardPortfolio | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [rowBusy, setRowBusy] = useState(false);
  const explorerPrefs = useExplorerPreferences();

  const href = dwalletObjectExplorerHref(explorerPrefs, null, row.dwalletId);

  const onToggle = useCallback(async () => {
    setExpanded((e) => !e);
    if (!expanded && !detail) {
      setLoadingDetail(true);
      try {
        const got = (await trpc.leaderboardGetPortfolio.query({ dwalletId: row.dwalletId })) as LeaderboardPortfolio | null;
        setDetail(got);
      } catch {
        /* leave detail null; user can hit refresh row */
      } finally {
        setLoadingDetail(false);
      }
    }
  }, [expanded, detail, row.dwalletId]);

  const onRefreshRow = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (rowBusy) return;
    setRowBusy(true);
    try {
      const got = (await trpc.leaderboardForceRefreshPortfolio.mutate({ dwalletId: row.dwalletId })) as LeaderboardPortfolio;
      setDetail(got);
      await onRefreshed();
    } catch {
      /* surfaced via the page-level error banner via next list query */
    } finally {
      setRowBusy(false);
    }
  }, [rowBusy, row.dwalletId, onRefreshed]);

  const onRemove = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (rowBusy) return;
    setRowBusy(true);
    try {
      await trpc.leaderboardRemoveManualId.mutate({ dwalletId: row.dwalletId });
      await onRefreshed();
    } finally {
      setRowBusy(false);
    }
  }, [rowBusy, row.dwalletId, onRefreshed]);

  return (
    <div
      role="row"
      className="ch-leaderboardRow"
      style={{
        display: 'flex',
        flexDirection: 'column',
        padding: '6px 8px',
        borderRadius: 10,
        background: 'rgba(234,240,255,0.04)',
      }}
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '40px 1fr 80px 120px 40px',
          gap: 8,
          alignItems: 'center',
        }}
      >
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={expanded ? 'collapse row' : 'expand row'}
          onClick={() => void onToggle()}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: 4,
            background: 'transparent',
            border: 0,
            cursor: 'pointer',
            color: 'inherit',
            fontVariantNumeric: 'tabular-nums',
            fontSize: 12,
            padding: 0,
          }}
        >
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <span>{rank}</span>
        </button>
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <ExplorerValueRow
            fullValue={row.dwalletId}
            href={href}
            truncateMid={{ head: 6, tail: 4 }}
            copyLabel="copy dWallet object id"
          />
          <span className="sp-muted" style={{ fontSize: 10 }}>
            {row.curve === 'unknown' ? 'curve unknown' : row.curve.toLowerCase()}
            {row.stateKind && row.stateKind !== 'Active' && row.stateKind !== 'unknown' ? ` · ${row.stateKind}` : ''}
            {row.partial && (
              <span style={{ marginLeft: 6, display: 'inline-flex', alignItems: 'center', gap: 2, color: 'rgba(255,196,86,0.95)' }}>
                <AlertTriangle size={10} /> partial
              </span>
            )}
          </span>
        </div>
        <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontSize: 12 }}>
          {row.hasPortfolio ? microsToUsdDisplay(row.usdMicros) : '—'}
        </span>
        <span className="sp-muted" style={{ textAlign: 'right', fontSize: 10 }}>
          {formatAgo(row.lastFetchedMs)}
        </span>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 2 }}>
          <button
            type="button"
            className="ch-copyIconBtn ch-copyIconBtn--12"
            onClick={(e) => void onRefreshRow(e)}
            aria-label="refresh this dWallet"
            title="refresh this dWallet"
            disabled={rowBusy}
          >
            {rowBusy ? <Loader2 size={12} className="ch-spin" /> : <RefreshCw size={12} />}
          </button>
          <button
            type="button"
            className="ch-copyIconBtn ch-copyIconBtn--12"
            onClick={(e) => void onRemove(e)}
            aria-label="hide from leaderboard"
            title="hide from leaderboard"
            disabled={rowBusy}
          >
            <X size={12} />
          </button>
        </div>
      </div>
      {expanded && (
        <div style={{ marginTop: 8, paddingTop: 6, borderTop: '1px solid rgba(234,240,255,0.06)', fontSize: 11 }}>
          {loadingDetail ? (
            <span className="sp-muted">loading per-chain breakdown…</span>
          ) : detail ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {detail.perChain
                .filter((p) => p.chainKey !== '_orchestrator')
                .map((p) => (
                  <div
                    key={p.chainKey}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '1fr 90px 1fr',
                      gap: 6,
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    <span>{p.chainKey}</span>
                    <span style={{ textAlign: 'right' }}>{microsToUsdDisplay(p.usdMicros)}</span>
                    <span className="sp-muted" style={{ fontSize: 10 }}>
                      {p.ok ? 'ok' : `failed${p.reason ? `: ${p.reason}` : ''}`}
                    </span>
                  </div>
                ))}
              <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 2 }}>
                {detail.addresses.evm && <small className="sp-muted">evm: <span className="mono">{detail.addresses.evm}</span></small>}
                {detail.addresses.sui && <small className="sp-muted">sui: <span className="mono">{detail.addresses.sui}</span></small>}
                {detail.addresses.solana && <small className="sp-muted">sol: <span className="mono">{detail.addresses.solana}</span></small>}
                {detail.addresses.btcP2wpkh && <small className="sp-muted">btc p2wpkh: <span className="mono">{detail.addresses.btcP2wpkh}</span></small>}
                {detail.addresses.btcP2tr && <small className="sp-muted">btc p2tr: <span className="mono">{detail.addresses.btcP2tr}</span></small>}
                {detail.addresses.aptos && <small className="sp-muted">apt: <span className="mono">{detail.addresses.aptos}</span></small>}
                {detail.addresses.deso && <small className="sp-muted">deso: <span className="mono">{detail.addresses.deso}</span></small>}
              </div>
            </div>
          ) : (
            <span className="sp-muted">no per-chain data yet. hit the row refresh button.</span>
          )}
        </div>
      )}
    </div>
  );
}
