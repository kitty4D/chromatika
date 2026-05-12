import { useState, useEffect } from 'react';
import { trpc } from '@/lib/trpc';
import type { Networks } from '@/ui/types';

type Layer = 'evm' | 'sui' | 'solana' | 'aptos' | 'bitcoin';

export function NetworkSelectorPage({
  tier,
  networks,
  onBack,
  onRefresh,
}: {
  tier: 'vault' | 'dwallet';
  networks: Networks | null;
  onBack: () => void;
  onRefresh?: () => void;
}) {
  const [layer, setLayer] = useState<Layer>('evm');
  const [busy, setBusy] = useState<string | null>(null);
  const [_addMode, _setAddMode] = useState(false);
  const [chainlistQuery, setChainlistQuery] = useState('');
  const [chainlistResults, setChainlistResults] = useState<Awaited<ReturnType<typeof trpc.importFromChainlist.query>> | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [networkWarning, setNetworkWarning] = useState<string | null>(null);
  const [rpcHealth, setRpcHealth] = useState<Awaited<ReturnType<typeof trpc.getEvmRpcHealth.query>>>([]);

  const v = networks?.vaultTier;
  const d = networks?.dwalletTier;
  const legacy = networks?.active;

  useEffect(() => {
    if (tier === 'vault') setLayer('sui');
    else setLayer('evm');
  }, [tier]);

  useEffect(() => {
    trpc.getEvmRpcHealth.query().then(setRpcHealth).catch(() => setRpcHealth([]));
  }, [networks?.active?.evmChainId, d?.evmChainId]);

  async function afterSwitch() {
    onRefresh?.();
  }

  const activeChainId = d?.evmChainId ?? legacy?.evmChainId ?? 1;
  const allEvm = networks?.evm ?? [];
  const activeSuiId =
    tier === 'vault' ? v?.suiNetworkId ?? legacy?.suiNetworkId : d?.suiNetworkId ?? legacy?.suiNetworkId;
  const activeSolId =
    tier === 'vault' ? v?.solana.solNetworkId ?? legacy?.solNetworkId : d?.solana.solNetworkId ?? legacy?.solNetworkId;
  const activeAptId = d?.aptNetworkId ?? legacy?.aptNetworkId;
  const activeBtcId = d?.btcNetworkId ?? legacy?.btcNetworkId;

  async function onSwitch(chainId: number) {
    setBusy(`evm-${chainId}`);
    try {
      await trpc.setActiveEvm.mutate({ chainId });
      await afterSwitch();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function onSwitchSui(networkId: string) {
    setBusy(`sui-${networkId}`);
    try {
      await trpc.setActiveSuiNetwork.mutate({ networkId, tier });
      await afterSwitch();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function onSwitchSol(networkId: string) {
    setBusy(`sol-${networkId}`);
    try {
      await trpc.setActiveSolanaNetwork.mutate({ networkId, tier });
      await afterSwitch();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function onSwitchApt(networkId: string) {
    setBusy(`apt-${networkId}`);
    try {
      await trpc.setActiveAptosNetwork.mutate({ networkId });
      await afterSwitch();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function onSwitchBtc(networkId: string) {
    setBusy(`btc-${networkId}`);
    try {
      await trpc.setActiveBitcoinNetwork.mutate({ networkId });
      await afterSwitch();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function onSearch() {
    if (!chainlistQuery.trim()) return;
    setError(null);
    try {
      const results = await trpc.importFromChainlist.query({ query: chainlistQuery });
      setChainlistResults(results);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function onAddChainlist(network: (typeof allEvm)[0]) {
    setNetworkWarning(null);
    try {
      const out = await trpc.addCustomNetwork.mutate({
        name: network.name,
        chainId: network.chainId,
        rpcUrl: network.rpcUrl,
        symbol: network.symbol,
        decimals: network.decimals,
        explorerUrl: network.explorerUrl,
      });
      if (out.warnings?.length) setNetworkWarning(out.warnings.join(' '));
      setChainlistResults(null);
      setChainlistQuery('');
      _setAddMode(false);
      await afterSwitch();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function onRemoveCustom(chainId: number) {
    try {
      await trpc.removeCustomNetwork.mutate({ chainId });
      await afterSwitch();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const suiList = networks?.sui ?? [];
  const solList = networks?.solana ?? [];
  const aptList = networks?.aptos ?? [];
  const btcList = networks?.bitcoin ?? [];

  const tierTitle =
    tier === 'vault'
      ? 'dWallet Vault networks (fee payer / ika base)'
      : 'dWallet networks (signing, dapps)';
  const layerOptions: Layer[] =
    tier === 'vault' ? ['sui', 'solana'] : (['evm', 'sui', 'solana', 'aptos', 'bitcoin'] as const);

  return (
    <div className="sp-page">
      <div className="sp-row" style={{ marginBottom: 14 }}>
        <button type="button" className="sp-btn" onClick={onBack} style={{ padding: '6px 12px', fontSize: 12 }}>
          ← back
        </button>
        <h2 className="sp-pageTitle" style={{ margin: 0 }}>
          networks
        </h2>
      </div>

      <div className="sp-muted" style={{ fontSize: 12, marginBottom: 12 }}>
        {tierTitle}
      </div>

      {error && <div className="sp-error">{error}</div>}
      {networkWarning && (
        <div className="sp-muted" style={{ marginBottom: 10, fontSize: 12, color: 'rgba(251, 191, 36, 0.95)' }}>
          {networkWarning}
        </div>
      )}

      <div className="sp-section">
        <div className="sp-sectionTitle">chain family</div>
        <div className="sp-chipRow" style={{ flexWrap: 'wrap' }}>
          {layerOptions.map((l) => (
            <button
              key={l}
              type="button"
              className={`sp-chip${layer === l ? ' sp-chipActive' : ''}`}
              onClick={() => setLayer(l)}
            >
              {l}
            </button>
          ))}
        </div>
      </div>

      {tier === 'dwallet' && layer === 'evm' && (
        <>
          <div className="sp-section">
            <div className="sp-sectionTitle">evm chains</div>
            {allEvm.map((n) => (
              <div key={n.chainId} className={`sp-networkRow${n.chainId === activeChainId ? ' sp-networkRowActive' : ''}`}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{n.name}</div>
                  <div className="sp-muted" style={{ fontSize: 11 }}>
                    chain {n.chainId} · {n.symbol}
                  </div>
                  <div className="sp-muted" style={{ fontSize: 11, wordBreak: 'break-all', marginTop: 2 }}>
                    rpc: {n.rpcUrl}
                  </div>
                  {n.chainId === activeChainId && (
                    <div className="sp-muted" style={{ fontSize: 11, marginTop: 2 }}>
                      {(() => {
                        const activeH = rpcHealth.find((x) => x.rpcUrl === n.rpcUrl);
                        if (!activeH?.lastSuccessAt && !activeH?.lastErrorAt) return 'rpc health: no data yet';
                        const ok = activeH.lastSuccessAt ?? 0;
                        const bad = activeH.lastErrorAt ?? 0;
                        const lat = activeH.lastLatencyMs;
                        const latBit = lat != null ? ` · last RTT ~${lat}ms` : '';
                        return ok >= bad
                          ? `rpc health: ok @ ${new Date(ok).toLocaleTimeString()}${latBit}`
                          : `rpc health: error @ ${new Date(bad).toLocaleTimeString()}${latBit}`;
                      })()}
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  {n.chainId !== activeChainId && (
                    <button
                      type="button"
                      className="sp-btn"
                      style={{ padding: '5px 10px', fontSize: 11 }}
                      disabled={busy === `evm-${n.chainId}`}
                      onClick={() => onSwitch(n.chainId)}
                    >
                      {busy === `evm-${n.chainId}` ? '…' : 'use'}
                    </button>
                  )}
                  {n.isCustom && (
                    <button
                      type="button"
                      className="sp-btnDanger"
                      style={{ padding: '5px 10px', fontSize: 11 }}
                      onClick={() => onRemoveCustom(n.chainId)}
                    >
                      ✕
                    </button>
                  )}
                  {n.chainId === activeChainId && <span className="sp-activeDot">●</span>}
                </div>
              </div>
            ))}
          </div>

          <div className="sp-section">
            <div className="sp-sectionTitle">add via chainlist.org</div>
            <div className="sp-row" style={{ gap: 8 }}>
              <input
                type="text"
                className="sp-input"
                placeholder="chain name or ID…"
                value={chainlistQuery}
                onChange={(e) => setChainlistQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') onSearch();
                }}
                style={{ flex: 1 }}
              />
              <button type="button" className="sp-btn" onClick={onSearch}>
                search
              </button>
            </div>

            {chainlistResults && chainlistResults.length === 0 && (
              <div className="sp-muted" style={{ marginTop: 8 }}>
                no results
              </div>
            )}

            {chainlistResults &&
              chainlistResults.map((n) => (
                <div key={n.chainId} className="sp-networkRow">
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>{n.name}</div>
                    <div className="sp-muted" style={{ fontSize: 11 }}>
                      chain {n.chainId} · {n.symbol}
                    </div>
                    <div className="sp-muted" style={{ fontSize: 11, wordBreak: 'break-all', marginTop: 2 }}>
                      rpc: {n.rpcUrl}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="sp-btn sp-btnPrimary"
                    style={{ padding: '5px 10px', fontSize: 11 }}
                    onClick={() => onAddChainlist(n)}
                  >
                    add
                  </button>
                </div>
              ))}
          </div>
        </>
      )}

      {layer === 'sui' && (
        <div className="sp-section">
          <div className="sp-sectionTitle">sui (graphql)</div>
          {suiList.map((n) => {
            const isActive = activeSuiId === n.id;
            return (
              <div key={n.id} className={`sp-networkRow${isActive ? ' sp-networkRowActive' : ''}`}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{n.name}</div>
                  <div className="sp-muted" style={{ fontSize: 11, wordBreak: 'break-all' }}>
                    {n.rpcUrl}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  {!isActive && (
                    <button
                      type="button"
                      className="sp-btn"
                      style={{ padding: '5px 10px', fontSize: 11 }}
                      disabled={busy === `sui-${n.id}`}
                      onClick={() => onSwitchSui(n.id)}
                    >
                      {busy === `sui-${n.id}` ? '…' : 'use'}
                    </button>
                  )}
                  {isActive && <span className="sp-activeDot">●</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {layer === 'solana' && (
        <div className="sp-section">
          <div className="sp-sectionTitle">solana</div>
          {solList.map((n) => {
            const isActive = activeSolId === n.id;
            return (
              <div key={n.id} className={`sp-networkRow${isActive ? ' sp-networkRowActive' : ''}`}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{n.name}</div>
                  <div className="sp-muted" style={{ fontSize: 11, wordBreak: 'break-all' }}>
                    {n.rpcUrl}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  {!isActive && (
                    <button
                      type="button"
                      className="sp-btn"
                      style={{ padding: '5px 10px', fontSize: 11 }}
                      disabled={busy === `sol-${n.id}`}
                      onClick={() => onSwitchSol(n.id)}
                    >
                      {busy === `sol-${n.id}` ? '…' : 'use'}
                    </button>
                  )}
                  {isActive && <span className="sp-activeDot">●</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {tier === 'dwallet' && layer === 'aptos' && (
        <div className="sp-section">
          <div className="sp-sectionTitle">aptos</div>
          {aptList.map((n) => {
            const isActive = activeAptId === n.id;
            return (
              <div key={n.id} className={`sp-networkRow${isActive ? ' sp-networkRowActive' : ''}`}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{n.name}</div>
                  <div className="sp-muted" style={{ fontSize: 11, wordBreak: 'break-all' }}>
                    {n.rpcUrl}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  {!isActive && (
                    <button
                      type="button"
                      className="sp-btn"
                      style={{ padding: '5px 10px', fontSize: 11 }}
                      disabled={busy === `apt-${n.id}`}
                      onClick={() => onSwitchApt(n.id)}
                    >
                      {busy === `apt-${n.id}` ? '…' : 'use'}
                    </button>
                  )}
                  {isActive && <span className="sp-activeDot">●</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {tier === 'dwallet' && layer === 'bitcoin' && (
        <div className="sp-section">
          <div className="sp-sectionTitle">bitcoin (esplora)</div>
          {btcList.map((n) => {
            const isActive = activeBtcId === n.id;
            return (
              <div key={n.id} className={`sp-networkRow${isActive ? ' sp-networkRowActive' : ''}`}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{n.name}</div>
                  <div className="sp-muted" style={{ fontSize: 11, wordBreak: 'break-all' }}>
                    {n.esploraUrl}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  {!isActive && (
                    <button
                      type="button"
                      className="sp-btn"
                      style={{ padding: '5px 10px', fontSize: 11 }}
                      disabled={busy === `btc-${n.id}`}
                      onClick={() => onSwitchBtc(n.id)}
                    >
                      {busy === `btc-${n.id}` ? '…' : 'use'}
                    </button>
                  )}
                  {isActive && <span className="sp-activeDot">●</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
