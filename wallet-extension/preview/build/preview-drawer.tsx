/**
 * Preview-only replacement for `@/ui/components/WalletChromeIkaLabStrip`.
 *
 * The real strip's four icon buttons (ika staking, chroma lab, x402 payments,
 * mcp agents) all open lazy-loaded pages. In the static iframe preview those
 * pages either crash or stall because they reach into chain RPCs / chrome.storage
 * the stub cannot fake. Wrapping each button with `PreviewDisabledTooltip` makes
 * them visually present (so the chrome is complete) but inert: clicking shows
 * "X - not available in live preview" instead of trying to navigate.
 *
 * `CollapsibleIkaLabDrawer` is re-exported with the only change being which
 * strip component it nests inside the expanded panel.
 */

import { ChevronsDown, ChevronsUp } from 'lucide-react';
import {
  ChromeAgentsIconButton,
  ChromeChromaLabIconButton,
  ChromeIkaStakingIconButton,
  ChromePaymentsIconButton,
} from '@/ui/components/TitleBar';
import { PreviewDisabledTooltip } from './preview-disabled';

const noop = () => {};

/** drawer strip with the four shortcut buttons gated for the live preview. */
export function WalletChromeIkaLabStrip(_props: {
  onOpenIkaStaking: () => void;
  onOpenLab: () => void;
  onOpenPayments: () => void;
  onOpenAgents: () => void;
}) {
  void _props;
  return (
    <div className="sp-bottomNavRevealInner">
      <PreviewDisabledTooltip message="ika staking - not available in live preview">
        <ChromeIkaStakingIconButton onClick={noop} />
      </PreviewDisabledTooltip>
      <PreviewDisabledTooltip message="chromalab (encrypt.xyz testing) - not available in live preview">
        <ChromeChromaLabIconButton onClick={noop} />
      </PreviewDisabledTooltip>
      <PreviewDisabledTooltip message="x402 - not available in live preview">
        <ChromePaymentsIconButton onClick={noop} />
      </PreviewDisabledTooltip>
      <PreviewDisabledTooltip message="mcp server - not available in live preview">
        <ChromeAgentsIconButton onClick={noop} />
      </PreviewDisabledTooltip>
    </div>
  );
}

/** unchanged from the real component except it nests our gated strip. */
export function CollapsibleIkaLabDrawer({
  expanded,
  onToggleExpanded,
  titleBarHeightPx,
}: {
  expanded: boolean;
  onToggleExpanded: () => void;
  titleBarHeightPx: number;
  onOpenIkaStaking: () => void;
  onOpenLab: () => void;
  onOpenPayments: () => void;
  onOpenAgents: () => void;
}) {
  return (
    <>
      <button
        type="button"
        className="sp-bottomNavRevealToggle"
        aria-expanded={expanded}
        aria-label={
          expanded
            ? 'hide ika staking, lab, payments, and agents shortcuts'
            : 'show ika staking, lab, payments, and agents shortcuts'
        }
        onClick={onToggleExpanded}
      >
        {expanded ? (
          <ChevronsDown size={16} strokeWidth={2} />
        ) : (
          <ChevronsUp size={16} strokeWidth={2} />
        )}
      </button>
      {expanded ? (
        <div className="sp-bottomNavReveal" style={{ minHeight: titleBarHeightPx }}>
          <WalletChromeIkaLabStrip
            onOpenIkaStaking={noop}
            onOpenLab={noop}
            onOpenPayments={noop}
            onOpenAgents={noop}
          />
        </div>
      ) : null}
    </>
  );
}
