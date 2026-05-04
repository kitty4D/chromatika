import { useEffect, useState } from 'react';
import { trpc } from '@/lib/trpc';
import { ApprovalShell } from '@/ui/components/ApprovalShell';

export function DappApprovalScreen({ requestId }: { requestId: string }) {
  type Meta = Awaited<ReturnType<typeof trpc.getDappApprovalRequest.query>>;
  const [meta, setMeta] = useState<Meta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selectedSecpDwalletId, setSelectedSecpDwalletId] = useState('');
  const [selectedEd25519DwalletId, setSelectedEd25519DwalletId] = useState('');

  useEffect(() => {
    trpc.getDappApprovalRequest.query({ id: requestId })
      .then(setMeta)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [requestId]);

  useEffect(() => {
    const co = meta?.connectOptions;
    if (!co) return;
    if (co.mode === 'evm') {
      const d = co.defaultSecpDwalletId;
      setSelectedSecpDwalletId(d ?? '');
      setSelectedEd25519DwalletId('');
    } else {
      const d = co.defaultEd25519DwalletId;
      setSelectedEd25519DwalletId(d ?? '');
      setSelectedSecpDwalletId('');
    }
  }, [meta?.connectOptions]);

  async function onApprove(approved: boolean) {
    setBusy(true);
    setError(null);
    try {
      const isConnect = meta?.payload.kind === 'connect';
      const co = meta?.connectOptions;
      await trpc.approveDappConnection.mutate({
        id: requestId,
        approved,
        ...(isConnect && approved && co?.mode === 'evm' && selectedSecpDwalletId
          ? { secpDwalletId: selectedSecpDwalletId }
          : {}),
        ...(isConnect && approved && co?.mode === 'nonEvm' && selectedEd25519DwalletId
          ? { ed25519DwalletId: selectedEd25519DwalletId }
          : {}),
      });
      window.close();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const connectBlocked =
    meta?.payload.kind === 'connect' &&
    meta.connectOptions &&
    (meta.connectOptions.mode === 'evm'
      ? meta.connectOptions.hasNoActiveSecp ||
        (meta.connectOptions.choices.length > 0 && !selectedSecpDwalletId)
      : meta.connectOptions.hasNoActiveEd25519 ||
        (meta.connectOptions.choices.length > 0 && !selectedEd25519DwalletId));

  if (!meta) {
    return <div className="wc-approvalSheet">{error ?? 'loading…'}</div>;
  }

  return (
    <ApprovalShell
      title={meta.payload.kind.replace('_', ' ')}
      busy={busy}
      approveDisabled={!!connectBlocked}
      busyLabel="working…"
      onApprove={() => void onApprove(true)}
      onReject={() => void onApprove(false)}
      error={error}
    >
      <div className="wc-section" style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 11, color: 'rgba(234,240,255,0.62)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 }}>
          origin
        </div>
        <div style={{ fontWeight: 700, wordBreak: 'break-all' }}>{meta.payload.origin}</div>
        <div style={{ fontSize: 12, marginTop: 8 }}>method: <code>{meta.payload.method}</code></div>
      </div>
      {meta.payload.messagePreview && (
        <div className="wc-section" style={{ marginBottom: 12, fontSize: 12, wordBreak: 'break-all' }}>
          {meta.payload.messagePreview}
        </div>
      )}
      {meta.payload.typedDataPreview && (
        <div className="wc-section" style={{ marginBottom: 12, fontSize: 12, wordBreak: 'break-all' }}>
          {meta.payload.typedDataPreview}
        </div>
      )}
      {meta.payload.kind === 'add_chain' && meta.payload.addChain && (
        <div className="wc-section" style={{ marginBottom: 12, fontSize: 13 }}>
          <div style={{ fontSize: 11, color: 'rgba(234,240,255,0.62)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>
            add EVM network (EIP-3085)
          </div>
          <div style={{ fontWeight: 700 }}>{meta.payload.addChain.chainName}</div>
          <div style={{ fontSize: 12, marginTop: 6, opacity: 0.88 }}>
            chain id: {meta.payload.addChain.chainId}{' '}
            <span className="sp-muted" style={{ fontSize: 11 }}>
              (0x{meta.payload.addChain.chainId.toString(16)})
            </span>
          </div>
          <div style={{ fontSize: 12, wordBreak: 'break-all', marginTop: 6, opacity: 0.85 }}>
            rpc: <code style={{ fontSize: 11 }}>{meta.payload.addChain.rpcUrl}</code>
          </div>
          <div style={{ fontSize: 12, marginTop: 6, opacity: 0.85 }}>
            native: {meta.payload.addChain.symbol} · {meta.payload.addChain.decimals} decimals
          </div>
          {meta.payload.addChain.explorerUrl ? (
            <div style={{ fontSize: 12, marginTop: 6, opacity: 0.75, wordBreak: 'break-all' }}>
              explorer: {meta.payload.addChain.explorerUrl}
            </div>
          ) : null}
          {meta.payload.method === 'wallet_switchEthereumChain' ? (
            <p style={{ fontSize: 11, color: 'rgba(234,240,255,0.55)', margin: '10px 0 0', lineHeight: 1.45 }}>
              this site tried to switch to a chain that was not in your wallet yet. approving loads it from the public chainlist registry, saves it as a custom network, and switches.
            </p>
          ) : null}
        </div>
      )}
      {meta.payload.kind === 'switch_chain' && meta.payload.requestedChainId != null && (
        <div className="wc-section" style={{ marginBottom: 12, fontSize: 13 }}>
          <div style={{ fontSize: 11, color: 'rgba(234,240,255,0.62)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>
            switch EVM chain (EIP-3326)
          </div>
          <div style={{ fontSize: 12, opacity: 0.88 }}>
            chain id: {meta.payload.requestedChainId}{' '}
            <span className="sp-muted" style={{ fontSize: 11 }}>
              (0x{meta.payload.requestedChainId.toString(16)})
            </span>
          </div>
        </div>
      )}
      {meta.payload.kind === 'watch_token' && meta.payload.watchToken && (
        <div className="wc-section" style={{ marginBottom: 12, fontSize: 13 }}>
          <div style={{ fontSize: 11, color: 'rgba(234,240,255,0.62)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>
            add token to portfolio (EIP-747)
          </div>
          <div style={{ fontWeight: 700 }}>{meta.payload.watchToken.symbol}</div>
          <div style={{ fontSize: 12, wordBreak: 'break-all', marginTop: 6, opacity: 0.9 }}>
            {meta.payload.watchToken.address}
          </div>
          <div style={{ fontSize: 12, marginTop: 4, opacity: 0.75 }}>
            decimals: {meta.payload.watchToken.decimals}
          </div>
          {meta.payload.watchToken.image && (
            <div style={{ marginTop: 10 }}>
              <img
                src={meta.payload.watchToken.image}
                alt=""
                style={{ maxWidth: 48, maxHeight: 48, borderRadius: 8 }}
              />
            </div>
          )}
        </div>
      )}
      {meta.payload.kind === 'connect' && meta.connectOptions?.mode === 'evm' && (
        <div className="wc-section" style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11, color: 'rgba(234,240,255,0.62)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>
            EVM dWallet (SECP256K1)
          </div>
          {meta.connectOptions.hasNoActiveSecp ? (
            <p style={{ fontSize: 12, color: 'rgba(251,146,60,0.95)', margin: 0, lineHeight: 1.45 }}>
              no Active secp256k1 dWallet — complete zero-trust for one in the wallet ika panel, then retry.
            </p>
          ) : (
            <>
              <p style={{ fontSize: 11, color: 'rgba(234,240,255,0.55)', margin: '0 0 8px', lineHeight: 1.45 }}>
                defaults to last-used for this site when set, otherwise vault active. you can pick another owned dWallet.
              </p>
              <select
                className="wc-input"
                style={{ width: '100%', fontSize: 12 }}
                value={selectedSecpDwalletId}
                onChange={(e) => setSelectedSecpDwalletId(e.target.value)}
                disabled={busy}
              >
                {meta.connectOptions.choices.map((c) => (
                  <option key={c.dwalletId} value={c.dwalletId}>
                    {c.label}
                  </option>
                ))}
              </select>
            </>
          )}
        </div>
      )}
      {meta.payload.kind === 'connect' && meta.connectOptions?.mode === 'nonEvm' && (
        <div className="wc-section" style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11, color: 'rgba(234,240,255,0.62)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>
            {meta.connectOptions.connectFamily === 'sui'
              ? 'Sui'
              : meta.connectOptions.connectFamily === 'solana'
                ? 'Solana'
                : 'Aptos'}{' '}
            dApp (ED25519 dWallet)
          </div>
          {meta.connectOptions.hasNoActiveEd25519 ? (
            <p style={{ fontSize: 12, color: 'rgba(251,146,60,0.95)', margin: 0, lineHeight: 1.45 }}>
              no Active ed25519 dWallet — complete zero-trust for one in the wallet ika panel, then retry.
            </p>
          ) : (
            <>
              <p style={{ fontSize: 11, color: 'rgba(234,240,255,0.55)', margin: '0 0 8px', lineHeight: 1.45 }}>
                this site will see addresses and can request signatures for the chain family above. pick which ed25519 dWallet to expose.
              </p>
              <select
                className="wc-input"
                style={{ width: '100%', fontSize: 12 }}
                value={selectedEd25519DwalletId}
                onChange={(e) => setSelectedEd25519DwalletId(e.target.value)}
                disabled={busy}
              >
                {meta.connectOptions.choices.map((c) => (
                  <option key={c.dwalletId} value={c.dwalletId}>
                    {c.label}
                  </option>
                ))}
              </select>
            </>
          )}
        </div>
      )}
    </ApprovalShell>
  );
}
