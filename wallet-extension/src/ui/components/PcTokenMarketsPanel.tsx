/**
 * settings panel for managing PC-Token markets. replaces the legacy `PrivateBalancesPanel`. each
 * market is a `(splMint, programId, mintAuthority?)` deployment; users add at least one before
 * the wrap / hidden-transfer / unwrap UI on the Portfolio page lights up.
 *
 * multiple markets are allowed (e.g. `pcUSDC` + `pcUSDC-friends`). the active market is the
 * default for new flows; UI elsewhere can override per-call by passing `marketId`.
 *
 * disclaimer reset is hidden behind advanced mode (debug-only).
 */

import { useCallback, useEffect, useState } from 'react';
import { Lock, AlertTriangle, Loader2, Plus, Trash2, Check, RefreshCw } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { DEMO_SPL_USDC_DECIMALS, DEMO_SPL_USDC_MINT_DEVNET } from '@/background/encrypt-pc/pc-token-program';

type MarketsList = Awaited<ReturnType<typeof trpc.listPcTokenMarkets.query>>;
type Market = MarketsList['markets'][number];

function shortB58(s: string, head = 6, tail = 4): string {
  if (s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

export function PcTokenMarketsPanel({ advanced }: { advanced: boolean }) {
  const [data, setData] = useState<MarketsList | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);

  const refresh = useCallback(async () => {
    setErr(null);
    try {
      const r = await trpc.listPcTokenMarkets.query();
      setData(r);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      await refresh();
      setLoading(false);
    })();
  }, [refresh]);

  return (
    <section className="sp-settingsSection">
      <h3 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Lock size={14} /> PC-Token markets (encrypt.xyz)
      </h3>
      <div className="sp-prealphaPill" style={{ marginBottom: 8 }}>
        <AlertTriangle size={10} />
        encrypt.xyz pre-alpha · sender visible · dev preview
      </div>
      <p className="sp-muted" style={{ fontSize: 12, margin: '0 0 10px 0', lineHeight: 1.4 }}>
        Add a deployed PC-Token program to enable encrypted balance flows on the Portfolio + Send
        pages. Two installs that exchange pcTokens must agree on BOTH program ID and mint
        authority — share market entries by exporting the values below.
      </p>

      {err && (
        <div className="sp-error" style={{ marginBottom: 8 }}>
          {err}
        </div>
      )}

      {loading ? (
        <div className="sp-muted" style={{ fontSize: 12 }}>
          <Loader2 size={12} className="sp-spin" /> loading markets…
        </div>
      ) : !data || data.markets.length === 0 ? (
        <div className="sp-muted" style={{ fontSize: 12, marginBottom: 10 }}>
          No PC-Token deployment configured yet. Click <strong>add market</strong> below after
          self-deploying the pinocchio variant (see <code>wallet-extension/docs/PC_TOKEN.md</code>).
        </div>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 10px 0', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {data.markets.map((m) => (
            <MarketRow
              key={m.id}
              market={m}
              isActive={data.activeMarketId === m.id}
              onChanged={refresh}
            />
          ))}
        </ul>
      )}

      <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
        <button
          type="button"
          className="sp-btn sp-btn--primary"
          onClick={() => setShowAdd((v) => !v)}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
        >
          <Plus size={11} /> {showAdd ? 'cancel' : 'add market'}
        </button>
        <button
          type="button"
          className="sp-btn"
          onClick={() => void refresh()}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
        >
          <RefreshCw size={11} /> refresh
        </button>
      </div>

      {showAdd && (
        <AddMarketForm
          existingIds={data?.markets.map((m) => m.id) ?? []}
          onCancel={() => setShowAdd(false)}
          onAdded={async () => {
            setShowAdd(false);
            await refresh();
          }}
        />
      )}

      <details style={{ marginTop: 8 }}>
        <summary className="sp-muted" style={{ fontSize: 11, cursor: 'pointer' }}>
          how to deploy a PC-Token program (~5 minutes, requires solana CLI + cargo build-sbf)
        </summary>
        <pre
          style={{
            fontSize: 10,
            background: 'rgba(255,255,255,0.04)',
            padding: 8,
            borderRadius: 4,
            overflowX: 'auto',
            marginTop: 6,
          }}
        >{`# clone + build the pinocchio variant
git clone https://github.com/dwallet-labs/encrypt-pre-alpha
cd encrypt-pre-alpha
cargo build-sbf --manifest-path \\
  chains/solana/examples/pc-token/pinocchio/Cargo.toml

# fund a deployer keypair on devnet (~3-5 SOL needed)
solana config set --url devnet
solana airdrop 5

# deploy
solana program deploy \\
  target/deploy/pc_token.so

# the command prints "Program Id: <base58>" — paste it in "add market" above`}</pre>
      </details>

      {advanced && <DisclaimerResetRow />}
    </section>
  );
}

function MarketRow({
  market,
  isActive,
  onChanged,
}: {
  market: Market;
  isActive: boolean;
  onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function setActive() {
    setBusy(true);
    setErr(null);
    try {
      await trpc.setActivePcTokenMarket.mutate({ marketId: market.id });
      await onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirm(`Remove market "${market.label}"? Existing on-chain pcToken balances are not affected.`)) return;
    setBusy(true);
    setErr(null);
    try {
      await trpc.removePcTokenMarket.mutate({ marketId: market.id });
      await onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li
      style={{
        background: isActive ? 'rgba(134,239,172,0.06)' : 'rgba(255,255,255,0.03)',
        borderRadius: 4,
        padding: 8,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <strong style={{ fontSize: 13 }}>{market.label}</strong>
        {isActive && (
          <span
            style={{
              fontSize: 10,
              padding: '1px 6px',
              borderRadius: 8,
              background: 'rgba(134,239,172,0.15)',
              color: '#86efac',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 3,
            }}
          >
            <Check size={9} /> active
          </span>
        )}
        <span
          style={{
            fontSize: 10,
            padding: '1px 6px',
            borderRadius: 8,
            background: 'rgba(255,255,255,0.06)',
            color: 'rgba(255,255,255,0.6)',
            marginLeft: 'auto',
          }}
        >
          {market.network}
        </span>
      </div>
      <div className="sp-muted" style={{ fontSize: 10, fontFamily: 'monospace' }}>
        {market.splSymbol} · mint <code>{shortB58(market.splMint, 8, 6)}</code> · program{' '}
        <code>{shortB58(market.programId, 8, 6)}</code>
      </div>
      {market.mintAuthorityB58 && (
        <div className="sp-muted" style={{ fontSize: 10, fontFamily: 'monospace' }}>
          mint auth <code>{shortB58(market.mintAuthorityB58, 8, 6)}</code>
        </div>
      )}
      {err && <div className="sp-error" style={{ fontSize: 10 }}>{err}</div>}
      <div style={{ display: 'flex', gap: 6, marginTop: 2 }}>
        {!isActive && (
          <button
            type="button"
            className="sp-btn sp-btn--ghost"
            onClick={() => void setActive()}
            disabled={busy}
            style={{ fontSize: 11, padding: '2px 8px' }}
          >
            set active
          </button>
        )}
        <button
          type="button"
          className="sp-btn sp-btn--ghost"
          onClick={() => void remove()}
          disabled={busy}
          style={{
            fontSize: 11,
            padding: '2px 8px',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            color: '#fca5a5',
          }}
        >
          <Trash2 size={10} /> remove
        </button>
      </div>
    </li>
  );
}

function AddMarketForm({
  existingIds,
  onCancel,
  onAdded,
}: {
  existingIds: string[];
  onCancel: () => void;
  onAdded: () => Promise<void>;
}) {
  const [id, setId] = useState('pcUSDC');
  const [label, setLabel] = useState('pcUSDC (devnet)');
  const [splMint, setSplMint] = useState(DEMO_SPL_USDC_MINT_DEVNET);
  const [splSymbol, setSplSymbol] = useState('USDC');
  const [splDecimals, setSplDecimals] = useState(DEMO_SPL_USDC_DECIMALS);
  const [programId, setProgramId] = useState('');
  const [mintAuthorityB58, setMintAuthorityB58] = useState('');
  const [network, setNetwork] = useState<'sol-devnet' | 'sol-mainnet'>('sol-devnet');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // auto-suggest a unique id when the user has typed an existing one
  const idClash = existingIds.includes(id);

  async function submit() {
    setErr(null);
    if (!id.trim()) return setErr('id is required');
    if (!label.trim()) return setErr('label is required');
    if (!splMint.trim()) return setErr('splMint is required');
    if (!splSymbol.trim()) return setErr('splSymbol is required');
    if (!programId.trim()) return setErr('programId is required');
    if (idClash) return setErr(`id "${id}" already exists`);

    setBusy(true);
    try {
      await trpc.addPcTokenMarket.mutate({
        id: id.trim(),
        label: label.trim(),
        splMint: splMint.trim(),
        splSymbol: splSymbol.trim(),
        splDecimals,
        programId: programId.trim(),
        mintAuthorityB58: mintAuthorityB58.trim() || undefined,
        network,
      });
      await onAdded();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ background: 'rgba(255,255,255,0.04)', borderRadius: 4, padding: 10, marginBottom: 8 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <Field label="id (slug)">
          <input
            type="text"
            className="sp-input"
            value={id}
            onChange={(e) => setId(e.target.value)}
            placeholder="pcUSDC"
            disabled={busy}
            style={{ fontSize: 12 }}
          />
          {idClash && <div className="sp-error" style={{ fontSize: 10 }}>that id is already used</div>}
        </Field>
        <Field label="label (shown in UI)">
          <input
            type="text"
            className="sp-input"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="pcUSDC (devnet)"
            disabled={busy}
            style={{ fontSize: 12 }}
          />
        </Field>
        <Field label="program ID (deployed PC-Token program, base58)">
          <input
            type="text"
            className="sp-input"
            value={programId}
            onChange={(e) => setProgramId(e.target.value)}
            placeholder="paste base58 program ID"
            disabled={busy}
            style={{ fontSize: 11, fontFamily: 'monospace' }}
          />
        </Field>
        <Field label="SPL mint (the asset being wrapped)">
          <input
            type="text"
            className="sp-input"
            value={splMint}
            onChange={(e) => setSplMint(e.target.value)}
            disabled={busy}
            style={{ fontSize: 11, fontFamily: 'monospace' }}
          />
        </Field>
        <div style={{ display: 'flex', gap: 6 }}>
          <Field label="symbol">
            <input
              type="text"
              className="sp-input"
              value={splSymbol}
              onChange={(e) => setSplSymbol(e.target.value)}
              disabled={busy}
              style={{ fontSize: 12 }}
            />
          </Field>
          <Field label="decimals">
            <input
              type="number"
              className="sp-input"
              value={splDecimals}
              onChange={(e) => setSplDecimals(Number(e.target.value))}
              min={0}
              max={18}
              disabled={busy}
              style={{ fontSize: 12 }}
            />
          </Field>
          <Field label="network">
            <select
              className="sp-input"
              value={network}
              onChange={(e) => setNetwork(e.target.value as 'sol-devnet' | 'sol-mainnet')}
              disabled={busy}
              style={{ fontSize: 12 }}
            >
              <option value="sol-devnet">sol-devnet</option>
              <option value="sol-mainnet">sol-mainnet</option>
            </select>
          </Field>
        </div>
        <Field label="mint authority override (optional, base58)">
          <input
            type="text"
            className="sp-input"
            value={mintAuthorityB58}
            onChange={(e) => setMintAuthorityB58(e.target.value)}
            placeholder="leave blank to use active dWallet ed25519"
            disabled={busy}
            style={{ fontSize: 11, fontFamily: 'monospace' }}
          />
        </Field>
        {err && <div className="sp-error" style={{ fontSize: 11 }}>{err}</div>}
        <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
          <button
            type="button"
            className="sp-btn sp-btn--primary"
            onClick={() => void submit()}
            disabled={busy || idClash}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
          >
            {busy ? <><Loader2 size={11} className="sp-spin" /> saving…</> : <><Plus size={11} /> add market</>}
          </button>
          <button type="button" className="sp-btn" onClick={onCancel} disabled={busy}>
            cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1 }}>
      <span className="sp-muted" style={{ fontSize: 10 }}>{label}</span>
      {children}
    </label>
  );
}

function DisclaimerResetRow() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function reset() {
    setBusy(true);
    setMsg(null);
    try {
      await trpc.resetPcDisclaimer.mutate();
      setMsg('disclaimer ack reset for this vault');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginTop: 8, padding: 8, background: 'rgba(255,255,255,0.03)', borderRadius: 4 }}>
      <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 4 }}>debug</div>
      <button
        type="button"
        className="sp-btn sp-btn--ghost"
        onClick={() => void reset()}
        disabled={busy}
        style={{ fontSize: 11 }}
      >
        reset hidden-send disclaimer ack
      </button>
      {msg && <div className="sp-muted" style={{ fontSize: 10, marginTop: 4 }}>{msg}</div>}
    </div>
  );
}
