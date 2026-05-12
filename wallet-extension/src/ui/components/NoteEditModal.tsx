/**
 * NoteEditModal - encrypt / decrypt / remove an activity note for a given tx hash.
 *
 * three states the modal can be in when it opens:
 *   - no note yet: shows a textarea, "encrypt + save" button.
 *   - note exists, locked: shows "decrypt to view" + "remove" buttons.
 *   - note exists, decrypted: shows the plaintext + "edit" + "remove" buttons.
 *
 * decrypt is a real ika MPC sign + 2x encrypt.xyz `ReadCiphertext` round-trip (one per K chunk).
 * expect ~1-3 seconds on devnet, the modal shows a spinner during decrypt to reassure the user
 * it's working, not stuck.
 *
 * the pre-alpha disclaimer pill is mandatory per CLAUDE.md identity-model rules: encrypt.xyz
 * pre-alpha can store plaintext on-chain in the mock executor. never present this as
 * production-grade secret storage.
 */

import { useState, useEffect, useCallback } from 'react';
import { Lock, LockOpen, Trash2, Loader2, AlertTriangle } from 'lucide-react';
import { trpc } from '@/lib/trpc';

const NOTE_MAX_BYTES = 2048;

function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

type NoteStatus = Awaited<ReturnType<typeof trpc.getActivityNoteStatus.query>>;

export function NoteEditModal({
  txHash,
  txLabel,
  onClose,
  onChanged,
}: {
  txHash: string;
  txLabel?: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [status, setStatus] = useState<NoteStatus | null>(null);
  const [draft, setDraft] = useState('');
  const [decrypted, setDecrypted] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<'idle' | 'loading' | 'encrypting' | 'decrypting' | 'removing'>('idle');
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setBusy('loading');
    setErr(null);
    try {
      const s = await trpc.getActivityNoteStatus.query({ txHash });
      setStatus(s);
      // if there's no record we shouldn't have opened the modal in the first place; surface a
      // clean error so the user can close and try again on a tx the wallet actually signed.
      if (!s.hasRecord) {
        setErr('no local record for this tx - notes can only be attached to txs chromatika signed');
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('idle');
    }
  }, [txHash]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleEncrypt() {
    if (!draft.trim()) {
      setErr('note cannot be empty');
      return;
    }
    if (utf8ByteLength(draft) > NOTE_MAX_BYTES) {
      setErr(`note utf-8 length ${utf8ByteLength(draft)} exceeds cap ${NOTE_MAX_BYTES}`);
      return;
    }
    setBusy('encrypting');
    setErr(null);
    try {
      await trpc.encryptActivityNote.mutate({ txHash, plaintext: draft });
      setDecrypted(draft);
      setDraft('');
      setEditing(false);
      onChanged();
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('idle');
    }
  }

  async function handleDecrypt() {
    setBusy('decrypting');
    setErr(null);
    try {
      const res = await trpc.decryptActivityNote.mutate({ txHash });
      if (res.status === 'ok' && res.plaintext != null) {
        setDecrypted(res.plaintext);
      } else if (res.status === 'error') {
        // structured error from EncryptionBackend - render specific copy per reason
        if (res.errorReason === 'wrong-vault') {
          setErr('this note was encrypted by a different vault on this install. switch vaults to decrypt.');
        } else if (res.errorReason === 'devnet-wipe') {
          setErr('encrypted note from a previous devnet generation - the ciphertext no longer exists on-chain. remove and re-attach.');
        } else {
          setErr(res.errorMessage ?? 'decrypt failed');
        }
      } else {
        setErr('no note attached');
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('idle');
    }
  }

  async function handleRemove() {
    setBusy('removing');
    setErr(null);
    try {
      await trpc.removeActivityNote.mutate({ txHash });
      setDecrypted(null);
      setDraft('');
      setEditing(false);
      onChanged();
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('idle');
    }
  }

  function handleStartEdit() {
    setDraft(decrypted ?? '');
    setEditing(true);
    setDecrypted(null);
  }

  // Escape-to-close for keyboard users (WCAG 2.4.3 focus order + standard dialog behavior).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && busy === 'idle') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  const hasNote = status?.hasNote === true;
  const hasRecord = status?.hasRecord === true;

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
        aria-labelledby="note-edit-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="ch-bottomSheet-head">
          <span id="note-edit-modal-title" className="ch-bottomSheet-title">
            <Lock size={16} />
            encrypted activity note
          </span>
          <button
            type="button"
            onClick={onClose}
            className="ch-bottomSheet-close"
            aria-label="close"
          >
            ×
          </button>
        </div>

        <div className="sp-muted" style={{ fontSize: 11, marginBottom: 8, fontFamily: 'var(--theme-font-mono, ui-monospace, monospace)' }}>
          tx: {txLabel ?? txHash.slice(0, 10) + '…' + txHash.slice(-6)}
        </div>

        <div className="sp-prealphaPill" style={{ marginBottom: 12 }}>
          <AlertTriangle size={10} />
          encrypt.xyz pre-alpha · dev preview
        </div>

        {err && (
          <div className="sp-error" style={{ marginBottom: 8 }}>
            {err}
          </div>
        )}

        {busy === 'loading' && (
          <div className="sp-muted">
            <Loader2 className="sp-spin" size={14} /> loading…
          </div>
        )}

        {/* no note yet, or user clicked edit */}
        {hasRecord && (!hasNote || editing) && (
          <div>
            <textarea
              className="sp-input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="paid alice for rent…"
              rows={4}
              maxLength={NOTE_MAX_BYTES * 2 /* allow utf-8 multibyte; backend caps utf8Len */}
              style={{ width: '100%', resize: 'vertical', minHeight: 80 }}
              disabled={busy !== 'idle'}
            />
            <div className="sp-muted" style={{ fontSize: 10, marginTop: 4 }}>
              {utf8ByteLength(draft)} / {NOTE_MAX_BYTES} utf-8 bytes
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button
                type="button"
                onClick={handleEncrypt}
                disabled={busy !== 'idle' || !draft.trim()}
                className="sp-btn sp-btn--primary"
              >
                {busy === 'encrypting' ? (
                  <>
                    <Loader2 className="sp-spin" size={12} /> encrypting…
                  </>
                ) : (
                  <>
                    <Lock size={12} /> encrypt + save
                  </>
                )}
              </button>
              {hasNote && (
                <button
                  type="button"
                  onClick={() => {
                    setEditing(false);
                    setDraft('');
                  }}
                  disabled={busy !== 'idle'}
                  className="sp-btn"
                >
                  cancel
                </button>
              )}
            </div>
          </div>
        )}

        {/* note exists, not yet decrypted */}
        {hasRecord && hasNote && !editing && decrypted === null && (
          <div>
            <div className="sp-muted" style={{ marginBottom: 8 }}>
              an encrypted note is attached to this tx. unlocking requires an ika dWallet ed25519
              signature (~1-3 seconds on devnet).
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                onClick={handleDecrypt}
                disabled={busy !== 'idle'}
                className="sp-btn sp-btn--primary"
              >
                {busy === 'decrypting' ? (
                  <>
                    <Loader2 className="sp-spin" size={12} /> decrypting…
                  </>
                ) : (
                  <>
                    <LockOpen size={12} /> decrypt to view
                  </>
                )}
              </button>
              <button
                type="button"
                onClick={handleRemove}
                disabled={busy !== 'idle'}
                className="sp-btn sp-btn--danger"
              >
                {busy === 'removing' ? (
                  <>
                    <Loader2 className="sp-spin" size={12} /> removing…
                  </>
                ) : (
                  <>
                    <Trash2 size={12} /> remove
                  </>
                )}
              </button>
            </div>
          </div>
        )}

        {/* note exists, decrypted */}
        {hasRecord && hasNote && !editing && decrypted !== null && (
          <div>
            <div
              style={{
                whiteSpace: 'pre-wrap',
                background: 'rgba(255,255,255,0.05)',
                padding: 10,
                borderRadius: 4,
                marginBottom: 10,
                fontSize: 13,
              }}
            >
              {decrypted}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                onClick={handleStartEdit}
                disabled={busy !== 'idle'}
                className="sp-btn"
              >
                edit
              </button>
              <button
                type="button"
                onClick={handleRemove}
                disabled={busy !== 'idle'}
                className="sp-btn sp-btn--danger"
              >
                <Trash2 size={12} /> remove
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
