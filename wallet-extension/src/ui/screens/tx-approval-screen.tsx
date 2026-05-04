import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { trpc } from '@/lib/trpc';
import { getTxApprovalDebugBuildEnvRows } from '@/lib/tx-approval-debug-build-env';
import { ApprovalShell } from '@/ui/components/ApprovalShell';

function TxApprovalBuildEnvPanel() {
  const snap = useMemo(() => getTxApprovalDebugBuildEnvRows(), []);
  const cell: CSSProperties = {
    fontSize: 10,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    color: 'rgba(234,240,255,0.78)',
    padding: '3px 0',
    verticalAlign: 'top',
  };
  const rawShow = (r: string | null) => (r === null || r === '' ? '(unset)' : r);
  return (
    <div
      style={{
        background: 'rgba(15,23,42,0.55)',
        border: '1px solid rgba(99,102,241,0.22)',
        borderRadius: 12,
        padding: '8px 10px',
        marginBottom: 12,
      }}
    >
      <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.45, color: 'rgba(234,240,255,0.5)', marginBottom: 6 }}>
        build env (vite, this popup bundle)
      </div>
      <div style={{ ...cell, color: 'rgba(234,240,255,0.45)', marginBottom: 6, lineHeight: 1.35 }}>
        stamp <span style={{ color: 'rgba(234,240,255,0.72)' }}>{snap.buildStamp}</span>
        {' · '}
        mode {snap.mode}
        {snap.dev ? ' · dev' : ''}
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={{ ...cell, textAlign: 'left', color: 'rgba(234,240,255,0.45)', fontWeight: 600, paddingBottom: 4 }}>var</th>
            <th style={{ ...cell, textAlign: 'left', color: 'rgba(234,240,255,0.45)', fontWeight: 600, paddingBottom: 4 }}>raw</th>
          </tr>
        </thead>
        <tbody>
          {snap.rows.map((r) => (
            <tr key={r.key}>
              <td style={{ ...cell, color: 'rgba(165,180,252,0.9)', paddingRight: 8, whiteSpace: 'nowrap' }}>{r.key}</td>
              <td style={cell}>{rawShow(r.raw)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ ...cell, marginTop: 8, lineHeight: 1.45, color: 'rgba(234,240,255,0.55)' }}>
        <span style={{ color: 'rgba(234,240,255,0.42)' }}>effective</span>
        {' · '}
        ika bench{' '}
        <strong style={{ color: snap.effective.ikaTxBench ? 'rgba(52,211,153,0.95)' : 'rgba(248,113,113,0.9)' }}>
          {snap.effective.ikaTxBench ? 'on' : 'off'}
        </strong>
        {' · '}
        bench auto-download{' '}
        <strong style={{ color: snap.effective.ikaTxBenchAutoDownload ? 'rgba(52,211,153,0.95)' : 'rgba(248,113,113,0.9)' }}>
          {snap.effective.ikaTxBenchAutoDownload ? 'on' : 'off'}
        </strong>
        {' · '}
        sui graphql console{' '}
        <strong style={{ color: snap.effective.suiGraphqlConsoleDebug ? 'rgba(52,211,153,0.95)' : 'rgba(248,113,113,0.9)' }}>
          {snap.effective.suiGraphqlConsoleDebug ? 'on' : 'off'}
        </strong>
        {' · '}
        gql pagination capture{' '}
        <strong style={{ color: snap.effective.suiGraphqlPaginationCapture ? 'rgba(52,211,153,0.95)' : 'rgba(248,113,113,0.9)' }}>
          {snap.effective.suiGraphqlPaginationCapture ? 'on' : 'off'}
        </strong>
      </div>
      <div style={{ ...cell, marginTop: 6, fontSize: 9, color: 'rgba(234,240,255,0.38)', lineHeight: 1.4 }}>
        ika bench lines log in the service worker devtools, not this window. rebuild after changing `.env` so both bundles pick up vars.
      </div>
    </div>
  );
}

export function ApproveTxScreen({ requestId }: { requestId: string }) {
  type Meta = Awaited<ReturnType<typeof trpc.getTxApprovalRequest.query>>;
  type GasOpts = Awaited<ReturnType<typeof trpc.getTxGasOptions.query>>;
  type SimPrev = Awaited<ReturnType<typeof trpc.getTxSimulationPreview.query>>;
  const [meta, setMeta] = useState<Meta | null>(null);
  const [gasOpts, setGasOpts] = useState<GasOpts | null>(null);
  const [simPreview, setSimPreview] = useState<SimPrev | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [progressLabel, setProgressLabel] = useState<string | null>(null);
  const [progressElapsed, setProgressElapsed] = useState(0);
  const [selectedSpeed, setSelectedSpeed] = useState<'slow' | 'normal' | 'fast' | 'custom'>('normal');
  const [customGas, setCustomGas] = useState('');
  const [customMaxFee, setCustomMaxFee] = useState('');
  const [customPriority, setCustomPriority] = useState('');
  const [customGasPrice, setCustomGasPrice] = useState('');

  useEffect(() => {
    trpc.getTxApprovalRequest.query({ id: requestId })
      .then(setMeta)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    trpc.getTxGasOptions.query({ id: requestId })
      .then((r) => {
        setGasOpts(r);
        const normal = r.presets.find((x) => x.name === 'normal') ?? r.presets[0];
        if (normal) {
          setSelectedSpeed('normal');
          setCustomGas(normal.gas);
          if (r.feeMode === 'legacy') {
            setCustomGasPrice(normal.gasPrice ?? '');
            setCustomMaxFee('');
            setCustomPriority('');
          } else {
            setCustomMaxFee(normal.maxFeePerGas ?? '');
            setCustomPriority(normal.maxPriorityFeePerGas ?? '');
            setCustomGasPrice('');
          }
        }
      })
      .catch(() => {});
    trpc.getTxSimulationPreview.query({ id: requestId })
      .then(setSimPreview)
      .catch(() => setSimPreview(null));
  }, [requestId]);

  // poll signing progress while busy; compute elapsed client-side so the timer
  // keeps ticking even when the service worker is blocked on crypto operations
  const [progressStartedAt, setProgressStartedAt] = useState<number | null>(null);
  useEffect(() => {
    if (!busy) { setProgressLabel(null); setProgressElapsed(0); setProgressStartedAt(null); return; }
    if (!progressStartedAt) setProgressStartedAt(Date.now());
    const pollIv = setInterval(() => {
      trpc.signingProgress.query()
        .then((p) => {
          if (p) {
            setProgressLabel(p.detail ? `${p.label} — ${p.detail}` : p.label);
          }
        })
        .catch(() => {});
    }, 800);
    const tickIv = setInterval(() => {
      setProgressElapsed((prev) => prev + 1000);
    }, 1000);
    return () => { clearInterval(pollIv); clearInterval(tickIv); };
  }, [busy]);

  async function onApprove() {
    setBusy(true);
    setError(null);
    try {
      const preset = gasOpts?.presets.find((x) => x.name === selectedSpeed);
      const legacy = gasOpts?.feeMode === 'legacy';
      const overrides = selectedSpeed === 'custom'
        ? {
            gas: customGas || null,
            maxFeePerGas: legacy ? null : customMaxFee || null,
            maxPriorityFeePerGas: legacy ? null : customPriority || null,
            gasPrice: legacy ? customGasPrice || null : null,
          }
        : preset
          ? {
              gas: preset.gas,
              maxFeePerGas: legacy ? null : preset.maxFeePerGas,
              maxPriorityFeePerGas: legacy ? null : preset.maxPriorityFeePerGas,
              gasPrice: legacy ? preset.gasPrice : null,
            }
          : undefined;
      const r = await trpc.approveTxRequest.mutate({ id: requestId, overrides });
      setDone(r.txHash);
      setTimeout(() => window.close(), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onReject() {
    try { await trpc.rejectTxRequest.mutate({ id: requestId, reason: 'user rejected' }); } catch { /* noop */ }
    window.close();
  }

  const row: CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '6px 0', borderBottom: '1px solid rgba(255,255,255,0.07)', fontSize: 12 };
  const lbl: CSSProperties = { color: 'rgba(234,240,255,0.55)', flexShrink: 0, marginRight: 10 };
  const val: CSSProperties = { wordBreak: 'break-all', textAlign: 'right', fontFamily: 'monospace', fontSize: 11 };

  if (!meta) {
    return (
      <div className="wc-approvalSheet">
        {error ? <p style={{ color: 'rgba(255,99,132,0.95)' }}>{error}</p> : <p>loading…</p>}
      </div>
    );
  }

  const { decoded } = meta;

  return (
    <ApprovalShell
      title="send transaction?"
      origin={meta.origin}
      busy={busy}
      approveDisabled={!!done}
      busyLabel="signing..."
      approveLabel={meta?.signOnly ? 'approve & sign (no broadcast)' : 'approve & send'}
      onApprove={() => void onApprove()}
      onReject={onReject}
      error={error}
      success={done ? `sent! ${done}` : undefined}
    >
      <TxApprovalBuildEnvPanel />

      <div style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.10)', borderRadius: 14, padding: '10px 12px', marginBottom: 12 }}>
        <div style={row}>
          <span style={lbl}>to</span>
          <span style={val}>{decoded.to}</span>
        </div>
        <div style={row}>
          <span style={lbl}>value</span>
          <span style={{ ...val, fontFamily: 'inherit', fontWeight: 700 }}>{decoded.valueFormatted}</span>
        </div>
        {decoded.functionName && (
          <div style={row}>
            <span style={lbl}>function</span>
            <span style={val}>{decoded.functionName}</span>
          </div>
        )}
        {decoded.dataLength > 0 && (
          <div style={row}>
            <span style={lbl}>data</span>
            <span style={val}>{decoded.dataLength} bytes {decoded.selector ? `(${decoded.selector})` : ''}</span>
          </div>
        )}
        <div style={{ ...row, borderBottom: 'none' }}>
          <span style={lbl}>chain</span>
          <span style={val}>id {meta.chainId}</span>
        </div>
      </div>

      {decoded.warnings.length > 0 && (
        <div style={{ background: 'rgba(245,158,11,0.10)', border: '1px solid rgba(245,158,11,0.30)', borderRadius: 12, padding: '8px 12px', marginBottom: 12 }}>
          {decoded.warnings.map((w, i) => (
            <div key={i} style={{ fontSize: 12, color: 'rgba(245,158,11,0.95)', lineHeight: 1.5 }}>⚠ {w}</div>
          ))}
        </div>
      )}

      {simPreview && (
        <div
          style={{
            background: simPreview.ok ? 'rgba(16,185,129,0.08)' : 'rgba(248,113,113,0.10)',
            border: `1px solid ${simPreview.ok ? 'rgba(16,185,129,0.28)' : 'rgba(248,113,113,0.35)'}`,
            borderRadius: 12,
            padding: '8px 12px',
            marginBottom: 12,
          }}
        >
          <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4, color: 'rgba(234,240,255,0.62)', marginBottom: 6 }}>
            rpc simulation (eth_call)
          </div>
          <div style={{ fontSize: 12, lineHeight: 1.45, color: 'rgba(234,240,255,0.9)' }}>{simPreview.detail}</div>
        </div>
      )}

      {gasOpts && (
        <div className="wc-section" style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4, color: 'rgba(234,240,255,0.62)', marginBottom: 8 }}>
            network fee {gasOpts.feeMode === 'legacy' ? '(legacy gas price)' : '(eip-1559)'}
          </div>
          {gasOpts.gasEstimateNote && (
            <div style={{ fontSize: 11, color: 'rgba(245,158,11,0.92)', marginBottom: 8, lineHeight: 1.45 }}>
              {gasOpts.gasEstimateNote}
            </div>
          )}
          <div style={{ display: 'grid', gap: 8 }}>
            {gasOpts.presets.map((p) => (
              <button
                key={p.name}
                type="button"
                className="wc-btn"
                onClick={() => {
                  setSelectedSpeed(p.name);
                  setCustomGas(p.gas);
                  if (gasOpts.feeMode === 'legacy') {
                    setCustomGasPrice(p.gasPrice ?? '');
                    setCustomMaxFee('');
                    setCustomPriority('');
                  } else {
                    setCustomMaxFee(p.maxFeePerGas ?? '');
                    setCustomPriority(p.maxPriorityFeePerGas ?? '');
                    setCustomGasPrice('');
                  }
                }}
                style={{
                  textAlign: 'left',
                  borderColor: selectedSpeed === p.name ? 'rgba(99,102,241,0.95)' : undefined,
                  background: selectedSpeed === p.name ? 'rgba(99,102,241,0.18)' : undefined,
                }}
              >
                {selectedSpeed === p.name ? '✓ ' : ''}
                {p.name}
                {'gasPriceGwei' in p
                  ? ` - ${p.gasPriceGwei.toFixed(4)} gwei (legacy)`
                  : ` - ${p.maxFeePerGasGwei.toFixed(4)} gwei`}
                {' '}
                - est {p.estimatedNative.toFixed(6)} {gasOpts.nativeSymbol}
                {p.estimatedUsd != null ? ` (~$${p.estimatedUsd.toFixed(2)})` : ''}
              </button>
            ))}
            <button
              type="button"
              className="wc-btn"
              onClick={() => setSelectedSpeed('custom')}
              style={{
                textAlign: 'left',
                borderColor: selectedSpeed === 'custom' ? 'rgba(99,102,241,0.95)' : undefined,
                background: selectedSpeed === 'custom' ? 'rgba(99,102,241,0.18)' : undefined,
              }}
            >
              {selectedSpeed === 'custom' ? '✓ ' : ''}custom
            </button>
          </div>
          {selectedSpeed === 'custom' && (
            <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
              <input value={customGas} onChange={(e) => setCustomGas(e.target.value)} placeholder="gas limit hex (e.g. 0x30d40)" />
              {gasOpts.feeMode === 'legacy' ? (
                <input value={customGasPrice} onChange={(e) => setCustomGasPrice(e.target.value)} placeholder="gas price hex (legacy)" />
              ) : (
                <>
                  <input value={customMaxFee} onChange={(e) => setCustomMaxFee(e.target.value)} placeholder="max fee per gas hex" />
                  <input value={customPriority} onChange={(e) => setCustomPriority(e.target.value)} placeholder="max priority fee per gas hex" />
                </>
              )}
            </div>
          )}
        </div>
      )}

      {!busy && !done && (
        <p style={{ fontSize: 11, color: 'rgba(234,240,255,0.55)', margin: '0 0 12px', lineHeight: 1.4 }}>
          signing via ika dWallet MPC. this may take 30-90s while the 2pc protocol completes.
        </p>
      )}

      {busy && (
        <div style={{
          background: 'rgba(99,102,241,0.08)',
          border: '1px solid rgba(99,102,241,0.25)',
          borderRadius: 12,
          padding: '10px 14px',
          marginBottom: 12,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <span style={{
              display: 'inline-block',
              width: 8, height: 8,
              borderRadius: '50%',
              background: 'rgba(99,102,241,0.95)',
              animation: 'pulse-dot 1.4s ease-in-out infinite',
            }} />
            <span style={{ fontSize: 12, color: 'rgba(234,240,255,0.9)', fontWeight: 600 }}>
              {progressLabel ?? 'starting...'}
            </span>
          </div>
          <div style={{ fontSize: 11, color: 'rgba(234,240,255,0.45)' }}>
            {progressElapsed > 0 ? `${Math.floor(progressElapsed / 1000)}s elapsed` : 'just started'}
          </div>
          <style>{`@keyframes pulse-dot { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }`}</style>
        </div>
      )}

      {meta?.signOnly && (
        <div
          style={{
            padding: '6px 8px',
            marginBottom: 12,
            fontSize: 11,
            lineHeight: 1.4,
            borderRadius: 6,
            background: 'rgba(252, 211, 77, 0.08)',
            border: '1px solid rgba(252, 211, 77, 0.3)',
            color: 'rgba(252, 211, 77, 0.95)',
          }}
        >
          <strong>sign only:</strong> the wallet signs this tx and returns the signed bytes;
          it does NOT broadcast. The caller (relayer / bundler / agent) submits through their
          own infrastructure. Nonce is reserved at sign time, but a slow caller can still race.
        </div>
      )}

    </ApprovalShell>
  );
}
