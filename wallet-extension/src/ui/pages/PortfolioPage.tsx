import { useEffect, useState } from 'react';
import { trpc } from '@/lib/trpc';
import { evmWalletStyleLabel } from '@/lib/dwallet-ui-labels';
import { evmAddressExplorerUrl } from '@/lib/explorer-href';
import { formatUsd } from '@/lib/sui-amount';
import { ExplorerValueRow } from '@/ui/components/ExplorerValueRow';
import type { Networks } from '@/ui/types';

export function PortfolioPage({
  dwalletId,
  networks,
  onBack,
}: {
  dwalletId: string;
  networks: Networks | null;
  onBack: () => void;
}) {
  const [caps, setCaps] = useState<Awaited<ReturnType<typeof trpc.listOwnedDWalletCaps.query>> | null>(null);
  const [tokens, setTokens] = useState<Awaited<ReturnType<typeof trpc.getEvmTokenBalances.query>>['tokens']>([]);
  const [err, setErr] = useState<string | null>(null);

  const chainId = networks?.active.evmChainId ?? 1;
  const evmNet = networks?.evm.find((n) => n.chainId === chainId);

  useEffect(() => {
    trpc.listOwnedDWalletCaps
      .query()
      .then(setCaps)
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, [dwalletId]);

  const cap = caps?.find((c) => c.dwalletId === dwalletId);
  const evm = cap?.chainAddresses?.evm;
  const evmExplorerHref =
    evm && evmNet?.explorerUrl ? evmAddressExplorerUrl(evmNet.explorerUrl, evm) : null;

  useEffect(() => {
    if (typeof evm !== 'string' || !evm.trim()) {
      setTokens([]);
      return;
    }
    trpc.getEvmTokenBalances
      .query({ address: evm.trim(), chainId })
      .then((r) => setTokens(r.tokens))
      .catch(() => setTokens([]));
  }, [evm, chainId]);

  const totalUsd = tokens.reduce((s, t) => s + (t.usdValue ?? 0), 0);

  return (
    <div className="sp-page cp-portfolio">
      <div className="cp-portfolioHead">
        <button type="button" className="sp-backBtn" onClick={onBack}>
          ← back
        </button>
        <div className="sp-pageTitle" style={{ marginBottom: 0 }}>
          portfolio
        </div>
      </div>
      {err && <div className="sp-error">{err}</div>}
      {!cap && !err && <div className="sp-muted">loading…</div>}
      {cap && (
        <>
          <div className="cp-portfolioHero">
            <div className="cp-portfolioLabel">{evmWalletStyleLabel(cap.dwalletId, evm)}</div>
            {evm ? (
              <div className="cp-portfolioAddrRow" style={{ alignItems: 'center' }}>
                <ExplorerValueRow
                  fullValue={evm}
                  href={evmExplorerHref}
                  copyLabel="copy address"
                  linkClassName="cd-explorerMonoLink mono"
                />
              </div>
            ) : null}
            <div className="cp-totalUsd">{formatUsd(totalUsd)}</div>
          </div>
          <div className="cp-tokenTable">
            {tokens.map((t) => (
              <div key={t.contractAddress ?? 'native'} className="cp-tokenTableRow">
                <div className="cp-tokSym">{t.symbol}</div>
                <div className="cp-tokName">{t.name}</div>
                <div className="cp-tokBal">{Number.parseFloat(t.balanceFormatted).toFixed(6)}</div>
                <div className="cp-tokUsd">{t.usdValue != null ? formatUsd(t.usdValue) : '—'}</div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
