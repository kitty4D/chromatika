/**
 * toggle + status for "private receipts": encrypts amounts + counterparty domain in
 * `chromatika_x402_receipts_v1` via `EncryptXyzBackend.encryptForRecipient({ kind: 'self' })`.
 * defends the local payment history against other extensions / malware that read chrome.storage.
 *
 * honest framing: this is **at-rest encryption only**. on-chain x402 settlements stay plaintext
 * USDC SPL transfers, that's the gap that closes once a pcUSDC-aware x402 facilitator ships
 * (tracked in PC_TOKEN.md appendix #4 + STATUS.md "Future hardening"). the toggle copy reflects
 * this; we don't oversell.
 */

import { useCallback, useEffect, useState } from 'react';
import { Lock, AlertTriangle, Loader2, Trash2 } from 'lucide-react';
import { trpc } from '@/lib/trpc';

type PrivateReceiptsState = Awaited<ReturnType<typeof trpc.getX402PrivateReceiptsState.query>>;
type RetentionState = Awaited<ReturnType<typeof trpc.getX402Retention.query>>;
type RetentionDays = RetentionState['days'];

const RETENTION_LABELS: Record<string, string> = {
  '1': '1 day',
  '7': '7 days',
  '30': '30 days',
  '90': '90 days',
  forever: 'forever',
};

export function X402PrivateReceiptsSection() {
  const [state, setState] = useState<PrivateReceiptsState | null>(null);
  const [retention, setRetention] = useState<RetentionState | null>(null);
  const [busy, setBusy] = useState(false);
  const [clearBusy, setClearBusy] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [s, r] = await Promise.all([
        trpc.getX402PrivateReceiptsState.query(),
        trpc.getX402Retention.query(),
      ]);
      setState(s);
      setRetention(r);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function toggle(next: boolean) {
    setBusy(true);
    setErr(null);
    try {
      await trpc.setX402PrivateReceipts.mutate({ enabled: next });
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function changeRetention(next: RetentionDays) {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      await trpc.setX402Retention.mutate({ days: next });
      await refresh();
      setMsg(`receipt retention now: ${RETENTION_LABELS[String(next)]}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleClearAll() {
    setClearBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const res = await trpc.clearAllX402Receipts.mutate();
      setMsg(`removed ${res.removed} receipt${res.removed === 1 ? '' : 's'}`);
      setConfirmClear(false);
      // receipts list polls every 5s, no manual refresh needed; banner message stays for ~one tick.
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setClearBusy(false);
    }
  }

  return (
    <section className="sp-settingsSection">
      <h3 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Lock size={14} /> private receipts
      </h3>

      <div
        className="sp-prealphaPill"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          fontSize: 10,
          padding: '2px 6px',
          borderRadius: 4,
          background: 'rgba(255,196,77,0.15)',
          color: '#ffc44d',
          marginBottom: 8,
        }}
      >
        <AlertTriangle size={10} />
        at-rest only · on-chain amounts still visible until pcUSDC facilitator ships
      </div>

      <p className="sp-muted" style={{ fontSize: 12, margin: '0 0 8px 0' }}>
        when on, chromatika encrypts the <strong>amount</strong> and <strong>counterparty domain</strong>{' '}
        in your local x402 receipts via encrypt.xyz (self-recipient envelope). other extensions, browser
        debuggers, or malware that reads <code>chrome.storage.local</code> can&apos;t see your payment
        history without your dWallet ed25519 unlock + an ika MPC sign.
      </p>
      <p className="sp-muted" style={{ fontSize: 11, margin: '0 0 8px 0' }}>
        what this <em>doesn&apos;t</em> hide: the on-chain Solana tx (USDC SPL transfer to the seller&apos;s
        token account is still public). that closes when an x402 facilitator that accepts pcUSDC ships —
        until then this is purely defense-in-depth for your <em>local</em> chrome.storage.
      </p>

      {err && (
        <div className="sp-error" style={{ marginBottom: 8 }}>
          {err}
        </div>
      )}

      {msg && (
        <div className="sp-muted" style={{ fontSize: 11, marginBottom: 6, color: '#86efac' }}>
          ✓ {msg}
        </div>
      )}

      {state ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
          <button
            type="button"
            className="sp-btn"
            onClick={() => void toggle(!state.enabled)}
            disabled={busy}
            aria-pressed={state.enabled}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
          >
            {busy ? <Loader2 size={11} className="sp-spin" /> : <Lock size={11} />}{' '}
            {state.enabled ? 'private receipts enabled — turn off' : 'enable private receipts'}
          </button>
          <span className="sp-muted" style={{ fontSize: 10 }}>
            {state.enabled
              ? 'new receipts encrypt; existing plain rows remain plain (re-encrypt on next settlement)'
              : 'new receipts store plaintext'}
          </span>
        </div>
      ) : (
        <div className="sp-muted" style={{ fontSize: 11 }}>
          <Loader2 size={11} className="sp-spin" /> loading…
        </div>
      )}

      <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px dashed rgba(255,255,255,0.08)' }}>
        <h4 style={{ fontSize: 12, margin: '0 0 6px 0', display: 'flex', alignItems: 'center', gap: 6 }}>
          retention
        </h4>
        <p className="sp-muted" style={{ fontSize: 11, margin: '0 0 8px 0' }}>
          how long chromatika keeps your local x402 receipts. shorter = less data sitting around for
          another extension or malware to scrape. daily caps still enforce on whatever's inside the
          window.
        </p>
        {retention ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <label className="sp-muted" style={{ fontSize: 11 }} htmlFor="x402-retention-select">
              keep for:
            </label>
            <select
              id="x402-retention-select"
              className="sp-input"
              value={String(retention.days)}
              disabled={busy}
              onChange={(e) => {
                const raw = e.target.value;
                const next: RetentionDays = raw === 'forever' ? 'forever' : (Number(raw) as RetentionDays);
                void changeRetention(next);
              }}
              style={{ fontSize: 11, padding: '2px 6px' }}
            >
              <option value="1">1 day</option>
              <option value="7">7 days</option>
              <option value="30">30 days (default)</option>
              <option value="90">90 days</option>
              <option value="forever">forever</option>
            </select>
          </div>
        ) : (
          <div className="sp-muted" style={{ fontSize: 11 }}>
            <Loader2 size={11} className="sp-spin" /> loading…
          </div>
        )}

        <div style={{ marginTop: 10 }}>
          {!confirmClear ? (
            <button
              type="button"
              className="sp-btn sp-btn--ghost"
              onClick={() => setConfirmClear(true)}
              disabled={clearBusy}
              style={{ fontSize: 11, padding: '4px 8px', display: 'inline-flex', alignItems: 'center', gap: 4 }}
            >
              <Trash2 size={11} /> clear all receipts now
            </button>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <span className="sp-muted" style={{ fontSize: 11 }}>
                this drops every receipt — caps reset to $0 today. confirm?
              </span>
              <button
                type="button"
                className="sp-btn sp-btn--danger"
                onClick={() => void handleClearAll()}
                disabled={clearBusy}
                style={{ fontSize: 11, padding: '4px 8px', display: 'inline-flex', alignItems: 'center', gap: 4 }}
              >
                {clearBusy ? <Loader2 size={11} className="sp-spin" /> : <Trash2 size={11} />} yes, wipe
              </button>
              <button
                type="button"
                className="sp-btn sp-btn--ghost"
                onClick={() => setConfirmClear(false)}
                disabled={clearBusy}
                style={{ fontSize: 11, padding: '4px 8px' }}
              >
                cancel
              </button>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
