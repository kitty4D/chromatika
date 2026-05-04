/**
 * send-page variant rendered when a pcToken market is the selected asset. provides a recipient +
 * amount input plus an inline "hidden transfer" explainer card. calls `pcTokenTransferHidden`
 * (gated by the first-time disclaimer modal). recipient must already have a pcToken account
 * open for the same market (one-shot wrap on their side).
 */

import { useEffect, useState } from 'react';
import { Lock, Loader2, AlertTriangle } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { HiddenSendDisclaimerModal } from '@/ui/components/HiddenSendDisclaimerModal';

function decimalToBaseUnits(decimal: string, decimals: number): string {
  const t = decimal.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) throw new Error('amount must be a positive decimal');
  const [whole, frac = ''] = t.split('.');
  const fracPadded = frac.padEnd(decimals, '0').slice(0, decimals);
  return (BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(fracPadded)).toString();
}

function formatBaseUnits(baseUnits: string, decimals: number): string {
  if (!baseUnits || baseUnits === '0') return '0';
  const padded = baseUnits.padStart(decimals + 1, '0');
  const whole = padded.slice(0, padded.length - decimals);
  const frac = padded.slice(-decimals).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

export function HiddenTransferForm({
  marketId,
  marketLabel,
  splSymbol,
  splDecimals,
  onSent,
}: {
  marketId: string;
  marketLabel: string;
  splSymbol: string;
  splDecimals: number;
  onSent?: (signature: string) => void;
}) {
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const [showDisclaimer, setShowDisclaimer] = useState(false);
  const [disclaimerAcked, setDisclaimerAcked] = useState<boolean | null>(null);
  const [balanceBaseUnits, setBalanceBaseUnits] = useState<string | null>(null);
  const [decryptingBalance, setDecryptingBalance] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const d = await trpc.getPcDisclaimerState.query();
        setDisclaimerAcked(d.acknowledged);
      } catch {
        setDisclaimerAcked(false);
      }
    })();
  }, []);

  async function refreshBalance() {
    setDecryptingBalance(true);
    setErr(null);
    try {
      const r = await trpc.getPcBalance.query({ marketId });
      setBalanceBaseUnits(r.balanceBaseUnits);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setDecryptingBalance(false);
    }
  }

  async function attemptSend() {
    setErr(null);
    setSignature(null);
    if (!recipient.trim()) {
      setErr('recipient solana address required');
      return;
    }
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
    if (disclaimerAcked === false) {
      setShowDisclaimer(true);
      return;
    }
    await sendNow(baseUnits);
  }

  async function sendNow(baseUnits: string) {
    setBusy(true);
    try {
      const r = await trpc.pcTokenTransferHidden.mutate({
        marketId,
        recipientSolAddress: recipient.trim(),
        amountBaseUnits: baseUnits,
      });
      setSignature(r.signature);
      onSent?.(r.signature);
      setAmount('');
      setRecipient('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="sp-section">
        <div
          style={{
            background: 'rgba(100, 200, 255, 0.08)',
            border: '1px solid rgba(100, 200, 255, 0.18)',
            borderRadius: 4,
            padding: '8px 10px',
            marginBottom: 10,
            fontSize: 11,
            lineHeight: 1.5,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, marginBottom: 4 }}>
            <Lock size={12} /> hidden transfer · {marketLabel}
          </div>
          <div className="sp-muted" style={{ fontSize: 11 }}>
            Amount and recipient pcToken account are encrypted on-chain. Your wallet address stays
            visible to anyone watching the chain — the privacy layer is the value, not the sender.
          </div>
          <div className="sp-muted" style={{ fontSize: 10, marginTop: 4, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <AlertTriangle size={10} /> recipient must already have a pcToken account open for this market.
          </div>
        </div>
      </div>

      <div className="sp-section">
        <div className="sp-sectionTitle">recipient solana address</div>
        <input
          type="text"
          className="sp-input"
          placeholder="base58…"
          value={recipient}
          onChange={(e) => setRecipient(e.target.value)}
          disabled={busy}
        />
      </div>

      <div className="sp-section">
        <div className="sp-sectionTitle">amount</div>
        <div className="sp-amountRow">
          <input
            type="number"
            className="sp-input sp-inputAmount"
            placeholder="0.00"
            min="0"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            disabled={busy}
          />
          <span className="sp-amountUnit">pc{splSymbol}</span>
        </div>
        <div className="sp-muted" style={{ fontSize: 11, marginTop: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
          balance:{' '}
          {balanceBaseUnits != null
            ? `${formatBaseUnits(balanceBaseUnits, splDecimals)} pc${splSymbol}`
            : '—'}
          <button
            type="button"
            className="sp-btn sp-btn--ghost"
            onClick={() => void refreshBalance()}
            disabled={decryptingBalance || busy}
            style={{ fontSize: 10, padding: '2px 6px' }}
          >
            {decryptingBalance ? <><Loader2 size={10} className="sp-spin" /> decrypting…</> : 'decrypt'}
          </button>
        </div>
      </div>

      {err && <div className="sp-error">{err}</div>}

      {signature && (
        <div className="sp-successBox">
          <div className="sp-successLabel">sent (hidden)</div>
          <div className="sp-txHash" title={signature}>
            {signature.slice(0, 12)}…{signature.slice(-8)}
          </div>
        </div>
      )}

      <button
        type="button"
        className="sp-btn sp-btnPrimary sp-btnFull"
        disabled={busy}
        onClick={() => void attemptSend()}
      >
        {busy ? (
          <>
            <Loader2 size={12} className="sp-spin" /> sending hidden…
          </>
        ) : (
          <>
            <Lock size={12} /> send hidden
          </>
        )}
      </button>

      {showDisclaimer && (
        <HiddenSendDisclaimerModal
          onAcknowledged={() => {
            setShowDisclaimer(false);
            void (async () => {
              try {
                await trpc.ackPcDisclaimer.mutate();
                setDisclaimerAcked(true);
                await attemptSend();
              } catch (e) {
                setErr(e instanceof Error ? e.message : String(e));
              }
            })();
          }}
          onClose={() => setShowDisclaimer(false)}
        />
      )}
    </>
  );
}
