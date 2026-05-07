import { useCallback, useEffect, useState } from 'react';
import { trpc } from '@/lib/trpc';
import { buildSuiExplorerUrl } from '@/config/explorers';
import { feePayerExplorerHref } from '@/lib/explorer-href';
import { useExplorerPreferences } from '@/lib/use-explorer-preferences';
import { ExplorerValueRow } from '@/ui/components/ExplorerValueRow';
import type { Balances, Networks } from '@/ui/types';

type ValidatorRow = Awaited<ReturnType<typeof trpc.ikaStakingValidators.query>>[number];
type StakedRow = Awaited<ReturnType<typeof trpc.ikaStakingPositions.query>>[number];

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
  const [validatorId, setValidatorId] = useState('');
  const [amountIka, setAmountIka] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const [v, p] = await Promise.all([
        trpc.ikaStakingValidators.query(),
        trpc.ikaStakingPositions.query(),
      ]);
      setValidators(v);
      setPositions(p);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!validatorId && validators[0]?.validatorId) setValidatorId(validators[0].validatorId);
  }, [validators, validatorId]);

  async function onStake() {
    setBusy(true);
    setErr(null);
    try {
      const raw = amountIka.trim();
      if (!raw || !validatorId.trim()) throw new Error('validator id and amount required');
      const n = Number.parseFloat(raw);
      if (!Number.isFinite(n) || n <= 0) throw new Error('invalid amount');
      const base = BigInt(Math.floor(n * 1e9));
      await trpc.ikaStake.mutate({ validatorId: validatorId.trim(), amountBaseUnits: base.toString() });
      setAmountIka('');
      await load();
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
      await load();
      onDone?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (balances?.locked) {
    return null;
  }

  if (balances && 'ikaBase' in balances && balances.ikaBase === 'solana') {
    return (
      <div className="sp-page">
        <h2 className="sp-pageTitle">IKA staking</h2>
        <p className="sp-muted" style={{ marginTop: 8 }}>
          ika token staking uses the Sui ika system package. switch to a Sui-base vault (or create one) to stake here.
        </p>
      </div>
    );
  }

  const feeAddr = balances && !balances.locked && 'feePayerAddress' in balances ? balances.feePayerAddress : '';
  const suiNetId = networks?.active.suiNetworkId ?? 'sui-mainnet';
  const feeHref =
    feeAddr && balances && !balances.locked && 'network' in balances
      ? feePayerExplorerHref(explorerPrefs, networks, feeAddr, 'sui', balances.network)
      : null;

  return (
    <div className="sp-page">
      <h2 className="sp-pageTitle">IKA staking</h2>
      <p className="sp-muted" style={{ fontSize: 12, marginTop: 6, lineHeight: 1.45 }}>
        stakes IKA from your HD fee payer address (same IKA balance as portfolio). this is not the dWallet canonical Sui receive address when ED25519 is active — fund fee address with IKA for staking.
      </p>
      {feeAddr ? (
        <div style={{ marginTop: 10 }}>
          <div className="sp-muted" style={{ fontSize: 11, marginBottom: 4 }}>
            fee / stake owner
          </div>
          <ExplorerValueRow
            fullValue={feeAddr}
            href={feeHref}
            truncateMid={{ head: 10, tail: 10 }}
            copyLabel="Copy fee payer address"
          />
        </div>
      ) : null}

      <div style={{ marginTop: 16 }}>
        <label className="sp-muted" style={{ fontSize: 11, display: 'block', marginBottom: 4 }}>
          validator (object id)
        </label>
        {validators.length > 0 ? (
          <select
            className="wc-input"
            style={{ width: '100%', fontSize: 12, marginBottom: 8 }}
            value={validatorId}
            onChange={(e) => setValidatorId(e.target.value)}
          >
            {validators.map((v) => (
              <option key={v.objectId} value={v.validatorId}>
                {v.name} — {v.validatorId.slice(0, 10)}…
              </option>
            ))}
          </select>
        ) : null}
        <input
          className="wc-input"
          style={{ width: '100%', fontSize: 12 }}
          placeholder="0x… validator object id"
          value={validatorId}
          onChange={(e) => setValidatorId(e.target.value)}
        />
      </div>

      <div style={{ marginTop: 12 }}>
        <label className="sp-muted" style={{ fontSize: 11, display: 'block', marginBottom: 4 }}>
          amount (IKA)
        </label>
        <input
          className="wc-input"
          style={{ width: '100%', fontSize: 12 }}
          placeholder="e.g. 1.5"
          value={amountIka}
          onChange={(e) => setAmountIka(e.target.value)}
        />
      </div>

      <button
        type="button"
        className="sp-btn sp-btnPrimary"
        style={{ marginTop: 14, width: '100%' }}
        disabled={busy}
        onClick={() => void onStake()}
      >
        {busy ? 'working…' : 'stake IKA'}
      </button>

      <h3 style={{ fontSize: 13, marginTop: 22, marginBottom: 8 }}>your positions</h3>
      {positions.length === 0 ? (
        <p className="sp-muted" style={{ fontSize: 12 }}>
          no StakedIka objects on this fee address yet.
        </p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {positions.map((p) => (
            <li
              key={p.objectId}
              style={{
                border: '1px solid rgba(255,255,255,0.08)',
                borderRadius: 8,
                padding: 10,
                marginBottom: 8,
                fontSize: 12,
              }}
            >
              <div style={{ marginBottom: 6 }}>
                <div className="sp-muted" style={{ fontSize: 10, marginBottom: 4 }}>
                  staked object
                </div>
                <ExplorerValueRow
                  fullValue={p.objectId}
                  href={buildSuiExplorerUrl(explorerPrefs, suiNetId, 'object', p.objectId)}
                  truncateMid={{ head: 8, tail: 6 }}
                  copyLabel="Copy staked object id"
                />
              </div>
              {p.validatorId ? (
                <div style={{ marginTop: 6 }}>
                  <div className="sp-muted" style={{ fontSize: 10, marginBottom: 4 }}>
                    validator
                  </div>
                  <ExplorerValueRow
                    fullValue={p.validatorId}
                    href={buildSuiExplorerUrl(explorerPrefs, suiNetId, 'object', p.validatorId)}
                    truncateMid={{ head: 8, tail: 6 }}
                    copyLabel="Copy validator id"
                  />
                </div>
              ) : null}
              {p.principalBaseUnits ? (
                <div className="sp-muted" style={{ marginTop: 2 }}>
                  principal (raw): {p.principalBaseUnits}
                </div>
              ) : null}
              <button
                type="button"
                className="sp-btn"
                style={{ marginTop: 8 }}
                disabled={busy}
                onClick={() => void onWithdraw(p.objectId)}
              >
                withdraw / unlock
              </button>
            </li>
          ))}
        </ul>
      )}

      {err ? (
        <p style={{ color: 'rgba(255,99,132,0.95)', fontSize: 12, marginTop: 12 }}>{err}</p>
      ) : null}

      <button type="button" className="sp-btn" style={{ marginTop: 16 }} onClick={() => void load()} disabled={busy}>
        refresh
      </button>
    </div>
  );
}
