import { ChevronsDown, ChevronsUp } from 'lucide-react';
import {
  ChromeAgentsIconButton,
  ChromeChromaLabIconButton,
  ChromeIkaStakingIconButton,
  ChromePaymentsIconButton,
} from '@/ui/components/TitleBar';

/** ika staking + chroma lab + payments (x402) + agents (mcp) — sits inside the expanded bottom drawer. */
export function WalletChromeIkaLabStrip({
  onOpenIkaStaking,
  onOpenLab,
  onOpenPayments,
  onOpenAgents,
}: {
  onOpenIkaStaking: () => void;
  onOpenLab: () => void;
  onOpenPayments: () => void;
  onOpenAgents: () => void;
}) {
  return (
    <div className="sp-bottomNavRevealInner">
      <ChromeIkaStakingIconButton onClick={onOpenIkaStaking} />
      <ChromeChromaLabIconButton onClick={onOpenLab} />
      <ChromePaymentsIconButton onClick={onOpenPayments} />
      <ChromeAgentsIconButton onClick={onOpenAgents} />
    </div>
  );
}

/** chevron seam above bottom nav; expands/collapses the four-icon shortcut strip. */
export function CollapsibleIkaLabDrawer({
  expanded,
  onToggleExpanded,
  titleBarHeightPx,
  onOpenIkaStaking,
  onOpenLab,
  onOpenPayments,
  onOpenAgents,
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
        {expanded ? <ChevronsDown size={16} strokeWidth={2} /> : <ChevronsUp size={16} strokeWidth={2} />}
      </button>
      {expanded ? (
        <div className="sp-bottomNavReveal" style={{ minHeight: titleBarHeightPx }}>
          <WalletChromeIkaLabStrip
            onOpenIkaStaking={onOpenIkaStaking}
            onOpenLab={onOpenLab}
            onOpenPayments={onOpenPayments}
            onOpenAgents={onOpenAgents}
          />
        </div>
      ) : null}
    </>
  );
}
