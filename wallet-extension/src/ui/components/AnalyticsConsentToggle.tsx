import { useState, useEffect } from 'react';
import { trpc } from '@/lib/trpc';

export function AnalyticsConsentToggle() {
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    trpc.getAnalyticsConsent.query().then((c) => {
      setEnabled(c.errorTracking);
      setLoading(false);
    });
  }, []);

  const toggle = async () => {
    const next = !enabled;
    setEnabled(next);
    await trpc.setAnalyticsConsent.mutate({ errorTracking: next });
  };

  if (loading) return null;

  return (
    <div className="flex items-center justify-between py-3 px-1">
      <div className="flex-1 mr-4">
        <div className="text-sm font-medium">help improve chromatika</div>
        <div className="text-xs text-muted-foreground mt-0.5">
          send anonymous crash reports when errors occur. no wallet addresses,
          balances, keys, or transaction data is ever included.
        </div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        onClick={toggle}
        className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
          enabled ? 'bg-primary' : 'bg-muted'
        }`}
      >
        <span
          className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-background shadow-sm transition-transform ${
            enabled ? 'translate-x-4' : 'translate-x-0'
          }`}
        />
      </button>
    </div>
  );
}
