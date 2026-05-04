/**
 * compact "policy-gated" banner for send pages. shows the cap remaining + spent today +
 * panicked state at a glance, so users see why their tx might abort with "exceeds your $X/day
 * cap" before they hit submit.
 *
 * mounts above the send form when `getPolicyVaultLink(activeVaultId)` is set; renders nothing
 * when the active vault hasn't opted in. polls every 8s to keep the cap-remaining number live
 * across in-page sends + safety-alert auto-panic.
 */

import { useCallback, useEffect, useState } from 'react';
import { Lock, ShieldAlert, ShieldCheck, TimerReset } from 'lucide-react';
import { trpc } from '@/lib/trpc';

type State = Awaited<ReturnType<typeof trpc.getPolicyVaultState.query>>;

function microsToUsd(microsStr: string): string {
  try {
    const n = BigInt(microsStr);
    if (n === 0n) return '0';
    const whole = n / 1_000_000n;
    const frac = (n % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
    return `${whole.toString()}${frac ? '.' + frac : ''}`;
  } catch {
    return microsStr;
  }
}

function fmtMs(ms: number): string {
  if (ms <= 0) return 'now';
  if (ms < 60_000) return `${Math.ceil(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.ceil(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  return `${(ms / 86_400_000).toFixed(1)}d`;
}

export function PolicyVaultBanner() {
  const [state, setState] = useState<State | null>(null);
  const [now, setNow] = useState(Date.now());

  const refresh = useCallback(async () => {
    try {
      const s = await trpc.getPolicyVaultState.query();
      setState(s);
    } catch {
      /* best-effort */
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => {
      void refresh();
      setNow(Date.now());
    }, 8000);
    return () => clearInterval(t);
  }, [refresh]);

  if (!state?.link || !state?.snapshot) return null;
  const snap = state.snapshot;
  const cap = BigInt(snap.dailyCapMicros);
  const spent = BigInt(snap.spentTodayMicros);
  const remaining = cap > spent ? cap - spent : 0n;
  const overOrAt = cap > 0n && remaining === 0n;
  const panicked = snap.panicked;

  if (panicked) {
    const unlocksIn = snap.unfreezeUnlocksAtMs - now;
    return (
      <div
        style={{
          padding: 8,
          marginBottom: 10,
          background: 'rgba(239,68,68,0.10)',
          border: '1px solid rgba(239,68,68,0.4)',
          borderRadius: 4,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 11,
          color: '#ef4444',
        }}
      >
        <ShieldAlert size={12} />
        <strong>policy vault is panicked.</strong>
        <span style={{ marginLeft: 'auto' }}>
          <TimerReset size={11} style={{ verticalAlign: 'middle' }} /> unfreeze in {fmtMs(unlocksIn)}
        </span>
      </div>
    );
  }

  return (
    <div
      style={{
        padding: 8,
        marginBottom: 10,
        background: overOrAt ? 'rgba(255,196,77,0.10)' : 'rgba(134,239,172,0.06)',
        border: `1px solid ${overOrAt ? 'rgba(255,196,77,0.4)' : 'rgba(134,239,172,0.20)'}`,
        borderRadius: 4,
        fontSize: 11,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 500 }}>
        {overOrAt ? <Lock size={12} color="#ffc44d" /> : <ShieldCheck size={12} color="#86efac" />}
        <span>policy-gated · this dWallet signs through the on-chain spend cap module</span>
      </div>
      {cap > 0n && (
        <div style={{ marginTop: 4 }}>
          remaining today: <strong>${microsToUsd(remaining.toString())}</strong>
          {' '}
          <span style={{ opacity: 0.7 }}>
            · spent: ${microsToUsd(spent.toString())} of ${microsToUsd(cap.toString())}
          </span>
        </div>
      )}
      {cap === 0n && (
        <div style={{ marginTop: 4, opacity: 0.7 }}>
          no daily cap configured · sends still gated by panic + cool-down + actuator checks
        </div>
      )}
      {snap.coolDownMs > 0 && (
        <div style={{ marginTop: 2, opacity: 0.7 }}>cool-down: {fmtMs(snap.coolDownMs)} between sends</div>
      )}
      {overOrAt && (
        <div style={{ marginTop: 4, color: '#ffc44d' }}>
          today's cap is reached. Increase it in Settings -&gt; Security or wait until tomorrow.
        </div>
      )}
    </div>
  );
}
