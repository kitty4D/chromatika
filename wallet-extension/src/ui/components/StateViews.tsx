import type { CSSProperties, ReactNode } from 'react';

/**
 * three small primitives for the "this list is empty / loading / errored" UX.
 * one shape, three slots; each page can pick the right one without rolling its own
 * markup and the emoji icon stays `aria-hidden` so screen readers don't read garbage.
 *
 * uses the existing `sp-empty` / `sp-emptyIcon` / `sp-emptyTitle` / `sp-muted`
 * classes from `wallet.css` so visual treatment is unchanged where they replace
 * older one-off divs. callers that need a skeleton grid (NFTs, Activity, Kiosks)
 * can use `<LoadingState skeleton="cards" count={6} />`.
 */

interface BaseProps {
  /** decorative emoji shown above the title. always rendered with `aria-hidden`. */
  icon?: string;
  /** primary headline (e.g. "no NFTs yet", "loading kiosks…", "failed to load"). */
  title?: string;
  /** optional sub-description below the title. one short sentence. */
  description?: ReactNode;
  /** optional action slot - render a button below the description. */
  action?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

export function EmptyState({ icon = '📭', title, description, action, className = '', style }: BaseProps) {
  return (
    <div className={`sp-empty ${className}`.trim()} style={style} role="status">
      <div className="sp-emptyIcon" aria-hidden="true">
        {icon}
      </div>
      {title && <div className="sp-emptyTitle">{title}</div>}
      {description && <div className="sp-muted" style={{ fontSize: 12, lineHeight: 1.5 }}>{description}</div>}
      {action && <div style={{ marginTop: 8 }}>{action}</div>}
    </div>
  );
}

export function LoadingState({
  title = 'loading…',
  description,
  skeleton,
  count = 4,
  className = '',
  style,
}: BaseProps & {
  /** when set, render a placeholder grid alongside the title for content-shaped feedback. */
  skeleton?: 'cards' | 'rows';
  /** number of skeleton placeholders to render (default 4). only used when `skeleton` is set. */
  count?: number;
}) {
  if (skeleton) {
    return (
      <div
        className={`sp-empty ${className}`.trim()}
        style={{ ...style, gap: 12, padding: '20px 12px' }}
        role="status"
        aria-live="polite"
        aria-busy="true"
      >
        <span className="sp-muted" style={{ fontSize: 12 }}>{title}</span>
        <div
          aria-hidden="true"
          style={{
            display: 'grid',
            gridTemplateColumns: skeleton === 'cards' ? 'repeat(2, 1fr)' : '1fr',
            gap: 8,
            width: '100%',
            maxWidth: 360,
          }}
        >
          {Array.from({ length: count }).map((_, i) => (
            <div
              key={i}
              style={{
                height: skeleton === 'cards' ? 96 : 36,
                borderRadius: 10,
                background: 'rgba(234,240,255,0.06)',
                animation: `chromatika-skeleton-pulse 1.4s ease-in-out ${i * 0.08}s infinite`,
              }}
            />
          ))}
        </div>
        <style>{`
          @keyframes chromatika-skeleton-pulse {
            0%, 100% { opacity: 0.5; }
            50% { opacity: 0.95; }
          }
        `}</style>
      </div>
    );
  }
  return (
    <div className={`sp-empty ${className}`.trim()} style={style} role="status" aria-live="polite" aria-busy="true">
      <div className="sp-muted" style={{ fontSize: 12 }}>{title}</div>
      {description && <div className="sp-muted" style={{ fontSize: 11, lineHeight: 1.5 }}>{description}</div>}
    </div>
  );
}

export function ErrorState({
  icon = '⚠',
  title = 'something went wrong',
  description,
  action,
  className = '',
  style,
}: BaseProps) {
  return (
    <div className={`sp-empty ${className}`.trim()} style={style} role="alert">
      <div className="sp-emptyIcon" aria-hidden="true" style={{ color: 'rgba(248,113,113,0.95)' }}>
        {icon}
      </div>
      {title && <div className="sp-emptyTitle">{title}</div>}
      {description && (
        <div
          className="sp-muted"
          style={{ fontSize: 12, lineHeight: 1.5, color: 'rgba(248,113,113,0.85)', wordBreak: 'break-word' }}
        >
          {description}
        </div>
      )}
      {action && <div style={{ marginTop: 8 }}>{action}</div>}
    </div>
  );
}
