/**
 * the honesty modal that gates the first hidden-send action per vault. three required
 * acknowledgements; "I understand, continue" enables only when all three are checked.
 *
 * why three: surfacing the real privacy model so users don't trust this for real-value transfers
 * before mainnet. PC-Token pre-alpha hides amounts + recipient pcToken accounts but NOT sender
 * wallets, and ciphertext accounts are deterministic per (mint, owner) so repeat sends correlate.
 *
 * per-vault ack stored at `chromatika_pc_disclaimer_v1` (see `pc-token.ts` tRPC router); switching
 * vaults re-prompts.
 */

import { useEffect, useState } from 'react';
import { Lock, AlertTriangle, X, Loader2 } from 'lucide-react';
import { trpc } from '@/lib/trpc';

export function HiddenSendDisclaimerModal({
  onAcknowledged,
  onClose,
}: {
  onAcknowledged: () => void;
  onClose: () => void;
}) {
  const [ack1, setAck1] = useState(false);
  const [ack2, setAck2] = useState(false);
  const [ack3, setAck3] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const allAck = ack1 && ack2 && ack3;

  async function handleContinue() {
    if (!allAck) return;
    setBusy(true);
    setErr(null);
    try {
      await trpc.ackPcDisclaimer.mutate();
      onAcknowledged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // Escape-to-close for keyboard users.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  return (
    <div
      className="ch-bottomSheet-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="ch-bottomSheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pc-disclaimer-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="ch-bottomSheet-head">
          <span id="pc-disclaimer-title" className="ch-bottomSheet-title">
            <Lock size={16} />
            before you send hidden - read this
          </span>
          <button
            type="button"
            onClick={onClose}
            className="ch-bottomSheet-close"
            aria-label="close"
          >
            <X size={14} />
          </button>
        </div>

        <div className="sp-prealphaPill" style={{ marginBottom: 12 }}>
          <AlertTriangle size={10} />
          encrypt.xyz pre-alpha · pc-token · dev preview only
        </div>

        <p className="sp-muted" style={{ fontSize: 12, marginTop: 0 }}>
          PC-Token hides the <strong>amount</strong> and the <strong>recipient pcToken account</strong> on-chain. It
          does NOT hide your sender wallet, and it does not give you anonymity. Read all three
          before continuing — these limitations are real and matter:
        </p>

        <Check
          checked={ack1}
          onChange={setAck1}
          label="my sender wallet is still visible"
          body="anyone watching my solana address sees that I sent something via pc-token. only the amount and the recipient's pcToken account are hidden in the on-chain ix data."
        />

        <Check
          checked={ack2}
          onChange={setAck2}
          label="repeat sends are correlatable"
          body="pcToken accounts are deterministic per (mint, owner). the same Alice → Bob pair shows up at the same on-chain TokenAccount PDA every time, even though the ciphertext inside changes. an observer correlating ciphertext-account writes can see who I send to repeatedly."
        />

        <Check
          checked={ack3}
          onChange={setAck3}
          label="encrypt.xyz pre-alpha = single mock executor"
          body="ciphertexts may be plaintext on devnet during testing. this is integration-shape, not production privacy. do NOT use this for real-value transfers. mainnet alpha is the cutover — until then, treat pcToken sends like throwaway dev demos."
        />

        {err && (
          <div className="sp-error" style={{ marginTop: 8 }}>
            {err}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button
            type="button"
            onClick={() => void handleContinue()}
            disabled={!allAck || busy}
            className="sp-btn sp-btn--primary"
          >
            {busy ? (
              <>
                <Loader2 size={12} className="sp-spin" /> saving…
              </>
            ) : (
              'I understand, continue'
            )}
          </button>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="sp-btn"
          >
            cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function Check({
  checked,
  onChange,
  label,
  body,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  body: string;
}) {
  return (
    <label
      style={{
        display: 'flex',
        gap: 8,
        alignItems: 'flex-start',
        marginBottom: 10,
        cursor: 'pointer',
        fontSize: 12,
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ marginTop: 2, flexShrink: 0 }}
      />
      <span style={{ flex: 1 }}>
        <strong>{label}</strong>
        <span className="sp-muted" style={{ display: 'block', fontSize: 11, marginTop: 2, lineHeight: 1.4 }}>
          {body}
        </span>
      </span>
    </label>
  );
}
