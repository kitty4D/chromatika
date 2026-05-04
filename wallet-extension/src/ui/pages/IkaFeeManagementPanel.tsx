/**
 * per-vault ika fee management panel. renders only for Solana-base hardware vaults
 * (the only vault kind that has a separate in-extension fee account today).
 *
 * surfaces:
 *  - current mode (in_extension default, seeker_direct opt-in for max trust).
 *  - mode toggle with confirm-drain prompt when flipping `in_extension` to `seeker_direct`
 *    while there's a non-zero balance on the fee payer.
 *  - refill amount + threshold inputs (editable, persisted via `setIkaFeeSettings`).
 *  - current fee-payer balance + [refill now] [drain to Seeker] buttons.
 *  - collapsible address row (so it's available without dominating the surface).
 *  - "abandoned" residual fee payers when the vault flipped to seeker_direct without
 *    draining first: we surface the address + balance + a one-click drain button so
 *    nothing is ever silently stranded.
 *
 * strict per-vault: takes a vaultId prop and operates on it via tRPC. caller is
 * responsible for ensuring the vault is the active session vault before mutations
 * (most mutation endpoints require this).
 */

import { useCallback, useEffect, useState } from 'react';
import { trpc } from '@/lib/trpc';

type Status =
  | { kind: 'idle' }
  | { kind: 'busy'; msg: string }
  | { kind: 'error'; msg: string }
  | { kind: 'ok'; msg: string };

const LAMPORTS_PER_SOL = 1_000_000_000n;

function lamportsToSolDisplay(lamports: string | bigint): string {
  const n = typeof lamports === 'bigint' ? lamports : BigInt(lamports);
  const whole = n / LAMPORTS_PER_SOL;
  const frac = n % LAMPORTS_PER_SOL;
  if (frac === 0n) return `${whole}`;
  // pad the fractional part to 9 digits, then strip trailing zeros
  const fracStr = frac.toString().padStart(9, '0').replace(/0+$/, '');
  return fracStr.length ? `${whole}.${fracStr}` : `${whole}`;
}

function solInputToLamports(s: string): bigint | null {
  const t = s.trim();
  if (!t) return null;
  // permit `.5` style entries
  const norm = t.startsWith('.') ? `0${t}` : t;
  if (!/^\d+(\.\d{1,9})?$/.test(norm)) return null;
  const [whole, frac = ''] = norm.split('.');
  const fracPadded = (frac + '000000000').slice(0, 9);
  return BigInt(whole) * LAMPORTS_PER_SOL + BigInt(fracPadded);
}

type FeePayerStatus = {
  mode: 'in_extension' | 'seeker_direct';
  autoRefill: boolean;
  refillLamports: string;
  thresholdLamports: string;
  seekerAddress: string | null;
  feePayerAddress: string | null;
  feePayerBalanceLamports: string | null;
};

export function IkaFeeManagementPanel({
  vaultId,
  vaultLabel,
  vaultBaseChain,
  vaultAccountKind,
  isActive,
}: {
  vaultId: string;
  vaultLabel: string;
  vaultBaseChain: 'sui' | 'solana';
  vaultAccountKind: 'hd' | 'importedKey' | 'hardware' | 'dwalletAnchored' | 'passkey' | 'waap' | 'lazor';
  /** whether this is the currently-unlocked active vault. mutation endpoints require this. */
  isActive: boolean;
}) {
  const [status, setStatus] = useState<FeePayerStatus | null>(null);
  const [statusErr, setStatusErr] = useState<string | null>(null);
  const [refillInput, setRefillInput] = useState<string>('');
  const [thresholdInput, setThresholdInput] = useState<string>('');
  const [topUpAmount, setTopUpAmount] = useState<string>('');
  const [showAddress, setShowAddress] = useState<boolean>(false);
  const [busy, setBusy] = useState<Status>({ kind: 'idle' });

  const applies = vaultBaseChain === 'solana' && vaultAccountKind === 'hardware';

  const refresh = useCallback(async () => {
    if (!applies) return;
    setStatusErr(null);
    try {
      const s = await trpc.ikaFeePayerStatus.query({ vaultId });
      setStatus(s);
      setRefillInput(lamportsToSolDisplay(s.refillLamports));
      setThresholdInput(lamportsToSolDisplay(s.thresholdLamports));
    } catch (e) {
      setStatusErr(e instanceof Error ? e.message : String(e));
    }
  }, [applies, vaultId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!applies) {
    return (
      <div style={panelStyle}>
        <div style={panelHeaderStyle}>ika protocol fees</div>
        <p style={mutedStyle}>
          This vault uses {vaultBaseChain === 'sui' ? 'Sui-base ika' : 'a different fee model'} —
          the in-extension fee account only applies to Solana-base hardware vaults
          (Seeker / WalletConnect / Solana Mobile). Nothing to manage here.
        </p>
      </div>
    );
  }

  if (statusErr) {
    return (
      <div style={panelStyle}>
        <div style={panelHeaderStyle}>ika protocol fees</div>
        <p style={errorStyle}>could not load fee status: {statusErr}</p>
        <button type="button" className="wc-btn" onClick={() => void refresh()}>
          retry
        </button>
      </div>
    );
  }

  if (!status) {
    return (
      <div style={panelStyle}>
        <div style={panelHeaderStyle}>ika protocol fees</div>
        <p style={mutedStyle}>loading…</p>
      </div>
    );
  }

  const balanceLamports = status.feePayerBalanceLamports;
  const balanceLabel = balanceLamports != null ? `${lamportsToSolDisplay(balanceLamports)} SOL` : '—';
  const thresholdLamportsBigInt = BigInt(status.thresholdLamports);
  const balanceBigInt = balanceLamports != null ? BigInt(balanceLamports) : 0n;
  const isLow = status.mode === 'in_extension' && balanceBigInt < thresholdLamportsBigInt;

  async function persistRefillAmount() {
    const lamports = solInputToLamports(refillInput);
    if (lamports === null) {
      setBusy({ kind: 'error', msg: 'Enter a valid SOL amount (e.g. 0.01)' });
      return;
    }
    setBusy({ kind: 'busy', msg: 'saving refill amount…' });
    try {
      await trpc.setIkaFeeSettings.mutate({ vaultId, refillLamports: lamports.toString() });
      setBusy({ kind: 'ok', msg: 'saved' });
      await refresh();
    } catch (e) {
      setBusy({ kind: 'error', msg: e instanceof Error ? e.message : String(e) });
    }
  }

  async function persistThreshold() {
    const lamports = solInputToLamports(thresholdInput);
    if (lamports === null) {
      setBusy({ kind: 'error', msg: 'Enter a valid SOL amount (e.g. 0.001)' });
      return;
    }
    setBusy({ kind: 'busy', msg: 'saving threshold…' });
    try {
      await trpc.setIkaFeeSettings.mutate({ vaultId, thresholdLamports: lamports.toString() });
      setBusy({ kind: 'ok', msg: 'saved' });
      await refresh();
    } catch (e) {
      setBusy({ kind: 'error', msg: e instanceof Error ? e.message : String(e) });
    }
  }

  async function toggleAutoRefill(next: boolean) {
    setBusy({ kind: 'busy', msg: next ? 'enabling auto-refill…' : 'disabling auto-refill…' });
    try {
      await trpc.setIkaFeeSettings.mutate({ vaultId, autoRefill: next });
      setBusy({ kind: 'ok', msg: 'saved' });
      await refresh();
    } catch (e) {
      setBusy({ kind: 'error', msg: e instanceof Error ? e.message : String(e) });
    }
  }

  async function flipToSeekerDirect() {
    if (!isActive) {
      setBusy({ kind: 'error', msg: 'Switch to this vault first to change its fee mode' });
      return;
    }
    if (balanceBigInt > 0n) {
      const drainPrompt = confirm(
        `The fee account holds ${balanceLabel}. Drain it back to your Seeker before switching to "max trust" mode? `
        + `If you cancel, the funds stay visible here and can be drained later.`,
      );
      if (drainPrompt) {
        setBusy({ kind: 'busy', msg: 'draining fee account back to Seeker…' });
        try {
          await trpc.drainIkaFeePayerToSeeker.mutate({ vaultId });
        } catch (e) {
          setBusy({ kind: 'error', msg: e instanceof Error ? e.message : String(e) });
          return;
        }
      }
    }
    setBusy({ kind: 'busy', msg: 'switching to max-trust mode…' });
    try {
      await trpc.setIkaFeeSettings.mutate({ vaultId, mode: 'seeker_direct' });
      setBusy({
        kind: 'ok',
        msg: 'mode set to "max trust" — your phone will sign every ika protocol message',
      });
      await refresh();
    } catch (e) {
      setBusy({ kind: 'error', msg: e instanceof Error ? e.message : String(e) });
    }
  }

  async function flipToInExtension() {
    if (!isActive) {
      setBusy({ kind: 'error', msg: 'Switch to this vault first to change its fee mode' });
      return;
    }
    setBusy({ kind: 'busy', msg: 'switching to fast (in-extension fee account) mode…' });
    try {
      await trpc.setIkaFeeSettings.mutate({ vaultId, mode: 'in_extension' });
      setBusy({
        kind: 'ok',
        msg: 'mode set to "fast" — auto-refill from your Seeker on next ika operation',
      });
      await refresh();
    } catch (e) {
      setBusy({ kind: 'error', msg: e instanceof Error ? e.message : String(e) });
    }
  }

  async function topUpNow() {
    if (!isActive) {
      setBusy({ kind: 'error', msg: 'Switch to this vault first to top up' });
      return;
    }
    const lamports = solInputToLamports(topUpAmount);
    if (lamports === null || lamports <= 0n) {
      setBusy({ kind: 'error', msg: 'Enter a positive SOL amount to top up' });
      return;
    }
    setBusy({ kind: 'busy', msg: 'preparing top-up — sign on your phone when the popup opens…' });
    try {
      const res = await trpc.topUpIkaFeePayer.mutate({ vaultId, lamports: lamports.toString() });
      setBusy({ kind: 'ok', msg: `top-up confirmed (${res.txSignature.slice(0, 8)}…)` });
      setTopUpAmount('');
      await refresh();
    } catch (e) {
      setBusy({ kind: 'error', msg: e instanceof Error ? e.message : String(e) });
    }
  }

  async function drainAll() {
    if (!isActive) {
      setBusy({ kind: 'error', msg: 'Switch to this vault first to drain' });
      return;
    }
    setBusy({ kind: 'busy', msg: 'draining fee account back to Seeker…' });
    try {
      const res = await trpc.drainIkaFeePayerToSeeker.mutate({ vaultId });
      setBusy({
        kind: 'ok',
        msg: `drained ${lamportsToSolDisplay(res.lamportsSent)} SOL back to Seeker`,
      });
      await refresh();
    } catch (e) {
      setBusy({ kind: 'error', msg: e instanceof Error ? e.message : String(e) });
    }
  }

  /**
   * "abandoned" path: the vault is in seeker_direct mode but the encrypted blob still has a
   * residual keypair (from a prior in_extension lifetime), and that keypair has a balance.
   * surfacing here is the user-trust contract: no funds ever silently stranded.
   */
  const showAbandonedDrainCta =
    status.mode === 'seeker_direct' && status.feePayerAddress != null && balanceBigInt > 0n;

  async function drainAbandoned() {
    if (!isActive) {
      setBusy({ kind: 'error', msg: 'Switch to this vault first to drain' });
      return;
    }
    setBusy({ kind: 'busy', msg: 'draining residual fee-payer balance back to Seeker…' });
    try {
      const res = await trpc.drainAbandonedFeePayer.mutate({ vaultId });
      setBusy({
        kind: 'ok',
        msg: `drained ${lamportsToSolDisplay(res.lamportsSent)} SOL back to Seeker`,
      });
      await refresh();
    } catch (e) {
      setBusy({ kind: 'error', msg: e instanceof Error ? e.message : String(e) });
    }
  }

  return (
    <div style={panelStyle}>
      <div style={panelHeaderStyle}>
        ika protocol fees · {vaultLabel}
      </div>

      <p style={mutedStyle}>
        ika runs many small protocol messages per dWallet operation. To avoid prompting your
        Seeker for each one, Chromatika maintains a tiny in-extension fee account that pays
        these automatically — auto-refilled from your Seeker when low. You can switch to "max
        trust" mode to sign every protocol message on the phone instead.
      </p>

      <div style={rowStyle}>
        <span style={rowLabelStyle}>mode</span>
        <span style={rowValueStyle}>
          {status.mode === 'in_extension' ? 'fast (in-extension fee account)' : 'max trust (Seeker signs every protocol message)'}
        </span>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        {status.mode === 'in_extension' ? (
          <button type="button" className="wc-btn" onClick={() => void flipToSeekerDirect()} disabled={busy.kind === 'busy'}>
            switch to max trust
          </button>
        ) : (
          <button type="button" className="wc-btn" onClick={() => void flipToInExtension()} disabled={busy.kind === 'busy'}>
            switch to fast
          </button>
        )}
      </div>

      {status.mode === 'in_extension' && (
        <>
          <div style={rowStyle}>
            <span style={rowLabelStyle}>balance</span>
            <span style={rowValueStyle}>
              {balanceLabel}
              {isLow && <span style={lowBadgeStyle}>low</span>}
            </span>
          </div>

          <div style={rowStyle}>
            <span style={rowLabelStyle}>auto-refill</span>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <input
                type="checkbox"
                checked={status.autoRefill}
                disabled={busy.kind === 'busy' || !isActive}
                onChange={(e) => void toggleAutoRefill(e.target.checked)}
              />
              <span style={mutedSmallStyle}>
                automatically top up from your Seeker when balance falls below threshold
              </span>
            </label>
          </div>

          <div style={rowStyle}>
            <span style={rowLabelStyle}>refill amount (SOL)</span>
            <span style={inputRowStyle}>
              <input
                type="text"
                inputMode="decimal"
                value={refillInput}
                onChange={(e) => setRefillInput(e.target.value)}
                style={inputStyle}
              />
              <button type="button" className="wc-btn" onClick={() => void persistRefillAmount()} disabled={busy.kind === 'busy'}>
                save
              </button>
            </span>
          </div>

          <div style={rowStyle}>
            <span style={rowLabelStyle}>refill threshold (SOL)</span>
            <span style={inputRowStyle}>
              <input
                type="text"
                inputMode="decimal"
                value={thresholdInput}
                onChange={(e) => setThresholdInput(e.target.value)}
                style={inputStyle}
              />
              <button type="button" className="wc-btn" onClick={() => void persistThreshold()} disabled={busy.kind === 'busy'}>
                save
              </button>
            </span>
          </div>

          <div style={rowStyle}>
            <span style={rowLabelStyle}>top up now</span>
            <span style={inputRowStyle}>
              <input
                type="text"
                inputMode="decimal"
                placeholder="0.01"
                value={topUpAmount}
                onChange={(e) => setTopUpAmount(e.target.value)}
                style={inputStyle}
              />
              <button
                type="button"
                className="wc-btn wc-btnPrimary"
                onClick={() => void topUpNow()}
                disabled={busy.kind === 'busy' || !isActive}
              >
                send from Seeker
              </button>
            </span>
          </div>

          <div style={rowStyle}>
            <span style={rowLabelStyle}>drain</span>
            <button
              type="button"
              className="wc-btn"
              onClick={() => void drainAll()}
              disabled={busy.kind === 'busy' || balanceBigInt === 0n || !isActive}
            >
              drain to Seeker
            </button>
          </div>
        </>
      )}

      {showAbandonedDrainCta && (
        <div style={residualNoteStyle}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>residual fee-payer balance</div>
          <p style={{ ...mutedStyle, marginBottom: 8 }}>
            This vault's previous fee account still has <strong>{balanceLabel}</strong> on it.
            Recover it back to your Seeker any time — Chromatika never silently abandons your
            funds.
          </p>
          <button
            type="button"
            className="wc-btn wc-btnPrimary"
            onClick={() => void drainAbandoned()}
            disabled={busy.kind === 'busy' || !isActive}
          >
            drain residual balance to Seeker
          </button>
        </div>
      )}

      <div style={rowStyle}>
        <span style={rowLabelStyle}>fee account address</span>
        <button
          type="button"
          className="wc-btn"
          onClick={() => setShowAddress((v) => !v)}
          style={{ fontSize: 11 }}
        >
          {showAddress ? 'hide' : 'show'}
        </button>
      </div>
      {showAddress && status.feePayerAddress && (
        <div style={addressBoxStyle}>{status.feePayerAddress}</div>
      )}
      {showAddress && !status.feePayerAddress && (
        <div style={{ ...mutedSmallStyle, marginBottom: 14 }}>
          No fee account exists for this vault (you're in max-trust mode and never had one).
        </div>
      )}

      {!isActive && (
        <p style={mutedSmallStyle}>
          Switch to this vault to change its fee settings or move funds.
        </p>
      )}
      {busy.kind === 'busy' && <p style={busyStyle}>{busy.msg}</p>}
      {busy.kind === 'error' && <p style={errorStyle}>{busy.msg}</p>}
      {busy.kind === 'ok' && <p style={okStyle}>{busy.msg}</p>}
    </div>
  );
}

const panelStyle: React.CSSProperties = {
  padding: 14,
  borderRadius: 12,
  background: 'rgba(255,255,255,0.04)',
  border: '1px solid rgba(255,255,255,0.08)',
  marginBottom: 14,
};

const panelHeaderStyle: React.CSSProperties = {
  fontWeight: 800,
  fontSize: 14,
  marginBottom: 12,
};

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 10,
  marginBottom: 10,
  flexWrap: 'wrap',
};

const rowLabelStyle: React.CSSProperties = {
  fontSize: 12,
  color: 'rgba(234,240,255,0.62)',
  flex: '0 0 auto',
};

const rowValueStyle: React.CSSProperties = {
  fontWeight: 600,
  fontSize: 13,
};

const lowBadgeStyle: React.CSSProperties = {
  marginLeft: 8,
  padding: '2px 6px',
  borderRadius: 6,
  background: 'rgba(245,158,11,0.18)',
  border: '1px solid rgba(245,158,11,0.4)',
  color: 'rgba(245,158,11,0.95)',
  fontSize: 10,
  fontWeight: 700,
};

const mutedStyle: React.CSSProperties = {
  fontSize: 12,
  color: 'rgba(234,240,255,0.62)',
  lineHeight: 1.5,
  marginBottom: 12,
};

const mutedSmallStyle: React.CSSProperties = {
  fontSize: 11,
  color: 'rgba(234,240,255,0.55)',
  lineHeight: 1.4,
};

const inputRowStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
};

const inputStyle: React.CSSProperties = {
  width: 110,
  padding: '6px 8px',
  borderRadius: 8,
  background: 'rgba(0,0,0,0.25)',
  border: '1px solid rgba(255,255,255,0.1)',
  color: 'inherit',
  fontFamily: 'inherit',
  fontSize: 12,
};

const busyStyle: React.CSSProperties = {
  color: 'rgba(245,158,11,0.95)',
  fontSize: 12,
  marginTop: 6,
};

const errorStyle: React.CSSProperties = {
  color: 'rgba(255,99,132,0.95)',
  fontSize: 12,
  marginTop: 6,
};

const okStyle: React.CSSProperties = {
  color: 'rgba(16,185,129,0.95)',
  fontSize: 12,
  marginTop: 6,
};

const addressBoxStyle: React.CSSProperties = {
  fontFamily: 'monospace',
  fontSize: 10,
  wordBreak: 'break-all',
  background: 'rgba(0,0,0,0.25)',
  padding: '8px 10px',
  borderRadius: 8,
  marginBottom: 14,
  userSelect: 'all',
};

const residualNoteStyle: React.CSSProperties = {
  padding: 12,
  borderRadius: 10,
  background: 'rgba(245,158,11,0.08)',
  border: '1px solid rgba(245,158,11,0.22)',
  marginBottom: 14,
};
