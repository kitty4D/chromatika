/**
 * paste-an-id dialog for the leaderboard. validates basic Sui object shape on the
 * client; full validation happens server-side via the tRPC mutation.
 */

import { useState } from 'react';
import { trpc } from '@/lib/trpc';

export function AddManualDWalletDialog({
  onCancel,
  onAdded,
}: {
  onCancel: () => void;
  onAdded: () => void;
}) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = value.trim();
  const looksValid = trimmed.startsWith('0x') && trimmed.length === 66;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!looksValid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await trpc.leaderboardAddManualId.mutate({ dwalletId: trimmed });
      onAdded();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="leaderboard-add-title"
      className="sp-modalOverlay"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.6)',
        zIndex: 100,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
    >
      <form
        onSubmit={onSubmit}
        className="sp-modal"
        style={{
          maxWidth: 420,
          width: '100%',
          background: 'var(--ch-surface, #16181c)',
          borderRadius: 14,
          padding: 18,
          border: '1px solid rgba(234,240,255,0.06)',
        }}
      >
        <h3 id="leaderboard-add-title" style={{ margin: '0 0 8px 0', fontSize: 14 }}>
          track a dWallet id
        </h3>
        <p className="sp-muted" style={{ fontSize: 11, lineHeight: 1.5, margin: '0 0 10px 0' }}>
          paste an ika dWallet object id from Sui (<code>0x</code> + 64 hex chars). it joins the
          leaderboard immediately and probes per-chain USD on the next refresh.
        </p>
        <label className="sp-muted" style={{ fontSize: 11, display: 'block' }}>
          dWallet id
        </label>
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="0x..."
          spellCheck={false}
          autoComplete="off"
          className="sp-input"
          style={{ width: '100%', fontFamily: 'var(--ch-font-mono, monospace)', marginTop: 4 }}
        />
        {value.length > 0 && !looksValid && (
          <small className="sp-muted" style={{ fontSize: 10, color: 'rgba(255,196,86,0.95)' }}>
            expected 0x followed by 64 hex chars (66 total)
          </small>
        )}
        {error && (
          <small className="sp-muted" style={{ fontSize: 10, color: 'rgba(248,113,113,0.95)' }}>
            {error}
          </small>
        )}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
          <button type="button" className="sp-btn" onClick={onCancel} disabled={busy}>
            cancel
          </button>
          <button
            type="submit"
            className="sp-btn sp-btnPrimary"
            disabled={!looksValid || busy}
            aria-busy={busy}
          >
            {busy ? 'adding…' : 'add'}
          </button>
        </div>
      </form>
    </div>
  );
}
