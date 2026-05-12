/**
 * Bottom-sheet modal that surfaces immediately after a dWallet DKG resolves on a
 * Sui-base vault. Offers a one-click wrap into the chromatika Policy Vault using
 * documented defaults, a "Customize first" deep-link to Settings, and a "Not now" close.
 *
 * Curve-aware copy: both SECP256K1 and ED25519 dWallets are wrappable. The cap /
 * cooldown / panic gates apply uniformly. For SECP-signed chains (BTC / EVM / DeSo)
 * the gate is enforced against chain-derived values from `sign_gate_evm` / `sign_gate_btc`
 * / `sign_gate_deso` decoders. For ED25519-signed chains (Sui PTB / Solana ix /
 * Aptos move calls) the gate is enforced against chromatika's caller-declared value
 * only, until on-chain decoders for those tx formats ship. The body copy spells out
 * which protection the user is signing up for so they understand what they get.
 *
 * "Don't ask me again on any new dWallet" persists `chromatika_policy_vault_prompt_
 * globally_dismissed_v1`; setting it true suppresses the modal for every future
 * dWallet creation on every vault until the user re-enables in Settings -> Safety.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Check as CheckIcon,
  Loader2,
  Settings as SettingsIcon,
  ShieldCheck,
  Timer,
  X,
} from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { microsToUsd, fmtMsVerbose } from './policy-vault-format';

// Default opt-in parameters - kept in lockstep with `PolicyVaultPanel`'s DEFAULT_OPTIN.
const DEFAULT_OPTIN = {
  dailyCapUsd: '1000',
  coolDownSec: '60',
  unfreezeDelayDays: '7',
  stageDelayHours: '24',
  rescueAddress: '',
  initialIkaMist: '10000000', // 0.01 IKA
  initialSuiMist: '10000000', // 0.01 SUI
} as const;

type Curve = 'SECP256K1' | 'ED25519';

/** Trim 0.0100 -> "0.01"; preserves leading zero and significant digits. */
function fmtMistShort(mistStr: string): string {
  try {
    const n = Number(BigInt(mistStr)) / 1e9;
    return n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  } catch {
    return mistStr;
  }
}

export function PostCreatePolicyVaultPrompt({
  curve,
  onClose,
  onWrapped,
  onCustomize,
}: {
  /** Which curve dWallet was just created. Drives the curve-aware body copy and
   *  the wrap-tx curve / signatureAlgorithm fields. */
  curve: Curve;
  /** Called for any "back out" path: X button, backdrop click, Escape, or "Not now". */
  onClose: () => void;
  /** Called after the one-click `optInToPolicyVault` mutation succeeds. */
  onWrapped: () => void;
  /** Called when the user picks "Customize first" or "what does each setting mean?". */
  onCustomize: () => void;
}) {
  const [busy, setBusy] = useState<'wrap' | 'success' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [dontAskAgain, setDontAskAgain] = useState(false);

  // Reduced-motion users skip the post-wrap success-hold; everything else just
  // animates differently via CSS-side @media query.
  const prefersReducedMotion =
    typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const persistDontAskIfChecked = useCallback(async () => {
    if (!dontAskAgain) return;
    try {
      await trpc.setPolicyVaultPromptGloballyDismissed.mutate({ dismissed: true });
    } catch {
      // silent: close path proceeds regardless.
    }
  }, [dontAskAgain]);

  const close = useCallback(async () => {
    if (busy) return;
    await persistDontAskIfChecked();
    onClose();
  }, [busy, onClose, persistDontAskIfChecked]);

  const customize = useCallback(async () => {
    if (busy) return;
    await persistDontAskIfChecked();
    onCustomize();
  }, [busy, onCustomize, persistDontAskIfChecked]);

  async function handleWrap() {
    if (busy) return;
    setBusy('wrap');
    setErr(null);
    try {
      const dailyCapMicros = (BigInt(DEFAULT_OPTIN.dailyCapUsd) * 1_000_000n).toString();
      const coolDownMs = (BigInt(DEFAULT_OPTIN.coolDownSec) * 1_000n).toString();
      const unfreezeDelayMs = (BigInt(DEFAULT_OPTIN.unfreezeDelayDays) * 86_400_000n).toString();
      const stageDelayMs = (BigInt(DEFAULT_OPTIN.stageDelayHours) * 3_600_000n).toString();
      await trpc.optInToPolicyVault.mutate({
        curve,
        dailyCapMicros,
        coolDownMs,
        unfreezeDelayMs,
        stageDelayMs,
        rescueAddress: undefined,
        initialIkaMist: DEFAULT_OPTIN.initialIkaMist,
        initialSuiMist: DEFAULT_OPTIN.initialSuiMist,
      });
      await persistDontAskIfChecked();
      // Success choreography: hold the checkmark for a beat so the user gets
      // visual closure on their decision before the modal dissolves. Reduced-
      // motion users skip the hold entirely.
      if (prefersReducedMotion) {
        onWrapped();
      } else {
        setBusy('success');
        window.setTimeout(() => onWrapped(), 420);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) void close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close, busy]);

  // Curve-aware lead paragraph. Both curves share the cap / cooldown / panic
  // explanation; they diverge on which enforcement layer applies to the chains
  // the dWallet signs for.
  const enforcementBlurb =
    curve === 'SECP256K1' ? (
      <>
        On <strong>BTC, EVM, and DeSo</strong> sends, the daily cap is enforced against the
        actual value the wallet is about to authorize, decoded from the on-chain
        transaction itself. A lying caller cannot bypass it.
      </>
    ) : (
      <>
        On <strong>Sui, Solana, and Aptos</strong> sends, the daily cap is enforced against
        the USD value chromatika reports for the transaction. Hard on-chain decoding for
        these tx formats is not yet implemented, so the cap is soft today on those
        chains. Panic and cooldown still apply uniformly.
      </>
    );

  return (
    <div
      className="ch-bottomSheet-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) void close();
      }}
    >
      <div
        className="ch-bottomSheet postpv-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="post-create-pv-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="ch-bottomSheet-head">
          <span id="post-create-pv-title" className="ch-bottomSheet-title">
            <span className="postpv-title-icon">
              <ShieldCheck size={16} />
            </span>
            wrap this dWallet with Policy Vault?
          </span>
          <button
            type="button"
            onClick={() => void close()}
            className="ch-bottomSheet-close"
            aria-label="close"
            disabled={busy !== null}
          >
            <X size={14} />
          </button>
        </div>

        <p className="sp-muted" style={{ fontSize: 12, marginTop: 0, lineHeight: 1.5 }}>
          Your new dWallet can be wrapped in chromatika&apos;s on-chain Policy Vault. Every
          signature then goes through a shared Move object that enforces a{' '}
          <strong>daily USD cap</strong>, a <strong>cooldown between sends</strong>, and a{' '}
          <strong>panic flag</strong> any actuator can flip on. {enforcementBlurb} You can
          turn the policy off at any time by requesting to unwrap. The unwrap always
          completes after the staged-change delay (1 day default), so a stolen key can
          never bypass the gate immediately.
        </p>

        <div
          style={{
            border: '1px solid var(--ch-border-subtle, rgba(255,255,255,0.08))',
            borderRadius: 6,
            padding: 10,
            marginTop: 10,
            background: 'rgba(255,255,255,0.02)',
          }}
        >
          <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 6, opacity: 0.9 }}>
            if you accept, these defaults apply
          </div>
          <DefaultRow
            index={0}
            label="daily cap"
            value={`$${microsToUsd((BigInt(DEFAULT_OPTIN.dailyCapUsd) * 1_000_000n).toString())}`}
          />
          <DefaultRow
            index={1}
            label="cooldown between sends"
            value={fmtMsVerbose(Number(DEFAULT_OPTIN.coolDownSec) * 1000)}
          />
          <DefaultRow
            index={2}
            label="panic + unfreeze delay"
            value={fmtMsVerbose(Number(DEFAULT_OPTIN.unfreezeDelayDays) * 86_400_000)}
            hint="time between hitting panic and being able to unfreeze"
          />
          <DefaultRow
            index={3}
            label="staged-change + unwrap delay"
            value={fmtMsVerbose(Number(DEFAULT_OPTIN.stageDelayHours) * 3_600_000)}
            hint="also how long unwrap takes (see below)"
          />
          <DefaultRow
            index={4}
            label="initial fund"
            value={`${fmtMistShort(DEFAULT_OPTIN.initialIkaMist)} $IKA + ${fmtMistShort(DEFAULT_OPTIN.initialSuiMist)} $SUI`}
          />
          <DefaultRow index={5} label="rescue address" value="none (set later in Settings)" />
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 8,
            marginTop: 12,
            padding: 10,
            border: '1px solid rgba(255,196,77,0.25)',
            borderRadius: 6,
            background: 'rgba(255,196,77,0.06)',
            fontSize: 11,
            lineHeight: 1.5,
          }}
        >
          <Timer size={14} style={{ flexShrink: 0, marginTop: 2, color: '#ffc44d' }} />
          <span>
            <strong>how to turn it off:</strong> the Policy Vault is always reversible.
            Request to unwrap from Settings &rarr; Security &rarr; Policy Vault, wait the
            staged-change delay (1 day default), then claim. The dWallet&apos;s signing cap
            is returned to your vault and the policy is gone. The wait is mandatory; it
            is the security feature, not a bug. Both the wrap and unwrap delays are
            configurable before opt-in via &quot;customize first&quot;.
          </span>
        </div>

        {err && (
          <div className="sp-error" style={{ marginTop: 10, fontSize: 11 }}>
            <AlertTriangle size={11} /> {err}
          </div>
        )}

        <div
          style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 14 }}
          role="group"
          aria-label="Policy Vault wrap options"
        >
          <button
            type="button"
            onClick={() => void handleWrap()}
            disabled={busy !== null}
            className={`sp-btn sp-btnPrimary${busy === 'success' ? ' postpv-wrapBtn--success' : ''}`}
          >
            {busy === 'wrap' ? (
              <>
                <Loader2 size={12} className="sp-spin" /> wrapping...
              </>
            ) : busy === 'success' ? (
              <>
                <CheckIcon className="postpv-wrapBtn-checkmark" size={13} strokeWidth={3} /> wrapped
              </>
            ) : (
              'wrap with these defaults'
            )}
          </button>
          <button
            type="button"
            onClick={() => void customize()}
            disabled={busy !== null}
            className="sp-btn"
          >
            customize first
          </button>
          <button
            type="button"
            onClick={() => void close()}
            disabled={busy !== null}
            className="sp-btn"
            style={{ background: 'transparent', border: 'none' }}
          >
            not now
          </button>
        </div>

        <label className={`postpv-toggleRow${busy !== null ? ' postpv-toggleRow--busy' : ''}`}>
          <input
            className="postpv-toggleRow-input"
            type="checkbox"
            checked={dontAskAgain}
            onChange={(e) => setDontAskAgain(e.target.checked)}
            disabled={busy !== null}
          />
          <span
            className={`postpv-check${dontAskAgain ? ' postpv-check--on' : ''}`}
            aria-hidden="true"
          >
            <CheckIcon className="postpv-check-svg" size={12} strokeWidth={3} />
          </span>
          <span className="postpv-toggleRow-label">
            don&apos;t ask me again on any new dWallet
          </span>
        </label>

        <button
          type="button"
          onClick={() => void customize()}
          disabled={busy !== null}
          className="postpv-advancedLink"
        >
          <SettingsIcon className="postpv-advancedLink-icon" size={11} strokeWidth={2.2} />
          <span>see all settings + explainers</span>
          <ArrowRight className="postpv-advancedLink-arrow" size={11} strokeWidth={2.2} />
        </button>
      </div>
    </div>
  );
}

function DefaultRow({
  index,
  label,
  value,
  hint,
}: {
  /** Position in the defaults list; drives the staggered entrance via --row-i. */
  index: number;
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div
      className="postpv-defaultRow"
      style={
        {
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          fontSize: 11,
          padding: '3px 0',
          gap: 8,
          '--row-i': index,
        } as React.CSSProperties
      }
    >
      <span style={{ opacity: 0.8 }}>{label}</span>
      <span style={{ textAlign: 'right' }}>
        <strong>{value}</strong>
        {hint && (
          <span className="sp-muted" style={{ display: 'block', fontSize: 10, opacity: 0.65, marginTop: 1 }}>
            {hint}
          </span>
        )}
      </span>
    </div>
  );
}
