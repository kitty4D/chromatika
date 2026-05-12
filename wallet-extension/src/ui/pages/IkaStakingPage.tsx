import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { trpc } from '@/lib/trpc';
import { buildSuiExplorerUrl } from '@/config/explorers';
import { feePayerExplorerHref } from '@/lib/explorer-href';
import { useExplorerPreferences } from '@/lib/use-explorer-preferences';
import { ExplorerValueRow } from '@/ui/components/ExplorerValueRow';
import { ikaFromBaseUnits } from '@/lib/sui-amount';
import type { Balances, Networks } from '@/ui/types';

type ValidatorRow = Awaited<ReturnType<typeof trpc.ikaStakingValidators.query>>[number];
type StakedRow = Awaited<ReturnType<typeof trpc.ikaStakingPositions.query>>[number];
type SystemSnapshot = Awaited<ReturnType<typeof trpc.ikaStakingEpoch.query>>;

type SortKey = 'stake' | 'commission' | 'apy' | 'name';

const VALIDATORS_POLL_MS = 5 * 60 * 1000;
const EPOCH_POLL_MS = 30 * 1000;
const POSITIONS_POLL_MS = 60 * 1000;

/** UI-side mirror of `computeValidatorApyPercent` in `@/background/ika/ika-staking`. */
function computeApyPercent(
  v: Pick<ValidatorRow, 'totalStakeBaseUnits' | 'commissionRateBps' | 'status'>,
  s: Pick<
    SystemSnapshot,
    'stakeSubsidyAmountPerDistributionBaseUnits' | 'activeValidatorCount' | 'epochDurationMs'
  > | null,
): number | null {
  if (!s) return null;
  if (v.status !== 'Active') return null;
  const totalStake = Number(BigInt(v.totalStakeBaseUnits || '0'));
  if (totalStake <= 0) return null;
  const subsidyPerEpoch = Number(BigInt(s.stakeSubsidyAmountPerDistributionBaseUnits || '0'));
  if (subsidyPerEpoch <= 0 || s.activeValidatorCount <= 0 || s.epochDurationMs <= 0) return null;
  const perValPerEpoch = subsidyPerEpoch / s.activeValidatorCount;
  const epochsPerYear = (365 * 24 * 60 * 60 * 1000) / s.epochDurationMs;
  const gross = (perValPerEpoch / totalStake) * epochsPerYear;
  const net = gross * (1 - v.commissionRateBps / 10_000);
  return net * 100;
}

function midTruncate(id: string, head = 6, tail = 4): string {
  if (id.length <= head + tail + 1) return id;
  return `${id.slice(0, head)}…${id.slice(-tail)}`;
}

function formatIkaAmount(baseUnits: string): string {
  const ika = ikaFromBaseUnits(baseUnits);
  if (ika >= 1_000_000_000) return `${(ika / 1_000_000_000).toFixed(2)}B`;
  if (ika >= 1_000_000) return `${(ika / 1_000_000).toFixed(2)}M`;
  if (ika >= 1_000) return `${(ika / 1_000).toFixed(2)}K`;
  if (ika >= 1) return ika.toFixed(2);
  return ika.toFixed(4);
}

function formatCountdown(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return 'ending soon';
  const totalSec = Math.floor(ms / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${totalSec}s`;
}

function formatAgeSeconds(seconds: number): string {
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

const STATUS_LABELS: Record<ValidatorRow['status'], string> = {
  Active: 'Active',
  PreActive: 'Pre-active',
  Withdrawing: 'Withdrawing',
  Unknown: 'Unknown',
};

const STATUS_COLORS: Record<ValidatorRow['status'], string> = {
  Active: 'rgba(80, 220, 130, 0.9)',
  PreActive: 'rgba(180, 180, 255, 0.85)',
  Withdrawing: 'rgba(245, 200, 90, 0.92)',
  Unknown: 'rgba(180, 180, 180, 0.8)',
};

export function IkaStakingPage({
  balances,
  networks,
  onDone,
}: {
  balances: Balances | null;
  networks: Networks | null;
  onDone?: () => void;
}) {
  const explorerPrefs = useExplorerPreferences();
  const [validators, setValidators] = useState<ValidatorRow[]>([]);
  const [positions, setPositions] = useState<StakedRow[]>([]);
  const [snapshot, setSnapshot] = useState<SystemSnapshot | null>(null);

  const [validatorsFetchedAt, setValidatorsFetchedAt] = useState<number | null>(null);
  const [positionsFetchedAt, setPositionsFetchedAt] = useState<number | null>(null);
  const [snapshotFetchedAt, setSnapshotFetchedAt] = useState<number | null>(null);

  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('stake');

  const [selectedValidatorId, setSelectedValidatorId] = useState<string | null>(null);
  const [amountIka, setAmountIka] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [, forceCountdownTick] = useState(0);
  const listScrollRef = useRef<HTMLDivElement | null>(null);
  const savedScrollTop = useRef(0);

  const refreshValidators = useCallback(async () => {
    try {
      const v = await trpc.ikaStakingValidators.query();
      setValidators(v);
      setValidatorsFetchedAt(Date.now());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const refreshPositions = useCallback(async () => {
    try {
      const p = await trpc.ikaStakingPositions.query();
      setPositions(p);
      setPositionsFetchedAt(Date.now());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const refreshSnapshot = useCallback(async () => {
    try {
      const s = await trpc.ikaStakingEpoch.query();
      setSnapshot(s);
      setSnapshotFetchedAt(Date.now());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const refreshAll = useCallback(async () => {
    setErr(null);
    await Promise.all([refreshValidators(), refreshPositions(), refreshSnapshot()]);
  }, [refreshValidators, refreshPositions, refreshSnapshot]);

  // initial load + polling. each resource on its own cadence so the cheap epoch tick doesn't
  // drag the heavier validator list along.
  useEffect(() => {
    if (balances?.locked) return;
    if (balances && 'ikaBase' in balances && balances.ikaBase === 'solana') return;
    void refreshAll();
    const tValidators = window.setInterval(() => void refreshValidators(), VALIDATORS_POLL_MS);
    const tEpoch = window.setInterval(() => void refreshSnapshot(), EPOCH_POLL_MS);
    const tPositions = window.setInterval(() => void refreshPositions(), POSITIONS_POLL_MS);
    return () => {
      window.clearInterval(tValidators);
      window.clearInterval(tEpoch);
      window.clearInterval(tPositions);
    };
  }, [balances?.locked, (balances as { ikaBase?: string } | null)?.ikaBase, refreshAll, refreshValidators, refreshPositions, refreshSnapshot]);

  // 1s countdown tick - drives the epoch-ends-in display and the "updated Ns ago" pill.
  useEffect(() => {
    const t = window.setInterval(() => forceCountdownTick((n) => (n + 1) % 1_000_000), 1000);
    return () => window.clearInterval(t);
  }, []);

  // preserve list scroll position when drilling into the stake subview and back.
  useEffect(() => {
    if (selectedValidatorId === null && listScrollRef.current) {
      listScrollRef.current.scrollTop = savedScrollTop.current;
    }
  }, [selectedValidatorId]);

  const validatorById = useMemo(() => {
    const m = new Map<string, ValidatorRow>();
    for (const v of validators) m.set(v.objectId, v);
    return m;
  }, [validators]);

  const apyByValidatorId = useMemo(() => {
    const m = new Map<string, number | null>();
    for (const v of validators) m.set(v.objectId, computeApyPercent(v, snapshot));
    return m;
  }, [validators, snapshot]);

  const filteredSorted = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = q
      ? validators.filter((v) => v.name.toLowerCase().includes(q) || v.objectId.toLowerCase().includes(q))
      : validators.slice();
    filtered.sort((a, b) => {
      if (sortKey === 'name') return a.name.localeCompare(b.name);
      if (sortKey === 'commission') return a.commissionRateBps - b.commissionRateBps;
      if (sortKey === 'apy') {
        const aa = apyByValidatorId.get(a.objectId) ?? -1;
        const bb = apyByValidatorId.get(b.objectId) ?? -1;
        return bb - aa;
      }
      const av = BigInt(a.totalStakeBaseUnits || '0');
      const bv = BigInt(b.totalStakeBaseUnits || '0');
      return av < bv ? 1 : av > bv ? -1 : 0;
    });
    return filtered;
  }, [validators, search, sortKey, apyByValidatorId]);

  // epoch countdown (re-derived each tick because forceCountdownTick rerenders)
  const countdownMs =
    snapshot && snapshot.epochStartTimestampMs > 0 && snapshot.epochDurationMs > 0
      ? snapshot.epochStartTimestampMs + snapshot.epochDurationMs - Date.now()
      : null;

  // pick the OLDEST of (validators, positions, snapshot) for the "updated Ns ago" pill so the
  // user sees the most honest staleness signal across the three resources.
  const oldestFetchedAt = useMemo(() => {
    const candidates = [validatorsFetchedAt, positionsFetchedAt, snapshotFetchedAt].filter(
      (n): n is number => typeof n === 'number',
    );
    if (candidates.length === 0) return null;
    return Math.min(...candidates);
  }, [validatorsFetchedAt, positionsFetchedAt, snapshotFetchedAt]);
  const ageSeconds = oldestFetchedAt ? Math.max(0, Math.floor((Date.now() - oldestFetchedAt) / 1000)) : null;

  // -------- early returns --------
  if (balances?.locked) return null;

  if (balances && 'ikaBase' in balances && balances.ikaBase === 'solana') {
    return (
      <div className="sp-page">
        <h2 className="sp-pageTitle">IKA staking</h2>
        <div
          style={{
            marginTop: 12,
            padding: 12,
            borderRadius: 10,
            border: '1px solid rgba(255,255,255,0.08)',
            fontSize: 12,
            lineHeight: 1.5,
          }}
        >
          <strong>Sui base only.</strong> IKA staking uses the Sui ika system package. Switch to a Sui-base
          dWallet vault (or create one) to stake here.
        </div>
      </div>
    );
  }

  const feeAddr =
    balances && !balances.locked && 'feePayerAddress' in balances ? balances.feePayerAddress : '';
  const ikaBalanceRaw =
    balances && !balances.locked && 'ika' in balances ? balances.ika : '0';
  const ikaBalance = ikaFromBaseUnits(ikaBalanceRaw);
  const suiNetId = networks?.active.suiNetworkId ?? 'sui-mainnet';
  const feeHref =
    feeAddr && balances && !balances.locked && 'network' in balances
      ? feePayerExplorerHref(explorerPrefs, networks, feeAddr, 'sui', balances.network)
      : null;

  // -------- actions --------
  async function onStake() {
    if (!selectedValidatorId) return;
    setBusy(true);
    setErr(null);
    try {
      const raw = amountIka.trim();
      if (!raw) throw new Error('Enter an amount');
      const n = Number.parseFloat(raw);
      if (!Number.isFinite(n) || n <= 0) throw new Error('Invalid amount');
      const base = BigInt(Math.floor(n * 1e9));
      await trpc.ikaStake.mutate({
        validatorId: selectedValidatorId,
        amountBaseUnits: base.toString(),
      });
      setAmountIka('');
      setSelectedValidatorId(null);
      await Promise.all([refreshPositions(), refreshValidators()]);
      onDone?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onWithdraw(objectId: string) {
    setBusy(true);
    setErr(null);
    try {
      await trpc.ikaWithdrawStake.mutate({ stakedIkaObjectId: objectId });
      await refreshPositions();
      onDone?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function openStakeSubview(objectId: string) {
    if (listScrollRef.current) savedScrollTop.current = listScrollRef.current.scrollTop;
    setSelectedValidatorId(objectId);
    setAmountIka('');
    setErr(null);
  }

  // -------- subview: stake to <validator> --------
  if (selectedValidatorId) {
    const v = validatorById.get(selectedValidatorId);
    const apy = v ? apyByValidatorId.get(v.objectId) ?? null : null;
    const annualEstimateIka = apy != null && amountIka.trim() !== ''
      ? Number.parseFloat(amountIka) * (apy / 100)
      : null;
    return (
      <div className="sp-page">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <button
            type="button"
            className="sp-btn sp-btn--ghost"
            style={{ padding: '6px 10px', minHeight: 0 }}
            onClick={() => setSelectedValidatorId(null)}
            disabled={busy}
            aria-label="Back to validator list"
          >
            ← Back
          </button>
          <h2 className="sp-pageTitle" style={{ margin: 0 }}>
            Stake to {v?.name ?? midTruncate(selectedValidatorId)}
          </h2>
        </div>

        {v ? (
          <ValidatorHeaderCard
            v={v}
            apy={apy}
            suiNetId={suiNetId}
            explorerPrefs={explorerPrefs}
          />
        ) : (
          <div className="sp-muted" style={{ fontSize: 12 }}>
            Validator not in cached list. Tap Back and refresh.
          </div>
        )}

        <div style={{ marginTop: 14 }}>
          <label className="sp-muted" style={{ fontSize: 11, display: 'block', marginBottom: 4 }}>
            Amount (IKA)
          </label>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              className="wc-input"
              style={{ flex: 1, fontSize: 13 }}
              placeholder="0.0"
              value={amountIka}
              onChange={(e) => setAmountIka(e.target.value)}
              inputMode="decimal"
              disabled={busy}
            />
            <button
              type="button"
              className="sp-btn"
              style={{ minHeight: 0, padding: '8px 12px' }}
              onClick={() => setAmountIka(ikaBalance > 0 ? ikaBalance.toString() : '')}
              disabled={busy || ikaBalance <= 0}
              aria-label="Use max IKA balance"
            >
              Max
            </button>
          </div>
          <div className="sp-muted" style={{ fontSize: 11, marginTop: 6 }}>
            Balance: {ikaBalance.toLocaleString('en-US', { maximumFractionDigits: 4 })} IKA
          </div>
          {annualEstimateIka != null && annualEstimateIka > 0 ? (
            <div className="sp-muted" style={{ fontSize: 11, marginTop: 2 }}>
              ≈ {annualEstimateIka.toLocaleString('en-US', { maximumFractionDigits: 4 })} IKA / year ({apy!.toFixed(1)}% APY, after commission)
            </div>
          ) : null}
        </div>

        <button
          type="button"
          className="sp-btn sp-btnPrimary"
          style={{ marginTop: 16, width: '100%' }}
          disabled={busy || !amountIka.trim() || ikaBalance <= 0}
          onClick={() => void onStake()}
        >
          {busy ? 'Submitting…' : 'Stake'}
        </button>

        {err ? (
          <p style={{ color: 'rgba(255,99,132,0.95)', fontSize: 12, marginTop: 12 }}>{err}</p>
        ) : null}
      </div>
    );
  }

  // -------- list view --------
  return (
    <div className="sp-page" ref={listScrollRef}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
        <h2 className="sp-pageTitle" style={{ margin: 0 }}>IKA staking</h2>
        <button
          type="button"
          className="sp-btn sp-btn--ghost"
          style={{ padding: '6px 10px', minHeight: 0, fontSize: 11 }}
          onClick={() => void refreshAll()}
          disabled={busy}
          aria-label="Refresh staking data"
        >
          ⟳ {ageSeconds != null ? formatAgeSeconds(ageSeconds) : 'refreshing…'}
        </button>
      </div>
      {snapshot ? (
        <div className="sp-muted" style={{ fontSize: 12, marginTop: 4 }}>
          Epoch {snapshot.epoch}
          {countdownMs != null ? ` · ends in ${formatCountdown(countdownMs)}` : ''}
        </div>
      ) : (
        <div className="sp-muted" style={{ fontSize: 12, marginTop: 4 }}>Loading epoch…</div>
      )}

      {feeAddr ? (
        <div style={{ marginTop: 12 }}>
          <div className="sp-muted" style={{ fontSize: 11, marginBottom: 4 }}>
            fee / stake owner · {ikaBalance.toLocaleString('en-US', { maximumFractionDigits: 4 })} IKA
          </div>
          <ExplorerValueRow
            fullValue={feeAddr}
            href={feeHref}
            truncateMid={{ head: 10, tail: 10 }}
            copyLabel="Copy fee payer address"
          />
        </div>
      ) : null}

      <div
        style={{
          marginTop: 14,
          display: 'flex',
          gap: 6,
          alignItems: 'center',
        }}
      >
        <input
          className="wc-input"
          style={{ flex: 1, fontSize: 12 }}
          placeholder="Search validators"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search validators by name or address"
        />
        <select
          className="wc-input"
          style={{ fontSize: 12, width: 'auto', minWidth: 120 }}
          value={sortKey}
          onChange={(e) => setSortKey(e.target.value as SortKey)}
          aria-label="Sort validators"
        >
          <option value="stake">Total stake</option>
          <option value="commission">Commission</option>
          <option value="apy">~APY</option>
          <option value="name">Name</option>
        </select>
      </div>

      <div style={{ marginTop: 10 }}>
        {validators.length === 0 && validatorsFetchedAt != null ? (
          <div
            style={{
              padding: 14,
              borderRadius: 10,
              border: '1px solid rgba(255,255,255,0.08)',
              fontSize: 12,
              textAlign: 'center',
            }}
          >
            No validators discovered yet on this network. Try refreshing.
            <div style={{ marginTop: 10 }}>
              <button
                type="button"
                className="sp-btn"
                onClick={() => void refreshValidators()}
                disabled={busy}
              >
                Refresh validators
              </button>
            </div>
          </div>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {filteredSorted.map((v) => (
              <li key={v.objectId} style={{ marginBottom: 6 }}>
                <ValidatorRowButton
                  v={v}
                  apy={apyByValidatorId.get(v.objectId) ?? null}
                  onClick={() => openStakeSubview(v.objectId)}
                  disabled={busy}
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      <h3 className="sp-sectionTitle" style={{ marginTop: 22, marginBottom: 8 }}>Your stakes</h3>
      {positions.length === 0 ? (
        <p className="sp-muted" style={{ fontSize: 12 }}>
          No staked positions yet. Pick a validator above to start.
        </p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {positions.map((p) => {
            const v = p.validatorId ? validatorById.get(p.validatorId) : undefined;
            const principalIka = p.principalBaseUnits ? ikaFromBaseUnits(p.principalBaseUnits) : null;
            return (
              <li
                key={p.objectId}
                style={{
                  border: '1px solid rgba(255,255,255,0.08)',
                  borderRadius: 10,
                  padding: 10,
                  marginBottom: 8,
                  fontSize: 12,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }}>
                      {v?.name ?? (p.validatorId ? midTruncate(p.validatorId) : 'Unknown validator')}
                    </div>
                    {principalIka != null ? (
                      <div className="sp-muted" style={{ fontSize: 11, marginTop: 2 }}>
                        {principalIka.toLocaleString('en-US', { maximumFractionDigits: 4 })} IKA staked
                      </div>
                    ) : null}
                    {p.activationEpoch != null ? (
                      <div className="sp-muted" style={{ fontSize: 11 }}>
                        from epoch {p.activationEpoch}
                      </div>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    className="sp-btn"
                    style={{ minHeight: 0, padding: '6px 10px' }}
                    disabled={busy}
                    onClick={() => void onWithdraw(p.objectId)}
                  >
                    Withdraw
                  </button>
                </div>
                <div style={{ marginTop: 8 }}>
                  <div className="sp-muted" style={{ fontSize: 10, marginBottom: 2 }}>
                    staked object
                  </div>
                  <ExplorerValueRow
                    fullValue={p.objectId}
                    href={buildSuiExplorerUrl(explorerPrefs, suiNetId, 'object', p.objectId)}
                    truncateMid={{ head: 8, tail: 6 }}
                    copyLabel="Copy staked object id"
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {err ? (
        <p style={{ color: 'rgba(255,99,132,0.95)', fontSize: 12, marginTop: 12 }}>{err}</p>
      ) : null}
    </div>
  );
}

function ValidatorAvatar({ name }: { name: string }) {
  const initial = name.trim().charAt(0).toUpperCase() || '?';
  return (
    <div
      aria-hidden
      style={{
        width: 28,
        height: 28,
        borderRadius: 999,
        background:
          'linear-gradient(135deg, color-mix(in oklch, var(--ika, oklch(0.68 0.2 15)) 60%, transparent), color-mix(in oklch, var(--accent-2, oklch(0.72 0.18 290)) 60%, transparent))',
        display: 'grid',
        placeItems: 'center',
        fontSize: 13,
        fontWeight: 700,
        color: '#fff',
        flexShrink: 0,
      }}
    >
      {initial}
    </div>
  );
}

function StatusPill({ status }: { status: ValidatorRow['status'] }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '2px 6px',
        borderRadius: 999,
        fontSize: 10,
        fontWeight: 600,
        color: STATUS_COLORS[status],
        border: `1px solid ${STATUS_COLORS[status]}`,
        background: 'transparent',
        whiteSpace: 'nowrap',
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: 999, background: STATUS_COLORS[status] }} />
      {STATUS_LABELS[status]}
    </span>
  );
}

function ValidatorRowButton({
  v,
  apy,
  onClick,
  disabled,
}: {
  v: ValidatorRow;
  apy: number | null;
  onClick: () => void;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        width: '100%',
        textAlign: 'left',
        background: 'transparent',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 10,
        padding: 10,
        color: 'inherit',
        font: 'inherit',
        cursor: disabled ? 'default' : 'pointer',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
      aria-label={`Stake to ${v.name}`}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <ValidatorAvatar name={v.name} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {v.name}
          </div>
          <div className="sp-muted" style={{ fontSize: 11, fontFamily: 'var(--theme-font-mono, monospace)' }}>
            {midTruncate(v.objectId, 8, 6)}
          </div>
        </div>
        <StatusPill status={v.status} />
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr 1fr',
          gap: 6,
          fontSize: 11,
        }}
      >
        <div>
          <div className="sp-muted" style={{ fontSize: 10 }}>commission</div>
          <div style={{ fontWeight: 600 }}>{(v.commissionRateBps / 100).toFixed(1)}%</div>
        </div>
        <div>
          <div className="sp-muted" style={{ fontSize: 10 }}>~APY</div>
          <div style={{ fontWeight: 600 }}>{apy != null ? `${apy.toFixed(1)}%` : '—'}</div>
        </div>
        <div>
          <div className="sp-muted" style={{ fontSize: 10 }}>total stake</div>
          <div style={{ fontWeight: 600 }}>{formatIkaAmount(v.totalStakeBaseUnits)} IKA</div>
        </div>
      </div>
    </button>
  );
}

function ValidatorHeaderCard({
  v,
  apy,
  suiNetId,
  explorerPrefs,
}: {
  v: ValidatorRow;
  apy: number | null;
  suiNetId: string;
  explorerPrefs: ReturnType<typeof useExplorerPreferences>;
}) {
  return (
    <div
      style={{
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 10,
        padding: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <ValidatorAvatar name={v.name} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 13 }}>{v.name}</div>
          <div className="sp-muted" style={{ fontSize: 11, marginTop: 2 }}>
            {(v.commissionRateBps / 100).toFixed(1)}% commission · {apy != null ? `~${apy.toFixed(1)}% APY` : '—'}
          </div>
        </div>
        <StatusPill status={v.status} />
      </div>
      <ExplorerValueRow
        fullValue={v.objectId}
        href={buildSuiExplorerUrl(explorerPrefs, suiNetId, 'object', v.objectId)}
        truncateMid={{ head: 8, tail: 6 }}
        copyLabel="Copy validator id"
      />
      <div className="sp-muted" style={{ fontSize: 11 }}>
        Total stake: {formatIkaAmount(v.totalStakeBaseUnits)} IKA
      </div>
    </div>
  );
}
