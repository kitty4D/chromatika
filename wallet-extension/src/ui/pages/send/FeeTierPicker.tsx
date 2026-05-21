/**
 * Fee-tier picker for the Send Confirm step. Three pills (Slow / Normal / Fast) when the
 * chain supports tiering, or a single line when it doesn't (Sui RGP is network-wide so we
 * show one value). suiKER's Android UI uses emoji (🐢 / 💎 / 🚀); we mirror that for
 * recognisability while keeping the rendering accessible (the emoji are aria-hidden and
 * the tier names are the actual labels).
 *
 * stays presentation-only - the caller passes the tiers + selected state + on-change, the
 * component doesn't fetch anything.
 */

import type { ReactNode } from 'react';

export type FeeTierLike = {
  tier: 'slow' | 'normal' | 'fast';
  totalFormatted: string;
  totalUsd: number | null;
};

export type FeeTiersLike = {
  supportsTiers: boolean;
  fromRealData: boolean;
  slow: FeeTierLike;
  normal: FeeTierLike;
  fast: FeeTierLike;
};

const TIER_META: Record<FeeTierLike['tier'], { label: string; emoji: string; subtitle: string }> = {
  slow: { label: 'Slow', emoji: '🐢', subtitle: 'low priority' },
  normal: { label: 'Normal', emoji: '💎', subtitle: 'standard' },
  fast: { label: 'Fast', emoji: '🚀', subtitle: 'top of block' },
};

function formatUsdShort(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return '';
  if (n < 0.01) return '<$0.01';
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

export function FeeTierPicker({
  tiers,
  selected,
  onChange,
  loading,
  error,
}: {
  tiers: FeeTiersLike | null;
  selected: FeeTierLike['tier'];
  onChange: (next: FeeTierLike['tier']) => void;
  loading?: boolean;
  error?: string | null;
}): ReactNode {
  if (loading && !tiers) {
    return (
      <div className="sp-section">
        <div className="sp-muted" style={{ fontSize: 11 }}>estimating network fee…</div>
      </div>
    );
  }
  if (error && !tiers) {
    return (
      <div className="sp-section">
        <div className="sp-muted" style={{ fontSize: 11, color: 'oklch(0.72 0.18 25)' }}>
          fee estimate unavailable: {error}
        </div>
      </div>
    );
  }
  if (!tiers) return null;

  if (!tiers.supportsTiers) {
    // Sui case: render a single line, no picker. The three slots all hold the same value.
    const t = tiers.normal;
    return (
      <div className="sp-section">
        <div className="sp-muted" style={{ fontSize: 11, marginBottom: 2 }}>network fee</div>
        <div style={{ fontSize: 13, fontWeight: 600 }}>
          {t.totalFormatted}
          {t.totalUsd != null && t.totalUsd > 0 ? (
            <span className="sp-muted" style={{ fontWeight: 400, marginLeft: 6 }}>
              ({formatUsdShort(t.totalUsd)})
            </span>
          ) : null}
        </div>
        {!tiers.fromRealData && (
          <div className="sp-muted" style={{ fontSize: 10, marginTop: 2 }}>
            (estimate; using fallback values)
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="sp-section">
      <div className="sp-muted" style={{ fontSize: 11, marginBottom: 6 }}>network fee</div>
      <div
        role="radiogroup"
        aria-label="Network fee priority"
        style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 }}
      >
        {(['slow', 'normal', 'fast'] as const).map((key) => {
          const t = tiers[key];
          const meta = TIER_META[key];
          const isActive = selected === key;
          return (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={isActive}
              onClick={() => onChange(key)}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 2,
                padding: '8px 6px',
                borderRadius: 8,
                background: isActive ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.03)',
                border: `1px solid ${isActive ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.10)'}`,
                color: 'inherit',
                cursor: 'pointer',
                transition: 'background 120ms ease, border-color 120ms ease',
                minWidth: 0,
              }}
            >
              <div style={{ fontSize: 14, lineHeight: 1 }} aria-hidden>
                {meta.emoji}
              </div>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.04em' }}>
                {meta.label}
              </div>
              <div style={{ fontSize: 10, fontVariantNumeric: 'tabular-nums', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%' }}>
                {t.totalFormatted}
              </div>
              {t.totalUsd != null && t.totalUsd > 0 ? (
                <div className="sp-muted" style={{ fontSize: 9, fontVariantNumeric: 'tabular-nums' }}>
                  {formatUsdShort(t.totalUsd)}
                </div>
              ) : null}
            </button>
          );
        })}
      </div>
      {!tiers.fromRealData && (
        <div className="sp-muted" style={{ fontSize: 10, marginTop: 4 }}>
          (using fallback fee values; network RPC didn't return live tiers)
        </div>
      )}
    </div>
  );
}
