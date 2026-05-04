import { useState, type CSSProperties } from 'react';
import type { ScanResult, ScanCandidateRow } from '@/background/scan/scan-types';
import type { ScanChainEntry } from '@/config/scan-chains';

/**
 * scan results presentation. takes a `ScanResult` from a scan tRPC mutation + the super-pro
 * chain catalog, renders one row per candidate with checkboxes + a super-pro picker.
 *
 * props are intentionally lean: no tRPC inside this component so the host (passkey step / hd
 * step / seeker step / settings) controls the import action. that keeps this view re-usable
 * across import-time and post-unlock surfaces.
 */
export function ScanResultsView(props: {
  result: ScanResult;
  /** super-pro chains the user can opt into for a re-scan (passed in by the host). */
  superProChains: ScanChainEntry[];
  /** which candidate keys are currently selected for import. */
  selectedKeys: Set<string>;
  onSelectionChange: (next: Set<string>) => void;
  /** which super-pro chain ids are currently checked. */
  selectedSuperProIds: Set<string>;
  onSuperProSelectionChange: (next: Set<string>) => void;
  /** triggered when the user clicks "rescan with super-pro chains". */
  onRescan: () => void;
  /** triggered when the user clicks "import selected". */
  onImport: () => void;
  /** disable UI while a scan or import is mid-flight. */
  busy?: boolean;
}) {
  const { result, superProChains, selectedKeys, onSelectionChange, selectedSuperProIds, onSuperProSelectionChange, onRescan, onImport, busy } = props;
  const [showSuperPro, setShowSuperPro] = useState(false);

  function toggle(key: string) {
    const next = new Set(selectedKeys);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onSelectionChange(next);
  }

  function toggleSuperPro(id: string) {
    const next = new Set(selectedSuperProIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onSuperProSelectionChange(next);
  }

  const activeRows = result.rows.filter((r) => r.hasAnyActivity || r.isDefaultSlot);
  const emptyRows = result.rows.filter((r) => !r.hasAnyActivity && !r.isDefaultSlot);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <h3 style={{ margin: '0 0 6px', fontSize: 15 }}>scan results</h3>
        <p style={{ margin: '0 0 4px', fontSize: 12.5, opacity: 0.75 }}>
          checked {result.rows.length} {result.method === 'hd' ? 'account slot' : 'identity'}{result.rows.length === 1 ? '' : 's'} across {countUniqueChainsInRows(result.rows)} chain{countUniqueChainsInRows(result.rows) === 1 ? '' : 's'} in {(result.elapsedMs / 1000).toFixed(1)}s.
          {' '}{activeRows.length} have activity{result.suggestedKeys.length ? ` (${result.suggestedKeys.length} suggested)` : ''}.
        </p>
        {result.notes.length > 0 && (
          <div
            style={{
              marginTop: 8,
              padding: '8px 10px',
              borderRadius: 6,
              border: '1px solid rgba(255, 175, 70, 0.45)',
              background: 'rgba(255, 175, 70, 0.08)',
              fontSize: 12,
              lineHeight: 1.5,
            }}
          >
            {result.notes.map((n, i) => (
              <div key={i} style={{ marginBottom: i === result.notes.length - 1 ? 0 : 6 }}>{n}</div>
            ))}
          </div>
        )}
        {result.warnings.length > 0 && (
          <details style={{ fontSize: 11.5, opacity: 0.65, marginTop: 6 }}>
            <summary style={{ cursor: 'pointer' }}>{result.warnings.length} warning{result.warnings.length === 1 ? '' : 's'}</summary>
            <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
              {result.warnings.slice(0, 10).map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </details>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {activeRows.map((r) => (
          <CandidateRow key={r.candidate.key} row={r} checked={selectedKeys.has(r.candidate.key)} onToggle={() => toggle(r.candidate.key)} />
        ))}
        {emptyRows.length > 0 && (
          <details>
            <summary style={{ cursor: 'pointer', fontSize: 12.5, opacity: 0.7 }}>show {emptyRows.length} empty slot{emptyRows.length === 1 ? '' : 's'}</summary>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
              {emptyRows.map((r) => (
                <CandidateRow key={r.candidate.key} row={r} checked={selectedKeys.has(r.candidate.key)} onToggle={() => toggle(r.candidate.key)} />
              ))}
            </div>
          </details>
        )}
      </div>

      <details
        open={showSuperPro}
        onToggle={(e) => setShowSuperPro((e.currentTarget as HTMLDetailsElement).open)}
        style={superProDetailsStyle}
      >
        <summary style={{ cursor: 'pointer', fontSize: 13, fontWeight: 500 }}>
          super-pro: scan more chains ({superProChains.length} available)
        </summary>
        <p style={{ margin: '8px 0', fontSize: 12, opacity: 0.7, lineHeight: 1.5 }}>
          opt into additional chains - evm L2s + bitcoin + aptos. each adds 1 rpc call per
          candidate; expect a few extra seconds.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 6 }}>
          {superProChains.map((c) => (
            <label key={c.id} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
              <input
                type="checkbox"
                checked={selectedSuperProIds.has(c.id)}
                onChange={() => toggleSuperPro(c.id)}
                disabled={busy}
              />
              <span>{c.name}</span>
            </label>
          ))}
        </div>
        <button
          type="button"
          onClick={onRescan}
          disabled={busy || selectedSuperProIds.size === 0}
          style={{ marginTop: 10 }}
        >
          {busy ? 'rescanning...' : 'rescan with selected chains'}
        </button>
      </details>

      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" onClick={onImport} disabled={busy || selectedKeys.size === 0} style={{ flex: 1 }}>
          {busy ? 'importing...' : `import ${selectedKeys.size} selected`}
        </button>
      </div>
    </div>
  );
}

function CandidateRow({
  row,
  checked,
  onToggle,
}: {
  row: ScanCandidateRow;
  checked: boolean;
  onToggle: () => void;
}) {
  const label = row.candidate.accountIndex !== undefined
    ? `account ${row.candidate.accountIndex}${row.isDefaultSlot ? ' (default)' : ''}`
    : 'this identity';
  return (
    <label style={candidateRowStyle(row.hasAnyActivity)}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <input type="checkbox" checked={checked} onChange={onToggle} />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 500 }}>{label}</div>
          {row.candidate.suiAddress && (
            <div style={{ fontSize: 11, opacity: 0.65, fontFamily: 'monospace' }}>
              sui {short(row.candidate.suiAddress)}
            </div>
          )}
          {row.candidate.solanaAddress && (
            <div style={{ fontSize: 11, opacity: 0.65, fontFamily: 'monospace' }}>
              sol {short(row.candidate.solanaAddress)}
            </div>
          )}
          {row.candidate.evmAddress && (
            <div style={{ fontSize: 11, opacity: 0.65, fontFamily: 'monospace' }}>
              evm {short(row.candidate.evmAddress)}
            </div>
          )}
        </div>
        <div style={{ textAlign: 'right' }}>
          {row.dwalletCount > 0 && (
            <div style={{ fontSize: 11.5, color: 'rgba(124, 92, 252, 0.95)' }}>
              {row.dwalletCount} dwallet{row.dwalletCount === 1 ? '' : 's'}
            </div>
          )}
          {row.probes.filter((p) => p.balanceSmallest && p.balanceSmallest > 0n).slice(0, 3).map((p) => (
            <div key={p.chainId} style={{ fontSize: 11, opacity: 0.85 }}>
              {p.balanceDisplay ?? `${p.balanceSmallest} on ${p.chainName}`}
            </div>
          ))}
          {row.probes.filter((p) => !p.balanceSmallest && p.txCount && p.txCount > 0).slice(0, 2).map((p) => (
            <div key={p.chainId} style={{ fontSize: 11, opacity: 0.6 }}>
              activity on {p.chainName}
            </div>
          ))}
        </div>
      </div>
    </label>
  );
}

function short(s: string): string {
  if (s.length <= 14) return s;
  return `${s.slice(0, 6)}...${s.slice(-4)}`;
}

function countUniqueChainsInRows(rows: ScanCandidateRow[]): number {
  const set = new Set<string>();
  for (const r of rows) for (const p of r.probes) set.add(p.chainId);
  return set.size;
}

function candidateRowStyle(hasActivity: boolean): CSSProperties {
  return {
    display: 'block',
    padding: '10px 12px',
    border: hasActivity ? '1px solid rgba(124, 92, 252, 0.4)' : '1px solid rgba(255, 255, 255, 0.08)',
    borderRadius: 8,
    background: hasActivity ? 'rgba(124, 92, 252, 0.06)' : 'rgba(255, 255, 255, 0.02)',
    cursor: 'pointer',
  };
}

const superProDetailsStyle: CSSProperties = {
  padding: '10px 12px',
  border: '1px solid rgba(255, 255, 255, 0.08)',
  borderRadius: 8,
  background: 'rgba(255, 255, 255, 0.02)',
};
