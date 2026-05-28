// small mainnet-only USD pill for non-home tabs. the home tab shows the full
// BTTF time-circuits readout inside the cockpit (`VaultTimeCircuits`), but on
// send/settings/portfolio/etc. there's no cockpit, so the user still needs an
// at-a-glance "mainnet $X.XK" reference. uses the shared snapshot hook so this
// pill and the BTTF panel never run two pollers in parallel.

import { useMemo } from 'react';
import { useVaultTotalSnapshot } from '@/lib/use-vault-total';
import {
  formatVaultTotalUsd,
  type VaultTotalFormat,
} from '@/lib/format-vault-total';

const FORMAT_PREF_KEY = 'chromatika_vault_total_format_v1';

function loadFormatPref(): VaultTotalFormat {
  try {
    const v = localStorage.getItem(FORMAT_PREF_KEY);
    return v === 'exact' ? 'exact' : 'compact';
  } catch {
    return 'compact';
  }
}

export function VaultHeaderTotalPill({ vaultId }: { vaultId: string | null }) {
  const { snap, pending } = useVaultTotalSnapshot(vaultId);
  const format = useMemo<VaultTotalFormat>(loadFormatPref, []);

  const text = useMemo(() => {
    if (!snap) return pending ? '$...' : '--';
    if (snap.perChain.length > 0 && snap.perChain.every((p) => !p.ok)) return '--';
    return formatVaultTotalUsd(
      { usdMicros: snap.mainnetUsdMicros, partial: snap.partial },
      format,
    );
  }, [snap, pending, format]);

  if (!vaultId) return null;

  const hasTestnet = snap !== null && snap.testnetUsdMicros > 0n;

  return (
    <span
      className={`cv-headerTotalPill${pending ? ' cv-headerTotalPill--pending' : ''}`}
      title={
        hasTestnet
          ? 'mainnet total. switch to the home tab for the testnet breakdown.'
          : 'mainnet total'
      }
      aria-label="vault mainnet total"
    >
      <span className="cv-headerTotalPill-kicker">MAIN</span>
      <span className="cv-headerTotalPill-amt">{text}</span>
    </span>
  );
}
