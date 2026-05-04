import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, CircleAlert, Lock, LockOpen, RotateCcw } from 'lucide-react';
import { trpc } from '@/lib/trpc';

type Curve = 'SECP256K1' | 'ED25519';

type LabelStatus = Awaited<ReturnType<typeof trpc.getDwalletLabelStatus.query>>;
type OnChainStatus = Awaited<ReturnType<typeof trpc.getDwalletLabelOnChainStatus.query>>;

function relTimeMs(ms: number): string {
  const delta = Date.now() - ms;
  if (delta < 60_000) return 'just now';
  const m = Math.floor(delta / 60_000);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * win 1 (labels-via-encrypt) - per-dWallet encrypted label widget.
 *
 * lab-grade pre-alpha. the Encrypt program disclaimer says ciphertexts can be plaintext on-chain
 * in pre-alpha; never store real secrets here. this widget only renders when the active vault is
 * on Solana ika base (the encrypt program is Solana-only).
 *
 * UX:
 *   - no label set: input + "encrypt label" button. v1 cap is 16 utf-8 bytes (one EUint128).
 *   - label set, hidden: shows when it was set + "reveal" + "clear" buttons.
 *   - label set, revealed: shows the decoded utf-8 label + "hide" button.
 *
 * reveal goes through `signMessageSol` over a ReadCiphertext message, same path the existing
 * lab uses; nothing about this is dWallet-curve-specific (the `curve` prop just keys the meta
 * overlay so each dWallet on a vault can carry its own label).
 */
export function DwalletEncryptedLabel({ curve }: { curve: Curve }) {
  const [status, setStatus] = useState<LabelStatus | null>(null);
  const [onChainStatus, setOnChainStatus] = useState<OnChainStatus | null>(null);
  const [draft, setDraft] = useState('');
  const [revealed, setRevealed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [autoRebuild, setAutoRebuild] = useState<boolean>(false);
  const [autoRebuiltAtMs, setAutoRebuiltAtMs] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await trpc.getDwalletLabelStatus.query({ curve });
      setStatus(s);
      // background-refresh on-chain status when we have a label; ignore errors silently
      // (e.g. devnet RPC blip - we still show the local 'set N min ago' line).
      if (s.hasLabel && s.enabledForSession) {
        try {
          const oc = await trpc.getDwalletLabelOnChainStatus.query({ curve });
          setOnChainStatus(oc);
        } catch {
          setOnChainStatus(null);
        }
      } else {
        setOnChainStatus(null);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [curve]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // read the auto-rebuild toggle once on mount; refresh on widget remount.
  useEffect(() => {
    void trpc.getEncryptedLabelAutoRebuildEnabled
      .query()
      .then((r) => setAutoRebuild(r.enabled))
      .catch(() => setAutoRebuild(false));
  }, []);

  // auto-rebuild trigger: when the on-chain poll surfaces `missing` (devnet wipe) AND
  // the user has the toggle on, fire the rebuild flow exactly once per "missing" run.
  useEffect(() => {
    if (!autoRebuild) return;
    if (onChainStatus?.status !== 'missing') return;
    if (busy) return;
    let cancelled = false;
    (async () => {
      setBusy(true);
      setErr(null);
      try {
        const r = await trpc.rebuildDwalletLabelAfterDevnetWipe.mutate({ curve });
        if (cancelled) return;
        setAutoRebuiltAtMs(r.rebuiltAtMs);
        await refresh();
      } catch (e) {
        if (cancelled) return;
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [autoRebuild, onChainStatus?.status, busy, curve, refresh]);

  // hide reveal when curve switches under us (e.g. user navigates between dWallet cards).
  useEffect(() => {
    setRevealed(null);
    setDraft('');
    setErr(null);
  }, [curve]);

  // poll on-chain status every 4s while the label exists - cheap and tells the user
  // when devnet wipes (status: 'missing'), or in the rare case the executor is mid-commit.
  useEffect(() => {
    if (!status?.hasLabel || !status.enabledForSession) return;
    const t = window.setInterval(() => {
      void trpc.getDwalletLabelOnChainStatus
        .query({ curve })
        .then(setOnChainStatus)
        .catch(() => {});
    }, 4000);
    return () => window.clearInterval(t);
  }, [curve, status?.hasLabel, status?.enabledForSession]);

  if (!status) return null;
  if (!status.enabledForSession) return null;

  const maxUtf8 = status.maxUtf8Bytes;
  const draftBytes = utf8ByteLength(draft);
  const draftTooLong = draftBytes > maxUtf8;

  async function onEncrypt() {
    if (!draft.trim() || draftTooLong) return;
    setBusy(true);
    setErr(null);
    try {
      await trpc.encryptDwalletLabel.mutate({ curve, label: draft });
      setDraft('');
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onReveal() {
    setBusy(true);
    setErr(null);
    try {
      const r = await trpc.revealDwalletLabel.mutate({ curve });
      setRevealed(r.label);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onClear() {
    setBusy(true);
    setErr(null);
    try {
      await trpc.clearDwalletLabel.mutate({ curve });
      setRevealed(null);
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onRebuild() {
    setBusy(true);
    setErr(null);
    try {
      const r = await trpc.rebuildDwalletLabelAfterDevnetWipe.mutate({ curve });
      setAutoRebuiltAtMs(r.rebuiltAtMs);
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onToggleAutoRebuild(next: boolean) {
    try {
      await trpc.setEncryptedLabelAutoRebuildEnabled.mutate({ enabled: next });
      setAutoRebuild(next);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="cd-encLabel">
      <div className="cd-encLabel-head">
        <span className="cd-encLabel-title">encrypted label</span>
        <span className="cd-encLabel-badge" title="encrypt program is pre-alpha; ciphertexts can be plaintext on-chain. devnet only.">
          lab-grade pre-alpha
        </span>
      </div>

      {!status.hasLabel && (
        <div className="cd-encLabel-row">
          <input
            className="sp-input cd-encLabel-input"
            placeholder={`label (≤${maxUtf8} utf-8 bytes)`}
            value={draft}
            maxLength={maxUtf8 * 2}
            onChange={(e) => setDraft(e.target.value)}
            disabled={busy}
          />
          <button
            type="button"
            className="sp-btn"
            onClick={() => void onEncrypt()}
            disabled={busy || !draft.trim() || draftTooLong}
            title={draftTooLong ? `utf-8 length ${draftBytes} exceeds cap of ${maxUtf8}` : 'encrypt and persist'}
          >
            <Lock size={12} style={{ marginRight: 4 }} />
            {busy ? 'encrypting…' : 'encrypt'}
          </button>
        </div>
      )}

      {status.hasLabel && (
        <div className="cd-encLabel-row">
          <div className="cd-encLabel-state">
            {revealed != null ? (
              <span className="cd-encLabel-revealed" title="utf-8 decoded from ReadCiphertext">
                {revealed}
              </span>
            ) : (
              <span className="cd-encLabel-hidden">● ●●● enc</span>
            )}
            {status.createdAtMs && (
              <span className="cd-encLabel-meta sp-muted">set {relTimeMs(status.createdAtMs)}</span>
            )}
            {status.chunkCount != null && status.chunkCount > 1 && (
              <span className="cd-encLabel-meta sp-muted">{status.chunkCount} chunks</span>
            )}
            <OnChainStatusPill onChainStatus={onChainStatus} />
            {autoRebuiltAtMs && (
              <span className="cd-encLabel-meta sp-muted" title="auto-rebuild ran after devnet wipe; identifiers rotated locally">
                rebuilt {relTimeMs(autoRebuiltAtMs)}
              </span>
            )}
          </div>
          <div className="cd-encLabel-actions">
            {revealed != null ? (
              <button type="button" className="sp-btn" onClick={() => setRevealed(null)} disabled={busy}>
                hide
              </button>
            ) : onChainStatus?.status === 'missing' ? (
              <button
                type="button"
                className="sp-btn"
                onClick={() => void onRebuild()}
                disabled={busy}
                title="re-encrypt the same plaintext (cached locally) and rotate identifiers; only available when auto-rebuild was on at encrypt time"
              >
                <RotateCcw size={12} style={{ marginRight: 4 }} />
                {busy ? 'rebuilding…' : 'rebuild'}
              </button>
            ) : (
              <button type="button" className="sp-btn" onClick={() => void onReveal()} disabled={busy}>
                <LockOpen size={12} style={{ marginRight: 4 }} />
                {busy ? 'revealing…' : 'reveal'}
              </button>
            )}
            <button type="button" className="sp-btn cd-encLabel-clear" onClick={() => void onClear()} disabled={busy} title="forget local pointer; on-chain ciphertext stays until devnet wipe">
              <RotateCcw size={12} style={{ marginRight: 4 }} />
              clear
            </button>
          </div>
        </div>
      )}

      {/* auto-rebuild toggle: visible when there IS a label or when the user is composing a new one */}
      <div className="cd-encLabel-row" style={{ alignItems: 'center', gap: 6, marginTop: 4 }}>
        <label
          className="sp-muted"
          style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, cursor: 'pointer' }}
          title="When ON, the plaintext is cached locally so a devnet wipe can be auto-recovered without prompting. Lab-grade pre-alpha labels are not for secrets, so this is consistent with the existing security boundary."
        >
          <input
            type="checkbox"
            checked={autoRebuild}
            onChange={(e) => void onToggleAutoRebuild(e.target.checked)}
            disabled={busy}
          />
          auto-rebuild after devnet wipe (caches plaintext locally)
        </label>
      </div>

      {draftTooLong && !status.hasLabel && (
        <div className="cd-encLabel-msg sp-muted">
          utf-8 length {draftBytes} exceeds the cap of {maxUtf8} bytes ({Math.ceil(maxUtf8 / 16)} EUint128 chunks).
        </div>
      )}
      {err && <div className="cd-encLabel-msg cd-encLabel-err">{err}</div>}
    </div>
  );
}

function OnChainStatusPill({ onChainStatus }: { onChainStatus: OnChainStatus | null }) {
  if (!onChainStatus) return null;
  if (onChainStatus.status === 'verified') {
    return (
      <span className="cd-encLabel-pillOk" title="ciphertext account exists on-chain with status=Verified">
        <CheckCircle2 size={10} style={{ verticalAlign: -1, marginRight: 3 }} />
        verified
      </span>
    );
  }
  if (onChainStatus.status === 'pending') {
    return (
      <span className="cd-encLabel-pillPending" title="ciphertext account exists, status byte = 0 (executor still committing)">
        encrypting…
      </span>
    );
  }
  if (onChainStatus.status === 'missing') {
    return (
      <span className="cd-encLabel-pillMissing" title="ciphertext account not found on-chain - likely a devnet wipe">
        <CircleAlert size={10} style={{ verticalAlign: -1, marginRight: 3 }} />
        missing on-chain
      </span>
    );
  }
  return null;
}
