import { useEffect, useState } from 'react';
import { Layers, X } from 'lucide-react';
import { trpc } from '@/lib/trpc';

const MIN_IKA_FOR_PROMPT = 100_000_000_000n;

export function StakingPromptBanner({
  ikaBalanceBaseUnits,
  hasStakedPositions,
  onStake,
}: {
  ikaBalanceBaseUnits: string;
  hasStakedPositions: boolean;
  onStake: () => void;
}) {
  const [dismissed, setDismissed] = useState<boolean | null>(null);

  useEffect(() => {
    trpc.getStakingPromptDismissed.query().then((r) => setDismissed(r.dismissed)).catch(() => setDismissed(true));
  }, []);

  if (dismissed !== false) return null;

  let balance: bigint;
  try { balance = BigInt(ikaBalanceBaseUnits || '0'); } catch { balance = 0n; }
  if (balance < MIN_IKA_FOR_PROMPT || hasStakedPositions) return null;

  const dismiss = () => {
    setDismissed(true);
    trpc.dismissStakingPrompt.mutate().catch(() => {});
  };

  return (
    <div className="sp-banner sp-banner--staking">
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <Layers size={18} aria-hidden style={{ flexShrink: 0, marginTop: 2, color: 'var(--theme-brand, #a78bfa)' }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Earn staking rewards</div>
          <p style={{ margin: 0, fontSize: 12, opacity: 0.85, lineHeight: 1.4 }}>
            You have idle IKA that could be earning rewards. Stake to validators and help secure the network.
          </p>
          <button
            type="button"
            onClick={onStake}
            className="sp-banner-action"
            style={{
              marginTop: 8,
              padding: '4px 12px',
              fontSize: 12,
              fontWeight: 600,
              borderRadius: 6,
              border: '1px solid var(--theme-brand, #a78bfa)',
              background: 'transparent',
              color: 'var(--theme-brand, #a78bfa)',
              cursor: 'pointer',
            }}
          >
            Stake IKA
          </button>
        </div>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss"
          style={{
            background: 'none',
            border: 'none',
            color: 'inherit',
            cursor: 'pointer',
            padding: 2,
            display: 'flex',
            alignItems: 'center',
            opacity: 0.6,
            flexShrink: 0,
          }}
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
