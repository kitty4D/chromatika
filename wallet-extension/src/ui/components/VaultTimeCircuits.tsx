// BTTF time-circuits panel: three-row segmented-LED readout that mounts inside
// `VaultBaseCard` above the cockpit gauges. row 1 = mainnet usd (red-orange),
// row 2 = testnet usd (amber), row 3 = relative last-updated time (green).
//
// digits use the bundled DSEG7-Classic font with a heavy text-shadow glow.
// when the font asset is missing, the @font-face fallback chain (monospace)
// still gives a credible LED feel because we keep the glow + tabular-nums.
//
// click on the mainnet row toggles compact ($12.3K) vs exact ($12,345.67),
// preserving the existing `chromatika_vault_total_format_v1` localStorage pref.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useVaultTotalSnapshot } from '@/lib/use-vault-total';
import {
  formatVaultTieredTotals,
  type VaultTotalFormat,
} from '@/lib/format-vault-total';

const FORMAT_PREF_KEY = 'chromatika_vault_total_format_v1';
const FLASH_MS = 600;

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
    // localStorage not available (rare); in-memory only
  }
}

/** turn epoch ms into the LED clock readout. fresh (<60s) -> HH:MM:SS,
 *  older -> the kind of relative phrasing the BTTF dash would actually show
 *  ("2 MIN AGO", "1 HR AGO"). always uppercase to match the LED aesthetic. */
function formatLastUpdated(lastFetchedMs: number, nowMs: number): string {
  const deltaMs = Math.max(0, nowMs - lastFetchedMs);
  const deltaSec = Math.floor(deltaMs / 1000);
  if (deltaSec < 60) {
    const d = new Date(lastFetchedMs);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }
  const deltaMin = Math.floor(deltaSec / 60);
  if (deltaMin < 60) return `${deltaMin} MIN AGO`;
  const deltaHr = Math.floor(deltaMin / 60);
  if (deltaHr < 24) return `${deltaHr} HR AGO`;
  const deltaDay = Math.floor(deltaHr / 24);
  return `${deltaDay} DAY AGO`;
}

export function VaultTimeCircuits({ vaultId }: { vaultId: string | null }) {
  const { snap, pending } = useVaultTotalSnapshot(vaultId);
  const [format, setFormat] = useState<VaultTotalFormat>(loadFormatPref);
  const [flashMainnet, setFlashMainnet] = useState(false);
  const [flashTestnet, setFlashTestnet] = useState(false);
  const prevTextsRef = useRef<{ m: string; t: string }>({ m: '', t: '' });

  // tick every 30s so the relative-time row stays current even when no other
  // re-renders fire.
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);

  const tiered = useMemo(() => {
    if (!snap) {
      return { mainnetText: '$...', testnetText: '$...' };
    }
    return formatVaultTieredTotals(
      {
        mainnetUsdMicros: snap.mainnetUsdMicros,
        testnetUsdMicros: snap.testnetUsdMicros,
        partial: snap.partial,
      },
      format,
    );
  }, [snap, format]);

  // fire a brief flash class when either total changes (skip the very first paint).
  useEffect(() => {
    const prev = prevTextsRef.current;
    if (prev.m && prev.m !== tiered.mainnetText) {
      setFlashMainnet(true);
      const t = window.setTimeout(() => setFlashMainnet(false), FLASH_MS);
      return () => window.clearTimeout(t);
    }
    return undefined;
  }, [tiered.mainnetText]);

  useEffect(() => {
    const prev = prevTextsRef.current;
    if (prev.t && prev.t !== tiered.testnetText) {
      setFlashTestnet(true);
      const t = window.setTimeout(() => setFlashTestnet(false), FLASH_MS);
      return () => window.clearTimeout(t);
    }
    return undefined;
  }, [tiered.testnetText]);

  useEffect(() => {
    prevTextsRef.current = { m: tiered.mainnetText, t: tiered.testnetText };
  }, [tiered.mainnetText, tiered.testnetText]);

  const relativeTime = useMemo(() => {
    if (!snap) return pending ? '...' : '--:--:--';
    return formatLastUpdated(snap.lastFetchedMs, nowMs);
  }, [snap, nowMs, pending]);

  const tooltip = useMemo(() => {
    if (!snap) return undefined;
    const ageMin = Math.round((nowMs - snap.lastFetchedMs) / 60_000);
    const fails = snap.perChain.filter((p) => !p.ok);
    const head = `Mainnet: real-money total. Testnet/devnet: priced at mainnet rates for reference only.`;
    if (fails.length === 0) return `${head}\n\nlast refreshed ${ageMin} min ago`;
    return `${head}\n\n${fails.map((f) => `${f.chainKey} (${f.tier}): ${f.reason ?? 'failed'}`).join('\n')}\n\nlast refreshed ${ageMin} min ago`;
  }, [snap, nowMs]);

  function toggleFormat(): void {
    const next: VaultTotalFormat = format === 'compact' ? 'exact' : 'compact';
    setFormat(next);
    saveFormatPref(next);
  }

  if (!vaultId) return null;

  const funded = snap !== null && !snap.partial;

  return (
    <div
      className="cv-timeCircuits"
      data-funded={funded ? 'true' : 'false'}
      role="group"
      aria-label="vault USD totals - mainnet, testnet, last updated"
      title={tooltip}
    >
      <button
        type="button"
        className="cv-timeCircuits-row cv-timeCircuits-row--mainnet"
        onClick={toggleFormat}
        aria-label="mainnet total (click to toggle compact / exact)"
      >
        <span className="cv-timeCircuits-label">MAINNET TOTAL</span>
        <span
          className="cv-timeCircuits-digits cv-timeCircuits-digits--lg"
          data-flashing={flashMainnet ? 'true' : 'false'}
        >
          {tiered.mainnetText}
        </span>
      </button>
      <div className="cv-timeCircuits-row cv-timeCircuits-row--testnet">
        <span className="cv-timeCircuits-label">TESTNET</span>
        <span
          className="cv-timeCircuits-digits cv-timeCircuits-digits--md"
          data-flashing={flashTestnet ? 'true' : 'false'}
        >
          {tiered.testnetText}
        </span>
      </div>
      <div className="cv-timeCircuits-row cv-timeCircuits-row--clock">
        <span className="cv-timeCircuits-label">LAST UPDATED</span>
        <span className="cv-timeCircuits-digits cv-timeCircuits-digits--sm">{relativeTime}</span>
      </div>
    </div>
  );
}
