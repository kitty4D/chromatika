import { useEffect, useState } from 'react';
import { trpc } from '@/lib/trpc';
import type { VaultNameHint } from '@/lib/hooks/use-vault-name-hints';
import { VaultLabelAvatar } from '@/ui/components/VaultLabelAvatar';
import { VaultPicker, vaultAvatarUrl, type VaultSummary } from '@/ui/VaultPicker';
import type { Balances, Networks } from '@/ui/types';
import { useExplorerPreferences } from '@/lib/use-explorer-preferences';
import { evmAddressExplorerUrl, feePayerExplorerHref } from '@/lib/explorer-href';
import { ExplorerValueRow } from '@/ui/components/ExplorerValueRow';
import { VaultHeaderTotalPill } from '@/ui/components/VaultHeaderTotalPill';

type DappCtx = Awaited<ReturnType<typeof trpc.vaultHeaderDappContext.query>>;

export function VaultContextHeader({
  balances,
  networks,
  vaultSummaries,
  activeVaultId,
  onVaultSwitched,
  nameHints,
  onAddVault,
}: {
  balances: Balances | null;
  networks: Networks | null;
  vaultSummaries: VaultSummary[] | null;
  activeVaultId: string | null;
  onVaultSwitched: () => void;
  nameHints?: Map<string, VaultNameHint>;
  /** click handler for the vault picker's "create a dWallet vault on <chain>" CTA. */
  onAddVault?: (baseChain: 'sui' | 'solana') => void;
}) {
  const explorerPrefs = useExplorerPreferences();
  const [dapp, setDapp] = useState<DappCtx | null>(null);

  useEffect(() => {
    if (!balances || balances.locked) {
      setDapp(null);
      return;
    }
    const t = window.setInterval(() => {
      trpc.vaultHeaderDappContext
        .query()
        .then(setDapp)
        .catch(() => setDapp(null));
    }, 4000);
    trpc.vaultHeaderDappContext
      .query()
      .then(setDapp)
      .catch(() => setDapp(null));
    return () => clearInterval(t);
  }, [balances]);

  if (!balances || balances.locked) return null;

  const fee = balances.feePayerAddress;
  const feeHref =
    networks && 'ikaBase' in balances
      ? feePayerExplorerHref(
          explorerPrefs,
          networks,
          fee,
          balances.ikaBase === 'solana' ? 'solana' : 'sui',
          balances.network,
        )
      : null;
  const activeVault = vaultSummaries?.find((v) => v.id === activeVaultId);
  const vaultLabel = activeVault?.label ?? 'Vault';
  const singleVaultAvatar =
    vaultSummaries?.length === 1 && activeVault
      ? vaultAvatarUrl(activeVault, nameHints?.get(activeVault.id))
      : null;

  const vaultRow = (
    <div className="cv-contextDisconnectedRow">
      <div className="cv-contextVault cv-contextVault--clamped">
        {vaultSummaries && vaultSummaries.length > 1 ? (
          <VaultPicker
            vaults={vaultSummaries}
            activeVaultId={activeVaultId}
            onSwitched={onVaultSwitched}
            nameHints={nameHints}
            onAddVault={onAddVault}
          />
        ) : (
          <div className="cv-contextVaultName cv-contextVaultName--withAvatar">
            <VaultLabelAvatar
              label={vaultLabel}
              imageUrl={singleVaultAvatar}
              ikaBaseChain={activeVault?.baseChain ?? vaultSummaries?.[0]?.baseChain}
              size={22}
            />
            <span className="cv-contextVaultNameText">{vaultLabel}</span>
          </div>
        )}
      </div>
      <ExplorerValueRow
        fullValue={fee}
        href={feeHref}
        truncateMid={{ head: 10, tail: 6 }}
        copyLabel="copy fee address"
        className="cv-contextFeeExplorer"
        linkClassName="cd-explorerMonoLink cv-contextBaseAddr cv-contextBaseAddr--inline"
      />
    </div>
  );

  if (dapp?.mode === 'connected' && dapp.address) {
    const dappEvmHref =
      networks && dapp.address.startsWith('0x')
        ? evmAddressExplorerUrl(
            networks.evm.find((n) => n.chainId === dapp.chainId)?.explorerUrl,
            dapp.address,
          )
        : null;
    const siteName =
      dapp.siteName ||
      (() => {
        try {
          return new URL(dapp.origin).hostname.replace(/^www\./, '');
        } catch {
          return dapp.origin;
        }
      })();
    return (
      <div className="cv-contextHeader cv-contextHeader--withDapp">
        {vaultRow}
        <div className="cv-vaultTotalRow">
          <VaultHeaderTotalPill vaultId={activeVaultId} />
        </div>
        <div className="cv-contextDivider" role="presentation" />
        <div className="cv-contextDapp">
          <div className="cv-contextDappHead">
            <span className="cv-contextDot cv-contextDot--live" title="connected to this tab" />
            <div className="cv-contextDappHeadText">
              <span className="cv-contextDappKicker">connected dapp</span>
              <span className="cv-contextDappName" title={dapp.origin}>
                {siteName}
              </span>
            </div>
          </div>
          <div className="cv-contextDappAddrRow">
            <ExplorerValueRow
              fullValue={dapp.address}
              href={dappEvmHref}
              truncateMid={{ head: 8, tail: 6 }}
              copyLabel="copy connected address"
              className="cv-contextDappExplorer"
              linkClassName="cd-explorerMonoLink cv-contextAddr cv-contextAddr--dapp"
            />
          </div>
          <div className="cv-contextDappChain">{dapp.chainName}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="cv-contextHeader cv-contextHeader--disconnected">
      {vaultRow}
      <div className="cv-vaultTotalRow">
        <VaultHeaderTotalPill vaultId={activeVaultId} />
      </div>
    </div>
  );
}
