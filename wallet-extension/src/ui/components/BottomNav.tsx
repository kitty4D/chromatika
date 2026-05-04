import { motion, useReducedMotion } from 'framer-motion';
import { ClipboardList, Coins, KeyRound, Shield, ShieldCheck } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { Tab } from '@/ui/types';

type NavItem = { id: Tab; Icon: LucideIcon; label: string; title?: string };

const NAV: NavItem[] = [
  {
    id: 'vault',
    Icon: Shield,
    label: 'home',
    title: 'dWallet Vault home: fee payer, balances, and your dWallets',
  },
  {
    id: 'dwallet',
    Icon: KeyRound,
    label: 'dWALLET',
    title: 'Create and manage ika dWallets (identities for dapps and sends)',
  },
  { id: 'assets', Icon: Coins, label: 'assets', title: 'Portfolio and token balances' },
  { id: 'activity', Icon: ClipboardList, label: 'activity', title: 'Transaction activity' },
  {
    id: 'policy',
    Icon: ShieldCheck,
    label: 'policy',
    title: 'Policy Vault: on-chain spend caps + panic button + rescue address',
  },
];

const navPressEase = [0.22, 1, 0.36, 1] as const;

export function BottomNav({ active, onChange }: { active: Tab; onChange: (t: Tab) => void }) {
  const reduceMotion = useReducedMotion();

  return (
    <nav className="sp-bottomNav" aria-label="main">
      {NAV.map((n) => {
        const isActive = active === n.id;
        const Icon = n.Icon;
        return (
          <motion.button
            key={n.id}
            type="button"
            data-nav={n.id}
            className={`sp-navBtn${isActive ? ' sp-navBtnActive' : ''}`}
            title={n.title}
            onClick={() => onChange(n.id)}
            aria-current={isActive ? 'page' : undefined}
            whileTap={reduceMotion ? undefined : { scale: 0.97 }}
            whileHover={reduceMotion ? undefined : { scale: 1.02 }}
            transition={{ type: 'tween', duration: 0.14, ease: navPressEase }}
          >
            <span className="sp-navIcon" aria-hidden>
              <Icon strokeWidth={isActive ? 2.25 : 2} />
            </span>
            <span className={`sp-navLabel${n.id === 'dwallet' ? ' sp-navLabel--dwallet' : ''}`}>{n.label}</span>
            {isActive ? <span className="sp-navIndicator" /> : null}
          </motion.button>
        );
      })}
    </nav>
  );
}
