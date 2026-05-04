import type { IkaBaseMode } from '@/background/ika-base-mode';
import { FEATURES } from '@/config/features';
import './mode-selector.css';

type Size = 'xs' | 'sm' | 'md';

export function ModeSelectorPanel({
  active,
  onSelect,
  onActiveSamePress,
  size = 'md',
  variant = 'default',
}: {
  active: IkaBaseMode;
  onSelect: (mode: IkaBaseMode) => void;
  /** fired when user taps the already-selected chain icon (vault management shortcut). */
  onActiveSamePress?: () => void;
  size?: Size;
  /** large illustrative controls for onboarding hero. */
  variant?: 'default' | 'hero';
}) {
  const sz =
    variant === 'hero'
      ? 'ckm-modeBtn--hero'
      : size === 'xs'
        ? 'ckm-modeBtn--xs'
        : size === 'sm'
          ? 'ckm-modeBtn--sm'
          : 'ckm-modeBtn--md';

  function onSuiClick() {
    if (active === 'sui') onActiveSamePress?.();
    else onSelect('sui');
  }

  function onSolClick() {
    if (active === 'solana') onActiveSamePress?.();
    else onSelect('solana');
  }

  return (
    <div
      className={variant === 'hero' ? 'ckm-panel ckm-panel--hero' : 'ckm-panel'}
      role="group"
      aria-label="Ika base chain mode"
    >
      <button
        type="button"
        className={`ckm-modeBtn ${sz} ${active === 'sui' ? 'ckm-modeBtn--active' : 'ckm-modeBtn--inactive'}`}
        onClick={onSuiClick}
        aria-pressed={active === 'sui'}
        title="Sui — ika dWallet base chain (tap again for vault management)"
      >
        <img src="/sui-mode.svg" alt="" />
      </button>
      {FEATURES.SOLANA_IKA_BASE_IN_UI && (
        <button
          type="button"
          className={`ckm-modeBtn ${sz} ${active === 'solana' ? 'ckm-modeBtn--active' : 'ckm-modeBtn--inactive'}`}
          onClick={onSolClick}
          aria-pressed={active === 'solana'}
          title="Solana — ika pre-alpha devnet (gRPC DKG + sign; tap again for vault management)"
        >
          <img src="/solana-mode.svg" alt="" />
        </button>
      )}
    </div>
  );
}
