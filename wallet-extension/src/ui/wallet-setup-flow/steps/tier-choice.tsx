import type { CSSProperties } from 'react';
import { trpc } from '@/lib/trpc';
import type { UserMode } from '@/background/user-mode';
import type { WalletSetupSurface } from '../internal';
import type { WalletSetupHook } from '../use-wallet-setup';

/**
 * First bootstrap step: pick an experience tier so new users land in Beginner instead
 * of the full power-user UI. Persists via `setUserMode` (a global chrome.storage pref,
 * independent of the not-yet-created vault), then advances to the create/import chooser.
 * Always changeable later in Settings -> experience mode.
 */
const TIERS: ReadonlyArray<{ id: UserMode; title: string; blurb: string; recommended?: boolean }> = [
  {
    id: 'beginner',
    title: 'Just getting started',
    blurb: 'A simple, single-account wallet with the crypto jargon tucked away.',
    recommended: true,
  },
  {
    id: 'advanced',
    title: 'I know crypto',
    blurb: 'The full wallet: multiple accounts, every chain, networks, and dapp controls.',
  },
  {
    id: 'pro',
    title: 'Power user',
    blurb: 'Everything in Advanced, plus raw addresses, dev details, and debug panels.',
  },
];

export function TierChoiceStep({
  surface,
  box,
  hook,
}: {
  surface: WalletSetupSurface;
  box: CSSProperties;
  hook: WalletSetupHook;
}) {
  async function pick(mode: UserMode) {
    // persist before advancing; a failed write just leaves the default tier in place.
    try {
      await trpc.setUserMode.mutate({ mode });
    } catch {
      /* non-fatal */
    }
    hook.setStep('choose');
  }

  return (
    <div style={box} className={`ws-choose ws-choose--${surface} ws-tierChoice`}>
      <div className="ws-choose-brand">
        <img className="ws-choose-logo" src="/chromatika-clean-key.png" alt="" width={100} height={100} />
      </div>
      <h2 className="ws-tierChoice-title">How much do you want to see?</h2>
      <p className="ws-choose-lead">You can change this any time in Settings.</p>
      <div className="ws-tierChoice-grid" role="group" aria-label="choose your experience">
        {TIERS.map((t) => (
          <button key={t.id} type="button" className="ws-tierChoice-card" onClick={() => void pick(t.id)}>
            <span className="ws-tierChoice-cardTitle">
              {t.title}
              {t.recommended ? <span className="ws-tierChoice-rec">Recommended</span> : null}
            </span>
            <span className="ws-tierChoice-cardBlurb">{t.blurb}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
