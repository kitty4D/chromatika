/**
 * Home-screen prompt that appears inside the empty-state slot of WalletPage when
 * a funded vault has zero dWallets. Lets the user create their first dWallet for
 * one of two chain groups in a single click, or dismiss the prompt for this vault
 * (in which case WalletPage falls back to the existing single "Create a dWallet"
 * button that opens dWallet management).
 *
 * - SECP256K1 dWallet covers BTC + EVM (and DeSo).
 * - ED25519 dWallet covers Sui + Solana + Aptos.
 *
 * Renders WITHOUT an outer `cv-dwalletsEmpty` wrapper - the parent WalletPage already
 * provides one. Keeps the empty-state container DOM exactly one level deep regardless
 * of which branch (prompt vs fallback button) renders.
 */

import { useEffect, useState } from 'react';
import { trpc } from '@/lib/trpc';

type Curve = 'SECP256K1' | 'ED25519';
type BusyKind = Curve | 'dismiss' | null;

export function CreateDwalletPrompt({
  onCreated,
  onDismissed,
  onError,
}: {
  /** called after a successful DKG. Receives the curve so the parent can branch
   *  follow-up flows (e.g. the post-creation Policy Vault prompt fires only for SECP256K1). */
  onCreated: (curve: Curve) => void;
  /** called after the user picks "I'll do this manually later" so the parent swaps to the fallback button. */
  onDismissed: () => void;
  /** surfaces a DKG error string to the parent (mirrors capsErr in WalletPage). */
  onError: (msg: string) => void;
}) {
  const [busy, setBusy] = useState<BusyKind>(null);
  /** if checked when the user taps "I'll do this manually later", we also persist the
   *  global "don't show on any vault" flag in addition to the existing per-vault dismissal. */
  const [dontAskAnyVault, setDontAskAnyVault] = useState(false);

  async function runCreate(curve: Curve) {
    if (busy) return;
    setBusy(curve);
    try {
      await trpc.createDWallet.mutate({ curve });
      onCreated(curve);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function runDismiss() {
    if (busy) return;
    setBusy('dismiss');
    try {
      if (dontAskAnyVault) {
        // best-effort: if the global persist fails, fall through to the per-vault one
        // so the user still sees the prompt go away on this vault.
        try {
          await trpc.setDwalletCreatePromptGloballyDismissed.mutate({ dismissed: true });
        } catch {
          /* ignore; per-vault dismiss below still covers this vault */
        }
      }
      await trpc.dismissDWalletCreatePrompt.mutate();
    } catch {
      // even if the persist fails, hide locally so the user isn't stuck on a stale prompt;
      // next mount will re-show, which is acceptable.
    } finally {
      setBusy(null);
      onDismissed();
    }
  }

  return (
    <>
      <p className="cv-dwalletsEmpty-title">Create your first dWallets?</p>
      <p className="cv-dwalletsEmpty-text">
        Your vault is funded. Pick the chains you want to start with - one dWallet covers all
        chains in its group. You can add the other group anytime later.
      </p>
      <div
        role="group"
        aria-label="Create your first dWallets"
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          marginTop: 12,
          width: '100%',
        }}
      >
        <button
          type="button"
          className="sp-btn sp-btnPrimary cv-dwalletsEmpty-btn"
          disabled={busy !== null}
          onClick={() => void runCreate('SECP256K1')}
        >
          {busy === 'SECP256K1'
            ? 'Creating BTC + EVM dWallet…'
            : 'Create a dWallet for Bitcoin and Ethereum/EVM'}
        </button>
        <button
          type="button"
          className="sp-btn sp-btnPrimary cv-dwalletsEmpty-btn"
          disabled={busy !== null}
          onClick={() => void runCreate('ED25519')}
        >
          {busy === 'ED25519'
            ? 'Creating Sol + Sui + Aptos dWallet…'
            : 'Create a dWallet for Solana, Sui, and Aptos'}
        </button>
        <label
          style={{
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            fontSize: 11,
            cursor: busy ? 'wait' : 'pointer',
            opacity: busy ? 0.6 : 0.85,
            marginTop: 4,
          }}
        >
          <input
            type="checkbox"
            checked={dontAskAnyVault}
            onChange={(e) => setDontAskAnyVault(e.target.checked)}
            disabled={busy !== null}
            style={{ flexShrink: 0 }}
          />
          <span>Don't show this on any vault</span>
        </label>
        <button
          type="button"
          className="sp-btn cv-dwalletsEmpty-btn"
          disabled={busy !== null}
          onClick={() => void runDismiss()}
        >
          {busy === 'dismiss' ? 'Saving…' : "I'll do this manually later"}
        </button>
      </div>
    </>
  );
}

/**
 * Parent-side hook for the active vault's dismissal state.
 *
 * Returns `dismissed === null` while the round-trip is in flight; the parent should treat
 * `null` as "do not show the 3-option prompt yet" so we don't briefly flash it for a user
 * who has already dismissed. Pass `enabled=false` to skip the query (e.g. when the vault
 * isn't funded or already has dWallets).
 */
export function useDWalletCreatePromptState(enabled: boolean): {
  dismissed: boolean | null;
  setLocallyDismissed: () => void;
} {
  const [dismissed, setDismissed] = useState<boolean | null>(null);

  useEffect(() => {
    if (!enabled) {
      setDismissed(null);
      return;
    }
    let cancelled = false;
    void trpc.getDWalletCreatePromptState
      .query()
      .then((r) => {
        if (!cancelled) setDismissed(r.dismissed);
      })
      .catch(() => {
        // fail-open: show the prompt rather than silently hide it.
        if (!cancelled) setDismissed(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return {
    dismissed,
    setLocallyDismissed: () => setDismissed(true),
  };
}
