import { useEffect, useState } from 'react';
import { Sparkles, X } from 'lucide-react';
import { trpc } from '@/lib/trpc';

export function WelcomeBanner({
  isSolanaBase,
  funded,
}: {
  isSolanaBase: boolean;
  funded: boolean;
}) {
  const [dismissed, setDismissed] = useState<boolean | null>(null);

  useEffect(() => {
    trpc.getWelcomeBannerDismissed.query().then((r) => setDismissed(r.dismissed)).catch(() => setDismissed(true));
  }, []);

  if (dismissed !== false || funded) return null;

  const dismiss = () => {
    setDismissed(true);
    trpc.dismissWelcomeBanner.mutate().catch(() => {});
  };

  return (
    <div className="sp-banner sp-banner--welcome">
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <Sparkles size={18} aria-hidden style={{ flexShrink: 0, marginTop: 2, color: 'var(--theme-brand, #a78bfa)' }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Welcome to Chromatika</div>
          <p style={{ margin: 0, fontSize: 12, opacity: 0.85, lineHeight: 1.4 }}>
            {isSolanaBase
              ? 'Fund your vault with devnet SOL to get started. Use a Solana faucet or transfer from another wallet.'
              : 'Fund your vault with SUI and IKA to get started. The gauges above show your vault balance.'}
          </p>
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
