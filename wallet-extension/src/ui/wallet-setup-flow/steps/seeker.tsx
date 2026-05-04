import type { CSSProperties } from 'react';
import { useEffect } from 'react';
import { HardwareStep } from './hardware';
import type { WalletSetupSurface } from '../internal';
import type { WalletSetupHook } from '../use-wallet-setup';

/**
 * seeker shortcut step. seeker (mwa-solana hardware) is **already implemented** as part of the
 * hardware path: `HardwareVaultRecord` with `mwaTransport: 'local' | 'remote'`, paired through
 * `SeekerConnect.tsx` (remote QR reflector) or `pairMwaForHardwareVault` (local Android intent).
 *
 * this step is a thin promotion of seeker to a top-level cta on choose: it forces the
 * appropriate MWA transport based on user-agent and renders the existing `HardwareStep`. users
 * skip the "use hardware wallet to MWA to seeker" three-level drilldown.
 */
export function SeekerStep({
  surface,
  box,
  onDismiss,
  hook,
}: {
  surface: WalletSetupSurface;
  box: CSSProperties;
  onDismiss?: () => void;
  hook: WalletSetupHook;
}) {
  const { setHardwareDeviceSelect, effectiveIkaBase } = hook;

  useEffect(() => {
    // seeker = solana MWA. UA picks `local` (Android intent) vs `remote` (desktop wss + QR).
    const isAndroidUa = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);
    setHardwareDeviceSelect(isAndroidUa ? 'mwa' : 'mwa-remote');
    // intentionally one-shot on mount; user can change device pickers from inside HardwareStep
    // if they want a different transport (e.g., walletconnect).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (effectiveIkaBase !== 'solana') {
    // seeker is solana-base only; if the user landed here with sui base active, redirect them
    // gently so the existing hardware path's solana gating doesn't surface as a confusing error.
    return (
      <div style={box} className={`ws-step ws-step--${surface}`}>
        <h2 style={{ marginTop: 0 }}>seeker</h2>
        <p>
          flip ika base to solana to use a seeker (or any solana mobile wallet). passkey + waap
          live on the sui side; seeker + lazor on the solana side.
        </p>
        <button
          type="button"
          className="ws-choose-btn ws-choose-btn--secondary"
          onClick={() => hook.setStep('choose')}
        >
          ← back
        </button>
      </div>
    );
  }

  return <HardwareStep surface={surface} box={box} onDismiss={onDismiss} hook={hook} />;
}
