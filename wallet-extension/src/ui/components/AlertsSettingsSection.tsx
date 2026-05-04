/**
 * settings section for the safety-broadcast alerts surface. mounted from `SettingsPage.tsx`
 * alongside the agents / payments sections.
 *
 * surfaces:
 *   - mute toggle (suppress chrome.notifications + in-app banner; history still renders)
 *   - opt-out toggle (also stops the poller; nuclear option)
 *   - last-poll status (timestamp, error, manual refresh button)
 *   - feed URL viewer (advanced) + custom override input
 *   - history list (collapsible) with dismissed flag, severity tag, body preview, timestamp
 *   - publisher allowlist viewer (advanced)
 *   - dev-only "inject test alert" button (when import.meta.env.DEV)
 */

import { useCallback, useEffect, useState } from 'react';
import { Bell, BellOff, Loader2, RefreshCw, AlertTriangle, AlertCircle } from 'lucide-react';
import { trpc } from '@/lib/trpc';

type AlertSettings = Awaited<ReturnType<typeof trpc.getAlertSettings.query>>;
type AlertList = Awaited<ReturnType<typeof trpc.listAlerts.query>>;
type KnownAlerts = Awaited<ReturnType<typeof trpc.listKnownAlerts.query>>;

function severityIcon(s: string) {
  if (s === 'critical') return <AlertTriangle size={12} color="#fca5a5" />;
  if (s === 'warning') return <AlertCircle size={12} color="#fcd34d" />;
  return <Bell size={12} color="#93c5fd" />;
}

function fmtTime(ms: number): string {
  if (!ms) return 'never';
  return new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function AlertsSettingsSection({ advanced }: { advanced: boolean }) {
  const [settings, setSettings] = useState<AlertSettings | null>(null);
  const [list, setList] = useState<AlertList | null>(null);
  const [known, setKnown] = useState<KnownAlerts | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [feedUrlDraft, setFeedUrlDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [s, l, k] = await Promise.all([
        trpc.getAlertSettings.query(),
        trpc.listAlerts.query(),
        trpc.listKnownAlerts.query(),
      ]);
      setSettings(s);
      setList(l);
      setKnown(k);
      setFeedUrlDraft(s.customFeedUrl);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function toggleMuted(next: boolean) {
    setError(null);
    const updated = await trpc.setAlertSettings.mutate({ muted: next });
    setSettings(updated);
  }

  async function toggleOptedOut(next: boolean) {
    setError(null);
    const updated = await trpc.setAlertSettings.mutate({ optedOut: next });
    setSettings(updated);
  }

  async function saveFeedUrl() {
    setError(null);
    const updated = await trpc.setAlertSettings.mutate({ customFeedUrl: feedUrlDraft.trim() });
    setSettings(updated);
    await trpc.triggerAlertPoll.mutate(); // refresh feed immediately on URL change
    await refresh();
  }

  async function manualRefresh() {
    setRefreshing(true);
    setError(null);
    try {
      await trpc.triggerAlertPoll.mutate();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <section className="sp-settingsSection">
      <h3 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Bell size={14} /> safety alerts
      </h3>
      <p className="sp-muted" style={{ fontSize: 12 }}>
        chromatika polls a signed safety-alerts feed (currently every 5 min) and surfaces alerts about
        phishing dapps, drainer contracts, and other in-the-wild attacks. critical alerts auto-add
        the affected domain to chrome's network-level phishing redirect, with a TTL that auto-cleans.
      </p>

      {error && (
        <div className="sp-error" style={{ marginTop: 6, fontSize: 11 }}>
          {error}
        </div>
      )}

      {settings && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
            <button
              type="button"
              className="sp-btn"
              onClick={() => void toggleMuted(!settings.muted)}
              aria-pressed={settings.muted}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
            >
              {settings.muted ? <BellOff size={12} /> : <Bell size={12} />} {settings.muted ? 'unmute alerts' : 'mute alerts'}
            </button>
            <span className="sp-muted" style={{ fontSize: 10 }}>
              {settings.muted ? 'banner + chrome notifications hidden; phishing rules still active' : 'banner + chrome notifications enabled'}
            </span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
            <button
              type="button"
              className="sp-btn"
              onClick={() => void toggleOptedOut(!settings.optedOut)}
              aria-pressed={settings.optedOut}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
            >
              {settings.optedOut ? 'opt back in' : 'opt out (stop polling)'}
            </button>
            <span className="sp-muted" style={{ fontSize: 10 }}>
              {settings.optedOut ? 'feed polling disabled; existing rules clear on TTL' : 'polls feed every 5 min'}
            </span>
          </div>
        </>
      )}

      {list && (
        <div className="sp-muted" style={{ fontSize: 11, marginTop: 8 }}>
          last polled: {fmtTime(list.lastPolledAtMs)}
          {list.lastPollError ? ` · last error: ${list.lastPollError}` : null} · feed: {list.feedUrl}
          <button
            type="button"
            className="sp-btn sp-btn--ghost"
            onClick={() => void manualRefresh()}
            disabled={refreshing}
            style={{ marginLeft: 8, fontSize: 11, padding: '2px 6px', display: 'inline-flex', alignItems: 'center', gap: 4 }}
          >
            {refreshing ? <Loader2 size={11} className="sp-spin" /> : <RefreshCw size={11} />} refresh now
          </button>
        </div>
      )}

      {advanced && settings && (
        <div style={{ marginTop: 12 }}>
          <label className="sp-muted" style={{ fontSize: 11 }}>
            custom feed URL (advanced):
          </label>
          <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
            <input
              type="url"
              className="sp-input"
              value={feedUrlDraft}
              onChange={(e) => setFeedUrlDraft(e.target.value)}
              placeholder="(empty = default chromatika feed)"
              style={{ flex: 1, fontSize: 11 }}
            />
            <button type="button" className="sp-btn" onClick={() => void saveFeedUrl()}>
              save
            </button>
          </div>
        </div>
      )}

      <div style={{ marginTop: 12 }}>
        <button
          type="button"
          className="sp-btn sp-btn--ghost"
          onClick={() => setHistoryOpen((v) => !v)}
          style={{ fontSize: 11 }}
        >
          {historyOpen ? 'hide history' : 'show alert history'}{' '}
          {known ? `(${known.alerts.length})` : ''}
        </button>
        {historyOpen && known && (
          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {known.alerts.length === 0 && (
              <div className="sp-muted" style={{ fontSize: 11 }}>
                no alerts yet.
              </div>
            )}
            {known.alerts.map((a) => (
              <div
                key={a.id}
                style={{
                  fontSize: 11,
                  padding: 8,
                  background: 'rgba(255,255,255,0.03)',
                  borderRadius: 4,
                  opacity: a.dismissed ? 0.6 : 1,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {severityIcon(a.severity)}
                  <strong>{a.titleShort}</strong>
                  <span className="sp-muted" style={{ marginLeft: 'auto', fontSize: 10 }}>
                    {fmtTime(a.timestampMs)}
                    {a.dismissed ? ' · dismissed' : ''}
                  </span>
                </div>
                {a.affectedDomains.length > 0 && (
                  <div className="sp-muted" style={{ fontSize: 10, marginTop: 2 }}>
                    flagged: {a.affectedDomains.join(', ')}
                  </div>
                )}
                <div style={{ marginTop: 4, whiteSpace: 'pre-wrap' }}>{a.bodyLong}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {advanced && known && (
        <details style={{ marginTop: 8, fontSize: 11 }}>
          <summary className="sp-muted">publisher allowlist</summary>
          <div style={{ marginTop: 6 }}>
            {known.publishers.map((p) => (
              <div key={p.pubkeyB64} style={{ marginBottom: 4 }}>
                <span style={{ fontFamily: 'monospace', fontSize: 10 }}>{p.pubkeyB64}</span> — {p.label}
              </div>
            ))}
          </div>
        </details>
      )}
    </section>
  );
}
