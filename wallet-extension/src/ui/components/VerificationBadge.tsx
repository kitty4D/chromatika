import { ShieldCheck, ShieldQuestion, ShieldAlert } from 'lucide-react';
import type { VerificationLevel } from '@/background/services/token-verification';

const CONFIG: Record<VerificationLevel, { Icon: typeof ShieldCheck; color: string; label: string }> = {
  verified: { Icon: ShieldCheck, color: '#3b82f6', label: 'verified token' },
  unverified: { Icon: ShieldQuestion, color: '#9ca3af', label: 'unverified token' },
  suspicious: { Icon: ShieldAlert, color: '#ef4444', label: 'suspicious token' },
};

export function VerificationBadge({ level, size = 14 }: { level: VerificationLevel; size?: number }) {
  const { Icon, color, label } = CONFIG[level];
  return <Icon size={size} color={color} aria-label={label} style={{ flexShrink: 0 }} />;
}
