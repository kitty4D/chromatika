/**
 * Activity-page filter chip row. Three chip groups (chain / kind / status) + a text
 * search input. All filtering is client-side over the merged ActivityItem list - the
 * feed is capped at ~30 rows so we don't need server-side filter pushdown.
 *
 * Persistence: filter state lives in localStorage under `chromatika_activity_filters_v1`
 * so a user who selects "EVM + Swap" once doesn't lose it on tab navigation.
 */

import { useCallback, useEffect, useState } from 'react';
import { Search, X } from 'lucide-react';
import type { ActivityItem } from '@/background/services/activity';
import type { IndexedTxKind } from '@/background/services/activity-index';

const STORAGE_KEY = 'chromatika_activity_filters_v1';

type ChainKey = ActivityItem['chain'];
type StatusKey = ActivityItem['status'];

export type ActivityFiltersState = {
  /** when empty set, treat as "all chains". explicit selections narrow the view. */
  chains: ChainKey[];
  kinds: IndexedTxKind[];
  statuses: StatusKey[];
  searchQuery: string;
};

const EMPTY_STATE: ActivityFiltersState = {
  chains: [],
  kinds: [],
  statuses: [],
  searchQuery: '',
};

function readStored(): ActivityFiltersState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY_STATE;
    const parsed = JSON.parse(raw) as Partial<ActivityFiltersState>;
    return {
      chains: Array.isArray(parsed.chains) ? (parsed.chains as ChainKey[]) : [],
      kinds: Array.isArray(parsed.kinds) ? (parsed.kinds as IndexedTxKind[]) : [],
      statuses: Array.isArray(parsed.statuses) ? (parsed.statuses as StatusKey[]) : [],
      searchQuery: typeof parsed.searchQuery === 'string' ? parsed.searchQuery : '',
    };
  } catch {
    return EMPTY_STATE;
  }
}

function writeStored(state: ActivityFiltersState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* localStorage disabled - fine to drop */
  }
}

/** apply filters to a list. exported so the parent page can use it AND so unit tests
 * can verify the pure filtering logic without rendering. */
export function applyActivityFilters(
  items: ActivityItem[],
  filters: ActivityFiltersState,
): ActivityItem[] {
  const chainSet = new Set(filters.chains);
  const kindSet = new Set(filters.kinds);
  const statusSet = new Set(filters.statuses);
  const q = filters.searchQuery.trim().toLowerCase();
  return items.filter((item) => {
    if (chainSet.size > 0 && !chainSet.has(item.chain)) return false;
    if (kindSet.size > 0) {
      const k = item.kind ?? 'unknown';
      if (!kindSet.has(k)) return false;
    }
    if (statusSet.size > 0 && !statusSet.has(item.status)) return false;
    if (q.length > 0) {
      const hay = [
        item.digest,
        item.label,
        item.fromAddress ?? '',
        item.origin ?? '',
        item.memo ?? '',
      ]
        .join(' ')
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

const CHAIN_CHIPS: Array<{ key: ChainKey; label: string }> = [
  { key: 'sui', label: 'Sui' },
  { key: 'evm', label: 'EVM' },
  { key: 'solana', label: 'Solana' },
  { key: 'bitcoin', label: 'BTC' },
];

const KIND_CHIPS: Array<{ key: IndexedTxKind; label: string }> = [
  { key: 'transfer', label: 'Transfer' },
  { key: 'swap', label: 'Swap' },
  { key: 'stakeDelegate', label: 'Stake' },
  { key: 'tokenApproval', label: 'Approval' },
  { key: 'transferNFT', label: 'NFT' },
  { key: 'smartContractCall', label: 'Contract' },
];

const STATUS_CHIPS: Array<{ key: StatusKey; label: string }> = [
  { key: 'pending', label: 'Pending' },
  { key: 'success', label: 'Confirmed' },
  { key: 'failure', label: 'Failed' },
];

function toggleInSet<T>(arr: T[], value: T): T[] {
  return arr.includes(value) ? arr.filter((v) => v !== value) : [...arr, value];
}

export function ActivityFilters({
  state,
  onChange,
}: {
  state: ActivityFiltersState;
  onChange: (next: ActivityFiltersState) => void;
}) {
  const updateField = useCallback(
    <K extends keyof ActivityFiltersState>(key: K, value: ActivityFiltersState[K]) => {
      const next = { ...state, [key]: value };
      onChange(next);
      writeStored(next);
    },
    [state, onChange],
  );

  const hasAnyFilter =
    state.chains.length + state.kinds.length + state.statuses.length > 0 ||
    state.searchQuery.trim().length > 0;

  return (
    <div className="sp-section" style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}>
        <div
          style={{
            position: 'relative',
            flex: 1,
            minWidth: 0,
            display: 'flex',
            alignItems: 'center',
          }}
        >
          <Search size={12} aria-hidden style={{ position: 'absolute', left: 8, opacity: 0.6 }} />
          <input
            type="search"
            className="sp-input"
            value={state.searchQuery}
            onChange={(e) => updateField('searchQuery', e.target.value)}
            placeholder="search digest, address, memo, dapp…"
            aria-label="search activity"
            style={{ paddingLeft: 26, fontSize: 11 }}
          />
          {state.searchQuery.length > 0 && (
            <button
              type="button"
              aria-label="clear search"
              onClick={() => updateField('searchQuery', '')}
              style={{
                position: 'absolute',
                right: 6,
                background: 'transparent',
                border: 'none',
                color: 'inherit',
                cursor: 'pointer',
                padding: 2,
                display: 'flex',
                alignItems: 'center',
              }}
            >
              <X size={12} />
            </button>
          )}
        </div>
        {hasAnyFilter && (
          <button
            type="button"
            className="sp-btn sp-btn--xs"
            onClick={() => {
              onChange(EMPTY_STATE);
              writeStored(EMPTY_STATE);
            }}
            title="Clear all activity filters"
          >
            clear
          </button>
        )}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 4 }}>
        {CHAIN_CHIPS.map((c) => {
          const active = state.chains.includes(c.key);
          return (
            <button
              key={c.key}
              type="button"
              className={`sp-chip${active ? ' sp-chipActive' : ''}`}
              aria-pressed={active}
              onClick={() => updateField('chains', toggleInSet(state.chains, c.key))}
              style={{ fontSize: 10 }}
            >
              {c.label}
            </button>
          );
        })}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 4 }}>
        {KIND_CHIPS.map((k) => {
          const active = state.kinds.includes(k.key);
          return (
            <button
              key={k.key}
              type="button"
              className={`sp-chip${active ? ' sp-chipActive' : ''}`}
              aria-pressed={active}
              onClick={() => updateField('kinds', toggleInSet(state.kinds, k.key))}
              style={{ fontSize: 10 }}
            >
              {k.label}
            </button>
          );
        })}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {STATUS_CHIPS.map((s) => {
          const active = state.statuses.includes(s.key);
          return (
            <button
              key={s.key}
              type="button"
              className={`sp-chip${active ? ' sp-chipActive' : ''}`}
              aria-pressed={active}
              onClick={() => updateField('statuses', toggleInSet(state.statuses, s.key))}
              style={{ fontSize: 10 }}
            >
              {s.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function useActivityFiltersState(): [
  ActivityFiltersState,
  (next: ActivityFiltersState) => void,
] {
  const [state, setState] = useState<ActivityFiltersState>(readStored);
  useEffect(() => {
    // pick up cross-tab updates (unlikely but cheap).
    function onStorage(e: StorageEvent) {
      if (e.key !== STORAGE_KEY) return;
      setState(readStored());
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  return [state, setState];
}
