import type { ReactNode } from 'react';
import { CircleHelp } from 'lucide-react';

/**
 * inline contextual help for wallet screens. hidden when the user disables "screen help" in settings.
 * reuse on any tab; keep copy short and scannable.
 */
export function HelpBubble({
  show,
  children,
  id,
  variant = 'hero',
}: {
  show: boolean;
  children: ReactNode;
  /** optional id for aria-labelledby if you add a visible title later */
  id?: string;
  /** hero = under title chrome; bento = wallet home dWallet slab (distinct surface) */
  variant?: 'hero' | 'bento';
}) {
  if (!show) return null;

  const mod = variant === 'bento' ? ' cd-helpBubble--bento' : ' cd-helpBubble--hero';

  return (
    <aside
      id={id}
      className={`cd-helpBubble${mod}`}
      role="note"
      aria-label="Tip"
    >
      <span className="cd-helpBubble-icon" aria-hidden>
        <CircleHelp size={16} strokeWidth={2} />
      </span>
      <div className="cd-helpBubble-body">{children}</div>
    </aside>
  );
}
