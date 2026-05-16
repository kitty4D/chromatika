import type { trpc } from '@/lib/trpc';

export type Tab =
  | 'vault'
  | 'dwallet'
  | 'send'
  | 'activity'
  | 'policy'
  | 'ikaStake'
  | 'lab'
  | 'payments'
  | 'agents'
  | 'settings';

export type Balances = Awaited<ReturnType<typeof trpc.balances.query>>;
export type Networks = Awaited<ReturnType<typeof trpc.getNetworks.query>>;
