import { useState, useEffect } from 'react';
import { trpc } from '@/lib/trpc';
import type { NotifyPrefs, PriceAlert } from '@/background/services/notifications/types';
import { PriceAlertForm } from '@/ui/components/PriceAlertForm';

function ToggleRow({
  label,
  enabled,
  onChange,
}: {
  label: string;
  enabled: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between py-2.5 px-1">
      <span className="text-sm">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        onClick={() => onChange(!enabled)}
        className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
          enabled ? 'bg-primary' : 'bg-muted'
        }`}
      >
        <span
          className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-background shadow-sm transition-transform ${
            enabled ? 'translate-x-4' : 'translate-x-0'
          }`}
        />
      </button>
    </div>
  );
}

export function NotificationSettingsPage({ onBack }: { onBack: () => void }) {
  const [prefs, setPrefs] = useState<NotifyPrefs | null>(null);
  const [alerts, setAlerts] = useState<PriceAlert[]>([]);
  const [showForm, setShowForm] = useState(false);

  useEffect(() => {
    trpc.getNotifyPrefs.query().then(setPrefs);
    trpc.getPriceAlerts.query().then((s) => setAlerts(s.alerts));
  }, []);

  if (!prefs) return null;

  const update = async (patch: { enabled?: boolean; channels?: Partial<NotifyPrefs['channels']>; muted?: boolean }) => {
    const next = await trpc.setNotifyPrefs.mutate(patch);
    setPrefs(next);
  };

  const removeAlert = async (id: string) => {
    await trpc.removePriceAlert.mutate({ id });
    setAlerts((a) => a.filter((x) => x.id !== id));
  };

  const rearmAlert = async (id: string) => {
    await trpc.rearmPriceAlert.mutate({ id });
    setAlerts((a) =>
      a.map((x) => (x.id === id ? { ...x, firedAtMs: undefined } : x)),
    );
  };

  return (
    <div className="sp-page">
      <div className="sp-pageHeader">
        <button type="button" className="sp-backBtn" onClick={onBack}>
          &larr; back
        </button>
        <h2 className="sp-pageTitle" style={{ marginBottom: 0 }}>
          notifications
        </h2>
      </div>

      <div className="sp-section">
        <div className="sp-sectionTitle">master</div>
        <ToggleRow
          label="enable notifications"
          enabled={prefs.enabled}
          onChange={(v) => update({ enabled: v })}
        />
      </div>

      {prefs.enabled && (
        <>
          <div className="sp-section">
            <div className="sp-sectionTitle">channels</div>
            <ToggleRow
              label="incoming transactions"
              enabled={prefs.channels.incomingTx}
              onChange={(v) => update({ channels: { incomingTx: v } })}
            />
            <ToggleRow
              label="send confirmations"
              enabled={prefs.channels.sendConfirmation}
              onChange={(v) => update({ channels: { sendConfirmation: v } })}
            />
            <ToggleRow
              label="price alerts"
              enabled={prefs.channels.priceAlerts}
              onChange={(v) => update({ channels: { priceAlerts: v } })}
            />
            <ToggleRow
              label="dwallet / ika events"
              enabled={prefs.channels.ikaEvents}
              onChange={(v) => update({ channels: { ikaEvents: v } })}
            />
          </div>

          {prefs.channels.priceAlerts && (
            <div className="sp-section">
              <div className="sp-sectionTitle">price alerts</div>
              {alerts.map((a) => (
                <div
                  key={a.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '6px 0',
                    fontSize: 13,
                  }}
                >
                  <span style={a.firedAtMs ? { opacity: 0.5, textDecoration: 'line-through' } : {}}>
                    {a.symbol} {a.direction} ${a.thresholdUsd.toLocaleString()}
                  </span>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {a.firedAtMs && (
                      <button
                        type="button"
                        className="sp-btn"
                        style={{ fontSize: 11, padding: '2px 8px' }}
                        onClick={() => rearmAlert(a.id)}
                      >
                        re-arm
                      </button>
                    )}
                    <button
                      type="button"
                      className="sp-btn"
                      style={{ fontSize: 11, padding: '2px 8px', color: '#ef4444' }}
                      onClick={() => removeAlert(a.id)}
                    >
                      remove
                    </button>
                  </div>
                </div>
              ))}
              {!showForm && alerts.length < 20 && (
                <button
                  type="button"
                  className="sp-btn"
                  style={{ marginTop: 8 }}
                  onClick={() => setShowForm(true)}
                >
                  + add price alert
                </button>
              )}
              {showForm && (
                <PriceAlertForm
                  onCreated={(a) => {
                    setAlerts((prev) => [...prev, a]);
                    setShowForm(false);
                  }}
                  onCancel={() => setShowForm(false)}
                />
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
