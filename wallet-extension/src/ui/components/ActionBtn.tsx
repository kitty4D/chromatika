import { motion } from 'framer-motion';
import type { LucideIcon } from 'lucide-react';

export function ActionBtn({
  icon: Icon,
  label,
  disabled,
  onClick,
  compact,
}: {
  icon: LucideIcon;
  label: string;
  disabled?: boolean;
  onClick?: () => void;
  /** icon-only square control; label becomes aria-label + title */
  compact?: boolean;
}) {
  const iconPx = compact ? 18 : 20;
  return (
    <motion.button
      type="button"
      className={compact ? 'sp-actionBtn sp-actionBtn--compact' : 'sp-actionBtn'}
      disabled={disabled}
      onClick={onClick}
      aria-label={compact ? label : undefined}
      title={compact ? label : undefined}
      whileTap={disabled ? undefined : { scale: 0.96 }}
      whileHover={disabled ? undefined : { scale: 1.02 }}
      transition={{ type: 'spring', stiffness: 450, damping: 26 }}
    >
      <span className="sp-actionIcon" aria-hidden>
        <Icon size={iconPx} strokeWidth={2} />
      </span>
      <span className="sp-actionLabel">{label}</span>
    </motion.button>
  );
}
