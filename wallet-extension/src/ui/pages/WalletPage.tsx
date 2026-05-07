import { useState, useEffect, useMemo, useCallback } from 'react';
import { NotebookPen } from 'lucide-react';
import type { DwalletHomeGasRow } from '@/background/chains/dwallet-home-gas';
import { trpc } from '@/lib/trpc';
import { buildDwalletIndexMap, resolveDwalletLabel, type DwalletCurve } from '@/lib/dwallet-display-names';
import { HelpBubble } from '@/ui/components/HelpBubble';
import { SwapCard } from '@/ui/components/SwapCard';
import { VaultBaseCard } from '@/ui/components/VaultBaseCard';
import { DWalletReorderList } from '@/ui/components/DWalletReorderList';
import { PendingDWalletCard } from '@/ui/components/DWalletCard';
import { ReceiveAddressSheet } from '@/ui/components/ReceiveAddressSheet';
import { feePayerExplorerHref } from '@/lib/explorer-href';
import { useExplorerPreferences } from '@/lib/use-explorer-preferences';
import type { Balances, Networks } from '@/ui/types';
import { FEATURES } from '@/config/features';

export function WalletPage({
  balances,
  balanceError,
  onRefresh,
  vaultLabel,
  networks,
  onViewPortfolio,
  onOpenDWalletMgmt,
  onOpenSend,
  uiHelpHints,
}: {
  balances: Balances | null;
  balanceError?: string | null;
  onRefresh: (opts?: { clearStaleBalanceError?: boolean }) => void;
  vaultLabel?: string;
  networks: Networks | null;
  onViewPortfolio: (dwalletId: string) => void;
  onOpenDWalletMgmt: () => void;
  /** navigate the shell to the Send page. when omitted the vault-card send button stays disabled. */
  onOpenSend?: () => void;
  /** when false, inline tips (HelpBubble) are hidden, see settings, screen help */
  uiHelpHints: boolean;
}) {
  const [showSwap, setShowSwap] = useState(false);
  const [receiveOpen, setReceiveOpen] = useState(false);
  const explorerPrefs = useExplorerPreferences();
  const [ownedCaps, setOwnedCaps] = useState<Awaited<ReturnType<typeof trpc.listOwnedDWalletCaps.query>>>([]);
  const [metaSecp, setMetaSecp] = useState<string | null>(null);
  const [capsErr, setCapsErr] = useState<string | null>(null);
  const [completeBusy, setCompleteBusy] = useState<string | null>(null);
  const [dwalletNameMap, setDwalletNameMap] = useState<Record<string, string>>({});
  const [cardOrderIds, setCardOrderIds] = useState<string[]>([]);

  const indexMap = useMemo(() => buildDwalletIndexMap(ownedCaps), [ownedCaps]);
  const ownedCapIds = useMemo(() => ownedCaps.map((c) => c.dwalletId).sort().join(','), [ownedCaps]);

  useEffect(() => {
    trpc.dwalletAddressBook
      .query()
      .then((b) => setMetaSecp(b.SECP256K1.dwalletId))
      .catch(() => setMetaSecp(null));
  }, []);

  async function refreshCaps() {
    setCapsErr(null);
    try {
      const rows = await trpc.listOwnedDWalletCaps.query();
      setOwnedCaps(rows);
    } catch (e) {
      setCapsErr(e instanceof Error ? e.message : String(e));
      setOwnedCaps([]);
    }
  }

  useEffect(() => {
    if (!balances || balances.locked) return;
    void refreshCaps();
  }, [balances]);

  useEffect(() => {
    if (!balances || balances.locked) return;
    trpc.getDwalletDisplayNames
      .query()
      .then((r) => setDwalletNameMap(r.names))
      .catch(() => setDwalletNameMap({}));
  }, [balances, ownedCapIds]);

  useEffect(() => {
    if (!balances || balances.locked) return;
    trpc.getDwalletCardOrder
      .query()
      .then((r) => setCardOrderIds(r.orderedIds))
      .catch(() => setCardOrderIds([]));
  }, [balances, ownedCapIds]);

  async function runZeroTrustComplete(cap: (typeof ownedCaps)[number]) {
    if (cap.curve !== 'SECP256K1' && cap.curve !== 'ED25519') return;
    setCompleteBusy(cap.dwalletId);
    setCapsErr(null);
    try {
      await trpc.completeDWalletZeroTrust.mutate({ curve: cap.curve, dwalletId: cap.dwalletId });
      await refreshCaps();
      onRefresh();
    } catch (e) {
      setCapsErr(e instanceof Error ? e.message : String(e));
    } finally {
      setCompleteBusy(null);
    }
  }

  /** home deck: any known-curve dWallet with an id, do not require ika on-chain `Active` (addresses show from `public_output` when available). */
  const deckList = useMemo(
    () =>
      ownedCaps.filter(
        (c) =>
          c.dwalletId !== 'unknown' &&
          (c.curve === 'SECP256K1' || c.curve === 'ED25519') &&
          !c.needsZeroTrustCompletion,
      ),
    [ownedCaps],
  );
  const pendingList = useMemo(() => ownedCaps.filter((c) => c.needsZeroTrustCompletion), [ownedCaps]);

  const [vaultHomeGasById, setVaultHomeGasById] = useState<Record<string, DwalletHomeGasRow[]>>({});
  const [vaultHomeGasLoading, setVaultHomeGasLoading] = useState(false);
  const activeGasBatchKey = useMemo(
    () =>
      deckList
        .map((c) => `${c.dwalletId}:${JSON.stringify(c.chainAddresses ?? null)}`)
        .sort()
        .join('|'),
    [deckList],
  );

  useEffect(() => {
    if (!balances || balances.locked) {
      setVaultHomeGasById({});
      setVaultHomeGasLoading(false);
      return;
    }
    const ids = deckList.map((c) => c.dwalletId);
    if (ids.length === 0) {
      setVaultHomeGasById({});
      setVaultHomeGasLoading(false);
      return;
    }
    let cancelled = false;
    setVaultHomeGasLoading(true);
    void trpc.getDwalletHomeGasMany
      .query({ dwalletIds: ids })
      .then((r) => {
        if (!cancelled) setVaultHomeGasById(r.byDwalletId);
      })
      .catch(() => {
        if (!cancelled) setVaultHomeGasById({});
      })
      .finally(() => {
        if (!cancelled) setVaultHomeGasLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [balances, activeGasBatchKey]);

  const labelForCap = useCallback(
    (cap: (typeof ownedCaps)[number]) =>
      cap.curve === 'SECP256K1' || cap.curve === 'ED25519'
        ? resolveDwalletLabel(cap.dwalletId, cap.curve as DwalletCurve, dwalletNameMap, indexMap)
        : cap.dwalletId,
    [dwalletNameMap, indexMap],
  );

  const onDwalletNamesChanged = useCallback(() => {
    void trpc.getDwalletDisplayNames
      .query()
      .then((r) => setDwalletNameMap(r.names))
      .catch(() => {});
  }, []);

  const onReorderError = useCallback((msg: string) => {
    setCapsErr(msg);
  }, []);

  if (!balances || balances.locked) {
    const loadFailed = Boolean(balanceError);
    return (
      <div className="sp-page">
        <div className="sp-section">
          <p className="sp-muted" style={{ fontWeight: loadFailed ? 700 : 400 }}>
            {loadFailed ? "Couldn't load balances" : 'Loading balances…'}
          </p>
          {loadFailed ? (
            <div className="sp-error" style={{ marginTop: 12, lineHeight: 1.45 }}>
              {balanceError}
            </div>
          ) : null}
          <button
            type="button"
            className="sp-btn sp-btnPrimary"
            style={{ marginTop: 12 }}
            onClick={() => onRefresh({ clearStaleBalanceError: true })}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  const ikaBaseSolana = balances.ikaBase === 'solana';
  const funded = balances.funding?.ready === true;
  const noDwallets = deckList.length === 0 && pendingList.length === 0;

  return (
    <div className="sp-page sp-page--walletHome">
      <VaultBaseCard
        balances={balances}
        network={balances.network}
        networks={networks}
        vaultLabel={vaultLabel}
        onBalancesRefresh={() => {
          onRefresh();
          void refreshCaps();
        }}
        onSwapClick={
          FEATURES.PHASE_B_SUI_SWAP ? () => setShowSwap((s) => !s) : undefined
        }
        swapOpen={showSwap}
        onSendClick={onOpenSend}
        onReceiveClick={
          balances.feePayerAddress ? () => setReceiveOpen(true) : undefined
        }
      />
      <HelpBubble show={uiHelpHints}>
        <p className="cd-helpBubble-text">
          Your <strong>dWallet Vault</strong> is the owner keyring that pays fees.{' '}
          {ikaBaseSolana ? (
            <>
              The <strong>SOL</strong> and <strong>ika</strong> gauges on this card are for the active vault only.
            </>
          ) : (
            <>
              The <strong>SUI</strong> and <strong>IKA</strong> gauges on this card are for the active vault only.
            </>
          )}
        </p>
      </HelpBubble>
      {balances.feePayerAddress ? (
        <ReceiveAddressSheet
          open={receiveOpen}
          onClose={() => setReceiveOpen(false)}
          address={balances.feePayerAddress}
          label={
            'ikaBase' in balances && balances.ikaBase === 'solana'
              ? 'Solana devnet fee payer'
              : 'dWallet Vault fee payer'
          }
          explorerHref={feePayerExplorerHref(
            explorerPrefs,
            networks,
            balances.feePayerAddress,
            'ikaBase' in balances && balances.ikaBase === 'solana' ? 'solana' : 'sui',
            balances.network,
          )}
        />
      ) : null}

      <div className="wallet-bento wallet-bento--two">
        {showSwap && (
          <div className="wallet-bento__span">
            <SwapCard
              onClose={() => setShowSwap(false)}
              onSwapCommitted={() => {
                onRefresh();
                void refreshCaps();
              }}
              onSuccess={() => setShowSwap(false)}
            />
          </div>
        )}

        {ikaBaseSolana ? (
          <div className="wallet-bento__span">
            <aside className="cv-prealphaNotice" role="note" aria-label="Solana pre-alpha notice">
              <span className="cv-prealphaNotice-tag">Solana pre-alpha</span>
              <p className="cv-prealphaNotice-text">
                Mock signer on devnet only — not production MPC. Signatures come from a single mock signer, not a
                distributed network.
              </p>
            </aside>
          </div>
        ) : null}

        <div className="wallet-bento__span">
          <HelpBubble show={uiHelpHints} variant="bento">
            <p className="cd-helpBubble-text">
              The <strong>dWallets</strong> below are the identities you use to connect to sites and apps. A vault can
              have as many dWallets as you want to create.
            </p>
          </HelpBubble>
          <div className="cd-sectionTitleRow" style={{ marginTop: 8 }}>
            <span className="cd-sectionTitle cd-sectionTitle--inline cd-sectionTitle--dwalletsMixed">your dWallets</span>
            <button
              type="button"
              className="cd-sectionManageBtn"
              aria-label="Open dWallet management (ika)"
              onClick={onOpenDWalletMgmt}
            >
              <NotebookPen size={18} strokeWidth={2} />
            </button>
          </div>
          {capsErr && <div className="sp-error">{capsErr}</div>}
          {noDwallets ? (
            <div className="cv-dwalletsEmpty" role="status">
              {funded ? (
                <>
                  <p className="cv-dwalletsEmpty-title">No dWallets yet</p>
                  <p className="cv-dwalletsEmpty-text">
                    Your vault is funded — you can create your first dWallet to start signing.
                  </p>
                  <button
                    type="button"
                    className="sp-btn sp-btnPrimary cv-dwalletsEmpty-btn"
                    onClick={onOpenDWalletMgmt}
                  >
                    Create a dWallet
                  </button>
                </>
              ) : (
                <>
                  <p className="cv-dwalletsEmpty-title">No dWallets yet</p>
                  <p className="cv-dwalletsEmpty-text">
                    {ikaBaseSolana
                      ? 'Fund this vault with devnet SOL above before you can create your first dWallet.'
                      : 'Fund this vault with SUI and IKA above before you can create your first dWallet.'}
                  </p>
                </>
              )}
            </div>
          ) : (
            <DWalletReorderList
              deckCaps={deckList}
              cardOrderIds={cardOrderIds}
              setCardOrderIds={setCardOrderIds}
              networks={networks}
              metaSecp={metaSecp}
              dwalletNameMap={dwalletNameMap}
              labelForCap={labelForCap}
              vaultHomeGasById={vaultHomeGasById}
              vaultHomeGasLoading={vaultHomeGasLoading}
              onNamesChanged={onDwalletNamesChanged}
              onViewPortfolio={onViewPortfolio}
              onReorderError={onReorderError}
            />
          )}
        </div>

        {pendingList.length > 0 && (
          <div className="wallet-bento__span">
            <div className="cd-sectionTitle" style={{ marginTop: 18 }}>
              Pending
            </div>
            {pendingList.map((cap) => (
              <PendingDWalletCard
                key={cap.capObjectId}
                cap={cap}
                networks={networks}
                busy={completeBusy === cap.dwalletId}
                onComplete={() => void runZeroTrustComplete(cap)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
