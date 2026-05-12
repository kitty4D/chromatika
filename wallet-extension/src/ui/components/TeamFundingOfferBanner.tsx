/**
 * one-time consent banner for the team-funding faucet. asks the user, only on their FIRST
 * vault on this device, whether they want a small mainnet SUI + IKA drip from chromatika so
 * they can build their first dWallets without buying tokens first.
 *
 * behavior:
 *   - queries `trpc.getTeamFundingOffer` on mount. when `eligible: false`, nothing renders.
 *   - on Yes: `trpc.acceptTeamFundingOffer.mutate()`. the SW marks 'accepted' BEFORE firing
 *     the fetch, so a double-tap can't double-spend. funding progress shows on the
 *     `OperationProgressBanner` (the SW pipes through `beginOperation('Funding from team')`).
 *   - on No: `trpc.declineTeamFundingOffer.mutate()`. decision sticks per vault id so the
 *     banner never returns.
 *
 * styled to sit BELOW the `OperationProgressBanner` slot in `MainWalletShell` so the funding
 * progress strip can ride directly above the offer prompt (relevant only on the second time
 * the user opens the side panel after declining the offer - rare, but visually clean).
 */

import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Sparkles, X } from 'lucide-react';
import { trpc } from '@/lib/trpc';

const TINT = {
  bg: 'var(--theme-banner-info-bg, var(--theme-banner-running-bg))',
  fg: 'var(--theme-banner-info-fg, var(--theme-banner-running-fg))',
};

type EligibleOffer = {
  eligible: true;
  vaultId: string;
  recipientAddress: string;
  ikaBaseUnits: string;
  suiMist: string;
};

function formatBaseUnits(raw: string, decimals = 9): string {
  let n: bigint;
  try {
    n = BigInt(raw);
  } catch {
    return raw;
  }
  const whole = n / 10n ** BigInt(decimals);
  const frac = (n % 10n ** BigInt(decimals)).toString().padStart(decimals, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

function shortAddr(addr: string): string {
  if (addr.length <= 14) return addr;
  return `${addr.slice(0, 8)}…${addr.slice(-6)}`;
}

export function TeamFundingOfferBanner() {
  const [offer, setOffer] = useState<EligibleOffer | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await trpc.getTeamFundingOffer.query();
        if (cancelled) return;
        if (r.eligible) setOffer(r);
        else setOffer(null);
      } catch {
        if (!cancelled) setOffer(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleAccept = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await trpc.acceptTeamFundingOffer.mutate();
    } catch {
      // even if the mutation throws, the SW writes the decision before firing the fetch -
      // hiding the banner keeps the user from re-clicking. failures land on the OperationProgressBanner.
    }
    setOffer(null);
    setBusy(false);
  };

  const handleDecline = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await trpc.declineTeamFundingOffer.mutate();
    } catch {
      // decision write failed - hide anyway so we don't pester the user; next mount may re-show.
    }
    setOffer(null);
    setBusy(false);
  };

  return (
    <AnimatePresence>
      {offer ? (
        <motion.div
          key="team-funding-offer"
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.18, ease: 'easeOut' }}
          role="dialog"
          aria-label="Receive team funding"
          style={{
            background: TINT.bg,
            borderBottom: `1px solid ${TINT.bg}`,
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 10,
              padding: '10px 12px',
            }}
          >
            <span style={{ display: 'inline-flex', color: TINT.fg, flexShrink: 0, marginTop: 1 }}>
              <Sparkles size={16} />
            </span>
            <div
              style={{
                flex: 1,
                minWidth: 0,
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
              }}
            >
              <div style={{ fontSize: 12, fontWeight: 600, color: TINT.fg, lineHeight: 1.25 }}>
                Receive {formatBaseUnits(offer.ikaBaseUnits)} IKA + {formatBaseUnits(offer.suiMist)} SUI from Chromatika?
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: TINT.fg,
                  opacity: 0.85,
                  lineHeight: 1.35,
                }}
              >
                One-time bootstrap so you can create your first 2 dWallets without buying SUI + IKA. Sent to
                {' '}
                <span style={{ fontFamily: 'var(--font-mono, monospace)' }}>{shortAddr(offer.recipientAddress)}</span>
                {'. '}
                Additional vaults won't see this offer.
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 2 }}>
                <button
                  type="button"
                  onClick={handleAccept}
                  disabled={busy}
                  style={{
                    background: TINT.fg,
                    color: TINT.bg,
                    border: 'none',
                    fontSize: 11,
                    fontWeight: 700,
                    padding: '5px 12px',
                    borderRadius: 6,
                    cursor: busy ? 'progress' : 'pointer',
                    letterSpacing: 0.2,
                    opacity: busy ? 0.6 : 1,
                  }}
                >
                  Yes, send it
                </button>
                <button
                  type="button"
                  onClick={handleDecline}
                  disabled={busy}
                  style={{
                    background: 'rgba(0, 0, 0, 0.18)',
                    color: TINT.fg,
                    border: `1px solid ${TINT.fg}`,
                    fontSize: 11,
                    fontWeight: 600,
                    padding: '4px 11px',
                    borderRadius: 6,
                    cursor: busy ? 'progress' : 'pointer',
                    letterSpacing: 0.2,
                    opacity: busy ? 0.6 : 1,
                  }}
                >
                  No thanks
                </button>
              </div>
            </div>
            <button
              type="button"
              onClick={handleDecline}
              disabled={busy}
              aria-label="Dismiss"
              style={{
                background: 'transparent',
                border: 'none',
                color: TINT.fg,
                opacity: busy ? 0.3 : 0.6,
                cursor: busy ? 'progress' : 'pointer',
                display: 'inline-flex',
                padding: 2,
                flexShrink: 0,
              }}
            >
              <X size={14} />
            </button>
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
