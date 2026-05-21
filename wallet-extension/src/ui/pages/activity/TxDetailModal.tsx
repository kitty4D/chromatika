/**
 * Modal showing one transaction's full detail. Opened by clicking any activity row.
 *
 * Phase 2 scope: the modal renders the data the activity feed already has + an optional
 * deep-fetch via `getTxDetail` for fee + block-height + confirmations. We don't yet do
 * reverse name resolution (counterparty -> ENS / SuiNS); that's a follow-up.
 */

import { useEffect, useState } from 'react';
import { X, Globe, Share2 } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import type { ActivityItem } from '@/background/services/activity';
import type { Networks } from '@/ui/types';
import { ExplorerValueRow } from '@/ui/components/ExplorerValueRow';
import { activityTxExplorerHref } from '@/lib/explorer-href';
import { useExplorerPreferences } from '@/lib/use-explorer-preferences';

type Detail = Awaited<ReturnType<typeof trpc.getTxDetail.query>>;

function formatAbsoluteTime(ms: number | null): string {
  if (!ms) return '';
  const d = new Date(ms);
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function shortAddr(s: string | null): string {
  if (!s) return '—';
  if (s.length <= 14) return s;
  return `${s.slice(0, 8)}…${s.slice(-6)}`;
}

export function TxDetailModal({
  item,
  networks,
  onClose,
}: {
  item: ActivityItem;
  networks: Networks | null;
  onClose: () => void;
}) {
  const explorerPrefs = useExplorerPreferences();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  /** reverse-resolved name for the counterparty (when one exists). populated by a
   * separate effect that fires once the `detail.toAddress` is known - we don't want to
   * eagerly reverse-resolve on every row in the feed; the modal click is when the user
   * has shown interest in a specific row. */
  const [reverseName, setReverseName] = useState<{ name: string; source: string } | null>(null);
  /** for Solana rows that the walker left as `kind: 'unknown'`, the modal triggers a
   * deferred reclassify on open. when it succeeds, this state holds the new kind so
   * the modal header re-renders without waiting for the next activity-feed refresh. */
  const [reclassifiedKind, setReclassifiedKind] = useState<string | null>(null);

  useEffect(() => {
    // on-click Solana reclassify (#9). only fire when:
    //  - chain is Solana
    //  - the existing kind is unknown / missing (already-classified rows skip)
    if (item.chain !== 'solana') return;
    if (item.kind && item.kind !== 'unknown') return;
    let cancelled = false;
    trpc.reclassifySolanaTx
      .mutate({ digest: item.digest })
      .then((r) => {
        if (cancelled) return;
        if (r.reclassified && r.kind && r.kind !== 'unknown') {
          setReclassifiedKind(r.kind);
        }
      })
      .catch(() => {
        /* silent - reclassify is best-effort */
      });
    return () => {
      cancelled = true;
    };
  }, [item.chain, item.digest, item.kind]);

  useEffect(() => {
    let cancelled = false;
    setLoadingDetail(true);
    setDetailError(null);
    trpc.getTxDetail
      .query({ chain: item.chain, digest: item.digest, chainId: item.chainId })
      .then((d) => {
        if (cancelled) return;
        setDetail(d);
        // once we have the recipient address, fire a reverse-name lookup for the chain
        // (ENS / SuiNS / SNS / Aptos Names). best-effort; null result hides the pill.
        if (d?.toAddress) {
          const resolverChain: 'sui' | 'evm' | 'sol' | 'apt' | null =
            item.chain === 'sui'
              ? 'sui'
              : item.chain === 'evm'
                ? 'evm'
                : item.chain === 'solana'
                  ? 'sol'
                  : null;
          if (resolverChain) {
            trpc.reverseLookupName
              .query({ address: d.toAddress, chain: resolverChain })
              .then((r) => {
                if (cancelled) return;
                if (r.name && r.source) setReverseName({ name: r.name, source: r.source });
              })
              .catch(() => {
                /* silent - reverse-name pill is purely additive */
              });
          }
        }
      })
      .catch((e) => {
        // detail enrichment is best-effort - the row's headline info is already shown.
        if (!cancelled) setDetailError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoadingDetail(false);
      });
    return () => {
      cancelled = true;
    };
  }, [item.chain, item.digest, item.chainId]);

  const explorerHref = activityTxExplorerHref(explorerPrefs, networks, item.chain, item.digest);

  function shareTx() {
    if (typeof navigator === 'undefined') return;
    const url = explorerHref ?? '';
    const text = `${item.label} on ${item.chain}: ${item.digest}${url ? `\n${url}` : ''}`;
    const navAny = navigator as unknown as { share?: (data: ShareData) => Promise<void> };
    if (navAny.share) {
      void navAny.share({ title: 'Chromatika tx', text, url }).catch(() => {});
    } else if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(text);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Transaction detail"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: 'rgba(0, 0, 0, 0.7)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          background: 'var(--sp-bg, #14141c)',
          color: 'var(--theme-page-text, white)',
          borderRadius: 12,
          padding: 14,
          maxWidth: 440,
          width: '100%',
          maxHeight: '85vh',
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <strong style={{ fontSize: 13, flex: 1 }}>
            {reclassifiedKind ??
              (item.kind && item.kind !== 'unknown' ? item.kind : item.label)}
          </strong>
          <span
            className="sp-muted"
            style={{
              fontSize: 10,
              padding: '2px 8px',
              borderRadius: 999,
              background:
                item.status === 'pending'
                  ? 'rgba(251, 191, 36, 0.15)'
                  : item.status === 'failure'
                    ? 'rgba(248, 113, 113, 0.15)'
                    : 'rgba(46, 160, 67, 0.15)',
              color:
                item.status === 'pending'
                  ? '#fde68a'
                  : item.status === 'failure'
                    ? '#fca5a5'
                    : '#86efac',
              border: `1px solid currentColor`,
            }}
          >
            {item.status}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              background: 'transparent',
              border: 'none',
              color: 'inherit',
              cursor: 'pointer',
              padding: 4,
            }}
          >
            <X size={16} />
          </button>
        </div>

        {item.kind === 'swap' && item.swapMeta && (
          <div className="sp-section" style={{ background: 'rgba(255,255,255,0.04)' }}>
            <div className="sp-muted" style={{ fontSize: 10, marginBottom: 4 }}>amounts</div>
            <div style={{ fontSize: 13 }}>
              <strong>{item.swapMeta.fromAmountRaw ?? '?'}</strong> {item.swapMeta.fromSymbol ?? '?'} ↔{' '}
              <strong>{item.swapMeta.toAmountRaw ?? '?'}</strong> {item.swapMeta.toSymbol ?? '?'}
            </div>
          </div>
        )}

        <DetailRow label="date" value={formatAbsoluteTime(item.timestampMs)} />
        <DetailRow label="network" value={item.chain} />
        <DetailRow label="from" value={shortAddr(item.fromAddress)} mono />
        {detail?.toAddress && (
          <DetailRow
            label="to"
            value={
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <span style={{ fontFamily: 'ui-monospace, monospace', wordBreak: 'break-all' }}>
                  {shortAddr(detail.toAddress)}
                </span>
                {reverseName && (
                  <span
                    title={`Reverse-resolved via ${reverseName.source.toUpperCase()}`}
                    style={{
                      fontSize: 10,
                      padding: '1px 6px',
                      borderRadius: 999,
                      background: 'rgba(46, 160, 67, 0.10)',
                      color: '#86efac',
                      border: '1px solid rgba(46, 160, 67, 0.40)',
                    }}
                  >
                    ✓ {reverseName.name}
                  </span>
                )}
              </span>
            }
          />
        )}
        {detail?.feeFormatted && (
          <DetailRow
            label="fee"
            value={`${detail.feeFormatted}${detail.feeUsd != null ? ` (~$${detail.feeUsd.toFixed(4)})` : ''}`}
          />
        )}
        {detail?.blockHeight != null && (
          <DetailRow label="block" value={String(detail.blockHeight)} mono />
        )}
        {detail?.confirmations != null && (
          <DetailRow label="confirmations" value={String(detail.confirmations)} />
        )}
        {item.memo && <DetailRow label="memo" value={item.memo} />}
        {item.origin && (
          <DetailRow
            label="origin"
            value={
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <Globe size={11} /> {(() => {
                  try {
                    return new URL(item.origin).hostname;
                  } catch {
                    return item.origin;
                  }
                })()}
              </span>
            }
          />
        )}
        <div className="sp-section">
          <div className="sp-muted" style={{ fontSize: 10, marginBottom: 2 }}>transaction id</div>
          <ExplorerValueRow
            fullValue={item.digest}
            href={explorerHref}
            truncateMid={{ head: 10, tail: 8 }}
            copyLabel="Copy transaction id"
          />
        </div>

        {loadingDetail && (
          <div className="sp-muted" style={{ fontSize: 11 }}>loading chain detail…</div>
        )}
        {detailError && (
          <div className="sp-muted" style={{ fontSize: 11, color: 'oklch(0.72 0.18 25)' }}>
            chain detail unavailable: {detailError}
          </div>
        )}

        <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
          <button
            type="button"
            className="sp-btn sp-btn--xs"
            onClick={shareTx}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
          >
            <Share2 size={11} /> share
          </button>
          {explorerHref && (
            <a
              href={explorerHref}
              target="_blank"
              rel="noreferrer noopener"
              className="sp-btn sp-btn--xs"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4, textDecoration: 'none' }}
            >
              view on explorer
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

function DetailRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="sp-section" style={{ paddingBottom: 4 }}>
      <div className="sp-muted" style={{ fontSize: 10, marginBottom: 2 }}>{label}</div>
      <div
        style={{
          fontSize: 12,
          fontFamily: mono ? 'ui-monospace, monospace' : undefined,
          wordBreak: mono ? 'break-all' : undefined,
        }}
      >
        {value}
      </div>
    </div>
  );
}
