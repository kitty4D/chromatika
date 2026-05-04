import { useEffect, useMemo, useState } from 'react';
import { trpc } from '@/lib/trpc';
import { evmWalletStyleLabel } from '@/lib/dwallet-ui-labels';
import { formatUsd } from '@/lib/sui-amount';
import { useIkaBaseMode } from '@/lib/use-ika-base-mode';
import { useSharedBus } from '@/lib/use-shared-bus';
import { mapLimit } from '@/lib/map-limit';
import { capObjectExplorerHref, dwalletObjectExplorerHref } from '@/lib/explorer-href';
import { useExplorerPreferences } from '@/lib/use-explorer-preferences';
import { ExplorerValueRow } from '@/ui/components/ExplorerValueRow';
import { NftsCollectiblesPanel, KioskPanel } from '@/ui/pages/NftsPage';
import type { Balances, Networks } from '@/ui/types';

type AssetsInner = 'overview' | 'nfts' | 'kiosks';

type OwnedCap = Awaited<ReturnType<typeof trpc.listOwnedDWalletCaps.query>>[number];

type AggRow = {
  cap: OwnedCap;
  label: string;
  estUsd: number | null;
  loading: boolean;
};

const AGG_QUERY_CONCURRENCY = 3;

async function computeUsdForCap(cap: OwnedCap, evmChainId: number): Promise<{ usd: number; has: boolean }> {
  let usd = 0;
  let has = false;

  const evmFromCap = cap.chainAddresses?.evm;
  if (typeof evmFromCap === 'string' && evmFromCap.trim()) {
    try {
      const r = await trpc.getEvmTokenBalances.query({
        address: evmFromCap.trim(),
        chainId: evmChainId,
      });
      usd += r.tokens.reduce((s, t) => s + (t.usdValue ?? 0), 0);
      has = true;
    } catch {
      /* partial */
    }
  }

  const rails: Array<{ rail: 'sui' | 'solana' | 'aptos' | 'btcP2wpkh' | 'btcP2tr'; addr: string | undefined }> = [
    { rail: 'sui', addr: cap.chainAddresses?.sui },
    { rail: 'solana', addr: cap.chainAddresses?.solana },
    { rail: 'aptos', addr: cap.chainAddresses?.aptos },
    { rail: 'btcP2wpkh', addr: cap.chainAddresses?.btcP2wpkh },
    { rail: 'btcP2tr', addr: cap.chainAddresses?.btcP2tr },
  ];

  for (const { rail, addr } of rails) {
    if (typeof addr !== 'string' || !addr.trim()) continue;
    try {
      const r = await trpc.portfolioRailBalances.query({ rail, address: addr.trim() });
      usd += r.reduce((s, x) => s + (x.usdValue ?? 0), 0);
      has = true;
    } catch {
      /* partial */
    }
  }

  return { usd, has };
}

export function AssetsPage({
  balances,
  networks,
  onOpenDwalletTab,
}: {
  balances: Balances | null;
  networks: Networks | null;
  onOpenDwalletTab?: (dwalletId: string) => void;
}) {
  const { broadcast } = useSharedBus(() => {});
  const { mode: ikaMode } = useIkaBaseMode({ broadcast });
  const explorerPrefs = useExplorerPreferences();
  const [inner, setInner] = useState<AssetsInner>('overview');
  const [aggRows, setAggRows] = useState<AggRow[]>([]);
  const [aggErr, setAggErr] = useState<string | null>(null);

  const showKiosks = ikaMode === 'sui';

  useEffect(() => {
    if (!networks || inner !== 'overview') return;
    let cancelled = false;
    setAggErr(null);
    trpc.listOwnedDWalletCaps
      .query()
      .then(async (caps) => {
        setAggRows(
          caps.map((cap) => ({
            cap,
            label: evmWalletStyleLabel(cap.dwalletId, cap.chainAddresses?.evm),
            estUsd: null,
            loading: true,
          })),
        );
        const evmChainId = networks.active.evmChainId;
        const results = await mapLimit(caps, AGG_QUERY_CONCURRENCY, (cap) => computeUsdForCap(cap, evmChainId));
        if (cancelled) return;
        setAggRows(
          caps.map((cap, i) => ({
            cap,
            label: evmWalletStyleLabel(cap.dwalletId, cap.chainAddresses?.evm),
            estUsd: results[i]!.has ? results[i]!.usd : null,
            loading: false,
          })),
        );
      })
      .catch((e) => {
        if (!cancelled) setAggErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [networks, inner]);

  const totalAggUsd = useMemo(() => {
    let s = 0;
    let any = false;
    for (const r of aggRows) {
      if (r.estUsd != null) {
        s += r.estUsd;
        any = true;
      }
    }
    return any ? s : null;
  }, [aggRows]);

  return (
    <div className="sp-page ap-assets">
      <div className="ap-tabRow" role="tablist" aria-label="assets sections">
        {(['overview', 'nfts'] as const).map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            className={`ap-tabBtn${inner === id ? ' ap-tabBtn--active' : ''}`}
            onClick={() => setInner(id)}
          >
            {id === 'overview' ? 'overview' : 'nfts'}
          </button>
        ))}
        {showKiosks ? (
          <button
            type="button"
            role="tab"
            className={`ap-tabBtn${inner === 'kiosks' ? ' ap-tabBtn--active' : ''}`}
            onClick={() => setInner('kiosks')}
          >
            kiosks
          </button>
        ) : null}
      </div>

      {inner === 'overview' && (
        <div>
          <p className="sp-muted" style={{ fontSize: 12, lineHeight: 1.5, marginBottom: 12 }}>
            estimated value across all dWallets on this vault (EVM tokens plus native rails where addresses exist: Sui, Solana, Aptos, Bitcoin).
          </p>
          {aggErr && <div className="sp-error">{aggErr}</div>}
          {totalAggUsd != null && (
            <div className="ap-aggTotal">total ≈ {formatUsd(totalAggUsd)}</div>
          )}
          {aggRows.map((row) => (
            <div key={row.cap.capObjectId} className="ap-aggRow">
              <div className="ap-aggRow-top">
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="ap-aggLabel">{row.label}</div>
                  <div className="ap-aggCurve">{row.cap.curve}</div>
                  <div className="ap-aggIdRows" style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div className="ap-aggIdRow" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span className="sp-muted" style={{ fontSize: 10, flexShrink: 0 }}>
                        dWallet id
                      </span>
                      <ExplorerValueRow
                        fullValue={row.cap.dwalletId}
                        href={dwalletObjectExplorerHref(explorerPrefs, networks, row.cap.dwalletId)}
                        truncateMid={{ head: 8, tail: 6 }}
                        copyLabel="copy dWallet object id"
                        className="ap-aggExplorer"
                        linkClassName="cd-explorerMonoLink"
                      />
                    </div>
                    <div className="ap-aggIdRow" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span className="sp-muted" style={{ fontSize: 10, flexShrink: 0 }}>
                        cap
                      </span>
                      <ExplorerValueRow
                        fullValue={row.cap.capObjectId}
                        href={capObjectExplorerHref(explorerPrefs, networks, row.cap.capObjectId)}
                        truncateMid={{ head: 8, tail: 6 }}
                        copyLabel="copy dWallet cap id"
                        className="ap-aggExplorer"
                        linkClassName="cd-explorerMonoLink"
                      />
                    </div>
                  </div>
                </div>
                <div className="ap-aggUsd">
                  {row.loading ? '…' : row.estUsd != null ? formatUsd(row.estUsd) : '—'}
                </div>
              </div>
              {onOpenDwalletTab ? (
                <button
                  type="button"
                  className="ap-aggOpen"
                  onClick={() => onOpenDwalletTab(row.cap.dwalletId)}
                >
                  open in dWallet tab
                </button>
              ) : null}
            </div>
          ))}
          {!aggErr && aggRows.length === 0 && networks && (
            <div className="sp-muted" style={{ fontSize: 13 }}>
              no dWallets loaded yet.
            </div>
          )}
          {!networks && <div className="sp-muted">loading networks…</div>}
        </div>
      )}
      {inner === 'nfts' && <NftsCollectiblesPanel balances={balances} />}
      {inner === 'kiosks' && showKiosks ? <KioskPanel balances={balances} /> : null}
    </div>
  );
}
