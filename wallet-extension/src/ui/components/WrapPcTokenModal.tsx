/**
 * modal for wrapping an SPL token into a pcToken on a specific market. triggered from a Wrap
 * button on an eligible Solana SPL row in the Portfolio asset table. first wrap auto-initializes
 * the user's pcToken account via `pcTokenWrap` (one tx, two ix).
 */

import { useState } from 'react';
import { Lock, Loader2, ArrowDownToLine } from 'lucide-react';
import { trpc } from '@/lib/trpc';

function decimalToBaseUnits(decimal: string, decimals: number): string {
  const t = decimal.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) throw new Error('amount must be a positive decimal');
  const [whole, frac = ''] = t.split('.');
  const fracPadded = frac.padEnd(decimals, '0').slice(0, decimals);
  return (BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(fracPadded)).toString();
}

export function WrapPcTokenModal({
  marketId,
  marketLabel,
  splSymbol,
  splDecimals,
  defaultAmount,
  onClose,
  onSuccess,
}: {
  marketId: string;
  marketLabel: string;
  splSymbol: string;
  splDecimals: number;
  defaultAmount?: string;
  onClose: () => void;
  onSuccess?: (signature: string) => void;
}) {
  const [amount, setAmount] = useState(defaultAmount ?? '1');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const [accountInitialized, setAccountInitialized] = useState<boolean | null>(null);

  async function submit() {
    setErr(null);
    let baseUnits: string;
    try {
      baseUnits = decimalToBaseUnits(amount, splDecimals);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      return;
    }
    if (BigInt(baseUnits) <= 0n) {
      setErr('amount must be positive');
      return;
    }
    setBusy(true);
    try {
      const r = await trpc.pcTokenWrap.mutate({ marketId, amountBaseUnits: baseUnits });
      setSignature(r.signature);
      setAccountInitialized(r.accountInitializedInFlow);
      onSuccess?.(r.signature);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sp-modalBackdrop" onClick={onClose}>
      <div className="sp-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 360 }}>
        <h3 style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 0 }}>
          <ArrowDownToLine size={14} /> wrap → {marketLabel}
        </h3>
        <p className="sp-muted" style={{ fontSize: 11, lineHeight: 1.45 }}>
          Wrapping moves {splSymbol} into the encrypted pc-token balance. The deposit leg is
          visible on-chain; only the post-wrap pcToken balance is hidden. First wrap auto-opens
          your pcToken account in the same transaction.
        </p>

        {signature ? (
          <div style={{ marginTop: 8 }}>
            <div className="sp-muted" style={{ fontSize: 11, color: '#86efac' }}>
              ✓ wrapped successfully
            </div>
            {accountInitialized && (
              <div className="sp-muted" style={{ fontSize: 10, marginTop: 2 }}>
                pcToken account initialized in this tx.
              </div>
            )}
            <div className="sp-muted" style={{ fontSize: 10, marginTop: 4 }}>
              tx: <code>{signature.slice(0, 12)}…{signature.slice(-6)}</code>
            </div>
            <button
              type="button"
              className="sp-btn sp-btn--primary"
              onClick={onClose}
              style={{ width: '100%', marginTop: 12 }}
            >
              done
            </button>
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
              <span className="sp-muted" style={{ fontSize: 10 }}>amount ({splSymbol})</span>
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  type="text"
                  inputMode="decimal"
                  className="sp-input"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  disabled={busy}
                  style={{ flex: 1, fontSize: 13 }}
                  autoFocus
                />
                <span className="sp-muted" style={{ alignSelf: 'center', fontSize: 11 }}>{splSymbol}</span>
              </div>
            </div>
            {err && <div className="sp-error" style={{ marginTop: 6, fontSize: 11 }}>{err}</div>}
            <div style={{ display: 'flex', gap: 6, marginTop: 12 }}>
              <button
                type="button"
                className="sp-btn"
                onClick={onClose}
                disabled={busy}
                style={{ flex: 1 }}
              >
                cancel
              </button>
              <button
                type="button"
                className="sp-btn sp-btn--primary"
                onClick={() => void submit()}
                disabled={busy}
                style={{ flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}
              >
                {busy ? (
                  <>
                    <Loader2 size={12} className="sp-spin" /> wrapping…
                  </>
                ) : (
                  <>
                    <Lock size={12} /> wrap
                  </>
                )}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
