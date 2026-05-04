import { Bot, CreditCard, FlaskConical, Settings } from 'lucide-react';
import { ModeSelectorPanel } from '@/ui/mode-selector/ModeSelectorPanel';
import type { IkaBaseMode } from '@/background/ika-base-mode';
import '@/ui/mode-selector/mode-selector.css';
import '@/ui/wallet-chrome-extras.css';

/** shared chrome actions (title bar + bottom drawer) */
export function ChromeIkaStakingIconButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      className="ct-settingsBtn ct-ikaStakingBtn"
      aria-label="open IKA staking"
      title="IKA staking"
      onClick={onClick}
    >
      <img src="/ika.svg" alt="" width={18} height={18} className="ct-ikaStakingBtn-logo" />
    </button>
  );
}

export function ChromeChromaLabIconButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      className="ct-settingsBtn"
      aria-label="open Chroma Lab"
      title="Chroma Lab"
      onClick={onClick}
    >
      <FlaskConical size={18} strokeWidth={2} />
    </button>
  );
}

export function ChromePaymentsIconButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      className="ct-settingsBtn"
      aria-label="open Payments (x402)"
      title="Payments · x402"
      onClick={onClick}
    >
      <CreditCard size={18} strokeWidth={2} />
    </button>
  );
}

export function ChromeAgentsIconButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      className="ct-settingsBtn"
      aria-label="open Agents (MCP)"
      title="Agents · MCP"
      onClick={onClick}
    >
      <Bot size={18} strokeWidth={2} />
    </button>
  );
}

export function TitleBar({
  variant,
  mode,
  onSelect,
  onActiveSameMode,
  onOpenSettings,
  modeSize = 'md',
}: {
  /** `wallet` = main extension chrome (side panel + popup); `onboarding` = full-tab onboarding */
  variant: 'wallet' | 'onboarding';
  mode: IkaBaseMode;
  onSelect: (m: IkaBaseMode) => void | Promise<void>;
  onActiveSameMode?: () => void;
  onOpenSettings?: () => void;
  /** compact ika switcher (prefer `xs` on narrow surfaces) */
  modeSize?: 'xs' | 'sm' | 'md';
}) {
  const barClass =
    variant === 'wallet'
      ? 'ct-titleBar ct-titleBar--wallet'
      : 'ct-titleBar ct-titleBar--onboarding';

  return (
    <header className={barClass}>
      <div className="ct-titleBar-left">
        <ModeSelectorPanel
          active={mode}
          onSelect={(m) => void onSelect(m)}
          onActiveSamePress={onActiveSameMode}
          size={modeSize}
        />
      </div>
      <div className="ct-titleBar-center" aria-hidden>
        chromatika
      </div>
      <div className="ct-titleBar-right">
        {onOpenSettings ? (
          <button
            type="button"
            className="ct-settingsBtn"
            aria-label="open settings"
            title="settings"
            onClick={onOpenSettings}
          >
            <Settings size={18} strokeWidth={2} />
          </button>
        ) : null}
        {!onOpenSettings ? <span className="ct-titleBar-rightSpacer" /> : null}
      </div>
    </header>
  );
}
