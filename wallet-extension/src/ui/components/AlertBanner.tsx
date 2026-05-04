/**
 * persistent safety-alert banner. mounted in `MainWalletShell` between the dWallet context bar
 * and the main content track, so it's visible across every tab without obstructing nav. shows
 * the highest-severity active alert; users can expand for body, dismiss, or click "view all"
 * to reach the history page.
 *
 * visual design:
 *   - critical -> red background, AlertTriangle icon, mandatory chrome.notification mirror
 *   - warning -> yellow background, AlertCircle icon
 *   - info -> blue tinted strip, Bell icon (lower-emphasis)
 *
 * mute behavior: if `settings.muted` is true the banner stays hidden (history page still shows
 * everything). critical-severity dNR phishing rules persist regardless of mute, mute is "stop
 * yelling at me", not "ignore the threats".
 */

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, AlertCircle, Bell, ChevronDown, ChevronUp, X } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import type { SignedAlertV1 } from '@/background/alerts/alerts-types';

type AlertsListResponse = Awaited<ReturnType<typeof trpc.listAlerts.query>>;

const POLL_REFRESH_MS = 30_000;

function severityStyles(s: SignedAlertV1['severity']): { bg: string; fg: string; icon: typeof AlertTriangle } {
  if (s === 'critical') {
    return { bg: 'var(--theme-banner-error-bg)', fg: 'var(--theme-banner-error-fg)', icon: AlertTriangle };
  }
  if (s === 'warning') {
    return { bg: 'var(--theme-banner-warn-bg)', fg: 'var(--theme-banner-warn-fg)', icon: AlertCircle };
  }
  return { bg: 'var(--theme-banner-info-bg)', fg: 'var(--theme-banner-info-fg)', icon: Bell };
}

function relTime(ms: number): string {
  const delta = Date.now() - ms;
  if (delta < 60_000) return 'just now';
  const m = Math.floor(delta / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function AlertBanner({ onOpenHistory }: { onOpenHistory?: () => void }) {
  const [data, setData] = useState<AlertsListResponse | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await trpc.listAlerts.query();
      setData(res);
    } catch (e) {
      // don't render an error here - the banner is supposed to be unobtrusive when alerts are
      // healthy. surface backend errors in the settings page instead.
      console.warn('[chromatika alerts] listAlerts failed:', e);
      setData(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = window.setInterval(() => void refresh(), POLL_REFRESH_MS);
    return () => window.clearInterval(t);
  }, [refresh]);

  // auto-open expanded if URL carries `?alertId=...` (chrome.notification click landing).
  useEffect(() => {
    try {
      const id = new URL(window.location.href).searchParams.get('alertId');
      if (id) setExpanded(true);
    } catch {
      /* no-op */
    }
  }, []);

  if (!data || data.muted || data.optedOut || data.active.length === 0) {
    return null;
  }

  const top = data.active[0]!;
  const Icon = severityStyles(top.severity).icon;
  const styles = severityStyles(top.severity);
  const moreCount = data.active.length - 1;

  async function handleDismiss(id: string) {
    setBusy(true);
    try {
      await trpc.dismissAlert.mutate({ id });
      await refresh();
      setExpanded(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="sp-alertBanner"
      role="alert"
      aria-live="polite"
      style={{
        background: styles.bg,
        borderTop: `1px solid ${styles.fg}`,
        borderBottom: `1px solid ${styles.fg}`,
        padding: '8px 12px',
        fontSize: 12,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <Icon size={16} aria-hidden="true" style={{ flexShrink: 0, marginTop: 1, color: styles.fg }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
            <strong style={{ color: styles.fg, fontSize: 12 }}>{top.titleShort}</strong>
            <span className="sp-muted" style={{ fontSize: 10 }}>
              {top.severity} · {relTime(top.timestampMs)}
            </span>
          </div>
          {top.affectedDomains.length > 0 && (
            <div className="sp-muted" style={{ fontSize: 11, marginTop: 2 }}>
              flagged: {top.affectedDomains.slice(0, 3).join(', ')}
              {top.affectedDomains.length > 3 ? ` +${top.affectedDomains.length - 3}` : ''}
            </div>
          )}
          {expanded && (
            <div
              style={{
                marginTop: 6,
                whiteSpace: 'pre-wrap',
                fontSize: 11,
                lineHeight: 1.45,
                background: 'rgba(255,255,255,0.04)',
                padding: 8,
                borderRadius: 4,
              }}
            >
              {top.bodyLong}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="sp-btn sp-btn--ghost"
              style={{ fontSize: 11, padding: '2px 8px', display: 'inline-flex', alignItems: 'center', gap: 4 }}
              aria-expanded={expanded}
            >
              {expanded ? (
                <>
                  <ChevronUp size={12} /> collapse
                </>
              ) : (
                <>
                  <ChevronDown size={12} /> details
                </>
              )}
            </button>
            <button
              type="button"
              onClick={() => void handleDismiss(top.id)}
              disabled={busy}
              className="sp-btn sp-btn--ghost"
              style={{ fontSize: 11, padding: '2px 8px', display: 'inline-flex', alignItems: 'center', gap: 4 }}
            >
              <X size={12} /> dismiss
            </button>
            {moreCount > 0 && (
              <button
                type="button"
                onClick={() => onOpenHistory?.()}
                className="sp-btn sp-btn--ghost"
                style={{ fontSize: 11, padding: '2px 8px' }}
              >
                +{moreCount} more
              </button>
            )}
            <span className="sp-muted" style={{ fontSize: 10, marginLeft: 'auto' }}>
              chromatika safety alerts
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
