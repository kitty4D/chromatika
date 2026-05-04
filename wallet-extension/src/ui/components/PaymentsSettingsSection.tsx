import { useCallback, useEffect, useState } from 'react';
import { CreditCard, Plus, Trash2 } from 'lucide-react';
import { trpc } from '@/lib/trpc';

type CapsBundle = Awaited<ReturnType<typeof trpc.x402GetCaps.query>>;

function formatUsd(n: number | null | undefined, opts?: { fractionDigits?: number }): string {
  if (n == null) return '—';
  const d = opts?.fractionDigits ?? 2;
  return `$${n.toFixed(d)}`;
}

function parseUsdInput(raw: string): number | null {
  const t = raw.trim();
  if (t.length === 0) return null;
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const v = Number(t);
  if (!Number.isFinite(v) || v < 0) return null;
  return v;
}

/**
 * settings -> payments. render + edit the x402 daily caps that gate every payment popup.
 * reads `x402GetCaps` (caps + today's spend snapshot); writes via the cap-mutation procedures.
 *
 * pre-alpha: x402 v1 is Solana + USDC + exact scheme only. caps are USD-denominated and reset
 * at local-timezone midnight. per-host overrides win when set; otherwise the default cap applies.
 */
export function PaymentsSettingsSection() {
  const [bundle, setBundle] = useState<CapsBundle | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const [globalDraft, setGlobalDraft] = useState('');
  const [defaultDraft, setDefaultDraft] = useState('');
  const [newHostDraft, setNewHostDraft] = useState('');
  const [newHostCapDraft, setNewHostCapDraft] = useState('');

  const refresh = useCallback(async () => {
    try {
      const r = await trpc.x402GetCaps.query();
      setBundle(r);
      setGlobalDraft(r.caps.globalDailyCapUsd != null ? String(r.caps.globalDailyCapUsd) : '');
      setDefaultDraft(String(r.caps.defaultPerCounterpartyDailyCapUsd));
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function onSetGlobal() {
    setMsg(null);
    setBusy(true);
    try {
      const trimmed = globalDraft.trim();
      const capUsd = trimmed.length === 0 ? null : parseUsdInput(trimmed);
      if (trimmed.length > 0 && capUsd == null) {
        setMsg('global cap must be a positive number or empty (for unlimited)');
        return;
      }
      await trpc.x402SetGlobalCap.mutate({ capUsd });
      await refresh();
      setMsg(capUsd == null ? 'global cap removed (unlimited)' : `global cap set to $${capUsd.toFixed(2)}/day`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onSetDefault() {
    setMsg(null);
    setBusy(true);
    try {
      const capUsd = parseUsdInput(defaultDraft);
      if (capUsd == null) {
        setMsg('default per-host cap must be a non-negative number');
        return;
      }
      await trpc.x402SetDefaultCap.mutate({ capUsd });
      await refresh();
      setMsg(`default per-host cap set to $${capUsd.toFixed(2)}/day`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onAddHost() {
    setMsg(null);
    setBusy(true);
    try {
      const host = newHostDraft.trim().toLowerCase();
      if (host.length === 0) {
        setMsg('host is required (e.g. "api.example.com")');
        return;
      }
      const capUsd = parseUsdInput(newHostCapDraft);
      if (capUsd == null) {
        setMsg('cap must be a non-negative number');
        return;
      }
      await trpc.x402SetPerCounterpartyCap.mutate({ host, capUsd });
      setNewHostDraft('');
      setNewHostCapDraft('');
      await refresh();
      setMsg(`set ${host} cap to $${capUsd.toFixed(2)}/day`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onRemoveHost(host: string) {
    setMsg(null);
    setBusy(true);
    try {
      await trpc.x402SetPerCounterpartyCap.mutate({ host, capUsd: null });
      await refresh();
      setMsg(`removed override for ${host} (back to default cap)`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!bundle) {
    return (
      <div className="sp-section">
        <h3>payments</h3>
        <div className="sp-muted">loading caps…</div>
        {msg && <div className="sp-msg">{msg}</div>}
      </div>
    );
  }

  const { caps, spendToday } = bundle;
  const perHostEntries = Object.entries(caps.perCounterpartyDailyCapUsd).sort((a, b) =>
    a[0].localeCompare(b[0]),
  );
  const hasOverrides = perHostEntries.length > 0;

  // build a per-host spend list for hosts that show up in either caps or spendToday
  const allHosts = new Set<string>([
    ...perHostEntries.map(([h]) => h),
    ...Object.keys(spendToday.perHostUsd),
  ]);
  const hostRows = Array.from(allHosts).sort().map((host) => ({
    host,
    cap: caps.perCounterpartyDailyCapUsd[host] ?? null,
    spent: spendToday.perHostUsd[host] ?? 0,
  }));

  return (
    <div className="sp-section">
      <h3>
        payments <span className="sp-badge">x402 · solana · usdc · pre-alpha</span>
      </h3>
      <p className="sp-muted">
        daily caps gate every x402 payment popup. set in USD (USDC = $1 to 6 decimals); cap
        windows reset at local-timezone midnight. when an agent or paywalled page hits 402 +
        payment-required, the wallet checks these caps before opening the approval window - if
        a payment would breach a cap, the popup never opens.
      </p>

      <div className="sp-row sp-paySummary">
        <div className="sp-paySummaryCell">
          <div className="sp-paySummaryLabel">today total</div>
          <div className="sp-paySummaryValue">{formatUsd(spendToday.totalUsd, { fractionDigits: 4 })}</div>
        </div>
        <div className="sp-paySummaryCell">
          <div className="sp-paySummaryLabel">global cap</div>
          <div className="sp-paySummaryValue">{caps.globalDailyCapUsd != null ? formatUsd(caps.globalDailyCapUsd) : 'unlimited'}</div>
        </div>
        <div className="sp-paySummaryCell">
          <div className="sp-paySummaryLabel">default per-host</div>
          <div className="sp-paySummaryValue">{formatUsd(caps.defaultPerCounterpartyDailyCapUsd)}</div>
        </div>
      </div>

      <div className="sp-row" style={{ alignItems: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
        <label className="sp-swapLabel" style={{ flex: 1, minWidth: 140 }}>
          global cap (USD/day)
          <input
            className="sp-input"
            placeholder="empty = unlimited"
            value={globalDraft}
            onChange={(e) => setGlobalDraft(e.target.value)}
            disabled={busy}
            inputMode="decimal"
          />
        </label>
        <button type="button" className="sp-btn" onClick={() => void onSetGlobal()} disabled={busy}>
          save global
        </button>
      </div>

      <div className="sp-row" style={{ alignItems: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
        <label className="sp-swapLabel" style={{ flex: 1, minWidth: 140 }}>
          default per-host cap (USD/day)
          <input
            className="sp-input"
            value={defaultDraft}
            onChange={(e) => setDefaultDraft(e.target.value)}
            disabled={busy}
            inputMode="decimal"
          />
        </label>
        <button type="button" className="sp-btn" onClick={() => void onSetDefault()} disabled={busy}>
          save default
        </button>
      </div>

      <div className="sp-payHostHeader">per-host overrides</div>

      {hostRows.length === 0 ? (
        <div className="sp-muted" style={{ fontSize: 11 }}>
          no per-host activity or overrides yet. agents that hit 402 endpoints will show up here
          once they spend; you can also pre-set a host cap below.
        </div>
      ) : (
        <table className="sp-payTable">
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>host</th>
              <th style={{ textAlign: 'right' }}>cap</th>
              <th style={{ textAlign: 'right' }}>spent today</th>
              <th style={{ textAlign: 'right' }}>actions</th>
            </tr>
          </thead>
          <tbody>
            {hostRows.map((row) => {
              const effectiveCap = row.cap ?? caps.defaultPerCounterpartyDailyCapUsd;
              const remaining = Math.max(0, effectiveCap - row.spent);
              const overCap = row.spent > effectiveCap;
              return (
                <tr key={row.host}>
                  <td className="sp-payHost">{row.host}</td>
                  <td style={{ textAlign: 'right' }}>
                    {row.cap != null ? formatUsd(row.cap) : <span className="sp-muted">{formatUsd(caps.defaultPerCounterpartyDailyCapUsd)} <em style={{ fontStyle: 'normal', fontSize: 10 }}>(default)</em></span>}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <span className={overCap ? 'sp-warn' : undefined}>{formatUsd(row.spent, { fractionDigits: 4 })}</span>{' '}
                    <span className="sp-muted" style={{ fontSize: 10 }}>(left {formatUsd(remaining, { fractionDigits: 4 })})</span>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {row.cap != null && (
                      <button
                        type="button"
                        className="sp-btn"
                        onClick={() => void onRemoveHost(row.host)}
                        disabled={busy}
                        title="remove override; this host falls back to the default cap"
                      >
                        <Trash2 size={12} />
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <div className="sp-row" style={{ alignItems: 'flex-end', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
        <label className="sp-swapLabel" style={{ flex: 2, minWidth: 160 }}>
          add per-host override
          <input
            className="sp-input"
            placeholder="api.example.com"
            value={newHostDraft}
            onChange={(e) => setNewHostDraft(e.target.value)}
            disabled={busy}
            spellCheck={false}
            autoComplete="off"
          />
        </label>
        <label className="sp-swapLabel" style={{ flex: 1, minWidth: 100 }}>
          cap (USD/day)
          <input
            className="sp-input"
            placeholder="5.00"
            value={newHostCapDraft}
            onChange={(e) => setNewHostCapDraft(e.target.value)}
            disabled={busy}
            inputMode="decimal"
          />
        </label>
        <button
          type="button"
          className="sp-btn sp-btn-primary"
          onClick={() => void onAddHost()}
          disabled={busy || newHostDraft.trim().length === 0 || newHostCapDraft.trim().length === 0}
        >
          <Plus size={12} style={{ marginRight: 4 }} />
          add
        </button>
      </div>

      {hasOverrides && (
        <p className="sp-muted" style={{ fontSize: 11, marginTop: 4 }}>
          <CreditCard size={11} style={{ verticalAlign: -2, marginRight: 4 }} />
          {perHostEntries.length} host{perHostEntries.length === 1 ? '' : 's'} with custom caps. remove a row to revert that host to the default.
        </p>
      )}

      {msg && <div className="sp-msg">{msg}</div>}
    </div>
  );
}
