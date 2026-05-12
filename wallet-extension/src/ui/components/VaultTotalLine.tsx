import { useEffect, useMemo, useState } from 'react';
import { trpc } from '@/lib/trpc';
import {
  formatVaultTotalUsd,
  type VaultTotalFormat,
} from '@/lib/format-vault-total';
import { vaultTotalCacheKey, parseStoredWireSnapshot } from '@/background/services/vault-total-cache';

const POLL_MS = 60_000;
const FORMAT_PREF_KEY = 'chromatika_vault_total_format_v1';

type Snap = Awaited<ReturnType<typeof trpc.getVaultTotal.query>>;

function loadFormatPref(): VaultTotalFormat {
  try {
    const v = localStorage.getItem(FORMAT_PREF_KEY);
    return v === 'exact' ? 'exact' : 'compact';
  } catch {
    return 'compact';
  }
}
function saveFormatPref(f: VaultTotalFormat): void {
  try {
    localStorage.setItem(FORMAT_PREF_KEY, f);
  } catch {
    // localStorage not available (rare); silently fall back to in-memory state only
  }
}

export function VaultTotalLine({ vaultId }: { vaultId: string | null }) {
  const [snap, setSnap] = useState<Snap | null>(null);
  const [pending, setPending] = useState(false);
  const [format, setFormat] = useState<VaultTotalFormat>(loadFormatPref);

  // refresh on mount, on vault switch, every 60s
  useEffect(() => {
    if (!vaultId) {
      setSnap(null);
      return;
    }
    let cancelled = false;
    const refresh = async () => {
      setPending(true);
      try {
        const got = await trpc.getVaultTotal.query({ vaultId });
        if (!cancelled) setSnap(got);
      } catch {
        if (!cancelled) setSnap(null);
      } finally {
        if (!cancelled) setPending(false);
      }
    };
    void refresh();
    const t = window.setInterval(() => void refresh(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [vaultId]);

  // listen for storage cache writes from getVaultTotalsForOthers / clearVaultTotalCache
  useEffect(() => {
    if (!vaultId) return;
    const key = vaultTotalCacheKey(vaultId);
    const handler = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'session') return;
      if (!(key in changes)) return;
      const next = parseStoredWireSnapshot(changes[key].newValue);
      if (next) setSnap(next);
    };
    chrome.storage.onChanged.addListener(handler);
    return () => chrome.storage.onChanged.removeListener(handler);
  }, [vaultId]);

  const text = useMemo(() => {
    if (!snap) return pending ? '$...' : '—';
    if (snap.perChain.length > 0 && snap.perChain.every((p) => !p.ok)) return '—';
    return formatVaultTotalUsd({ usdMicros: snap.usdMicros, partial: snap.partial }, format);
  }, [snap, pending, format]);

  const tooltip = useMemo(() => {
    if (!snap) return undefined;
    const ageMin = Math.round((Date.now() - snap.lastFetchedMs) / 60_000);
    const fails = snap.perChain.filter((p) => !p.ok);
    if (fails.length === 0) return `last refreshed ${ageMin} min ago`;
    return `${fails.map((f) => `${f.chainKey}: ${f.reason ?? 'failed'}`).join('\n')}\n\nlast refreshed ${ageMin} min ago`;
  }, [snap]);

  function toggleFormat() {
    const next: VaultTotalFormat = format === 'compact' ? 'exact' : 'compact';
    setFormat(next);
    saveFormatPref(next);
  }

  if (!vaultId) return null;
  return (
    <button
      type="button"
      className={`cv-vaultTotal${pending ? ' cv-vaultTotal--pending' : ''}`}
      onClick={toggleFormat}
      title={tooltip}
      aria-label="vault total value (click to toggle compact / exact)"
    >
      {text}
    </button>
  );
}
