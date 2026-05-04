import { useEffect, useId, useMemo, useState } from 'react';
import type { DragControls } from 'framer-motion';
import { motion, useReducedMotion } from 'framer-motion';
import { GripVertical, Pencil } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import '@/ui/wallet-chrome-extras.css';
import { dwalletObjectExplorerHref, gasRowAddressExplorerHref, evmChainIdFromGasRowKey } from '@/lib/explorer-href';
import { useExplorerPreferences } from '@/lib/use-explorer-preferences';
import { ExplorerValueRow } from '@/ui/components/ExplorerValueRow';
import { formatUsd } from '@/lib/sui-amount';
import type { Networks } from '@/ui/types';
import type { DwalletHomeGasRow } from '@/background/chains/dwallet-home-gas';
import type { OwnedDWalletCapView } from '@/background/ika/dwallet-discovery';
import {
  primaryRailSkeletonsForCap,
  type DwalletPrimaryRail,
} from '@/lib/dwallet-primary-rails';
import { dwalletChainLogoUrl } from '@/lib/dwallet-chain-logo';
import { DwalletEncryptedLabel } from '@/ui/components/DwalletEncryptedLabel';

type OwnedCap = Awaited<ReturnType<typeof trpc.listOwnedDWalletCaps.query>>[number];

function DwChainMark({ rowKey, icon }: { rowKey: string; icon: DwalletHomeGasRow['icon'] }) {
  const logoUrl = dwalletChainLogoUrl(rowKey, icon);
  if (logoUrl) {
    return (
      <span className={`cd-dwChainIco cd-dwChainIco--img cd-dwChainIco--${icon}`} aria-hidden>
        <img src={logoUrl} alt="" width={14} height={14} decoding="async" draggable={false} />
      </span>
    );
  }
  const letter =
    icon === 'btc'
      ? '₿'
      : icon === 'eth'
        ? 'Ξ'
        : icon === 'sui'
          ? 'S'
          : icon === 'sol'
            ? '◎'
            : icon === 'apt'
              ? 'A'
              : '◆';
  return (
    <span className={`cd-dwChainIco cd-dwChainIco--${icon}`} aria-hidden>
      <span className="cd-dwChainIcoLetter">{letter}</span>
    </span>
  );
}

function GasLoadingEllipsis({ reducedMotion }: { reducedMotion: boolean | null }) {
  const [phase, setPhase] = useState(0);
  useEffect(() => {
    if (reducedMotion) return;
    const t = window.setInterval(() => setPhase((p) => (p + 1) % 3), 400);
    return () => clearInterval(t);
  }, [reducedMotion]);
  if (reducedMotion) {
    return <span className="cd-dwGasLoadingDots">Loading…</span>;
  }
  const dots = ['.', '..', '...'][phase % 3] ?? '.';
  return <span className="cd-dwGasLoadingDots">Loading{dots}</span>;
}

function pendingHintForCap(cap: OwnedCap): string | null {
  const ca = cap.chainAddresses;
  const solanaProgramDwallet = cap.capObjectId.startsWith('solana:');

  if (cap.curve === 'SECP256K1') {
    const any = ca?.evm || ca?.btcP2wpkh || ca?.btcP2tr;
    if (any) return null;
    if (solanaProgramDwallet) {
      return 'EVM and Bitcoin addresses still need a devnet read for this Solana-based dWallet. The Solana ID here is the program account, not a deposit address.';
    }
    if (cap.needsZeroTrustCompletion) {
      return 'Finish zero-trust to see EVM and Bitcoin deposit addresses.';
    }
    return 'EVM/Bitcoin balances could not be shown (network read failed). Signing may still work.';
  }
  if (cap.curve === 'ED25519') {
    const any = ca?.sui || ca?.solana || ca?.aptos;
    if (any) return null;
    if (solanaProgramDwallet) {
      return 'Sui, Solana, and Aptos addresses still need a devnet read for this Solana-based dWallet. The Solana ID here is the program account, not an address you send to.';
    }
    if (cap.needsZeroTrustCompletion) {
      return 'Finish zero-trust to see Sui, Solana, and Aptos deposit addresses.';
    }
    return 'Sui/Sol/Aptos balances could not be shown (network read failed). Signing may still work.';
  }
  return null;
}

function hasAnyRailAddress(cap: OwnedCap): boolean {
  const ca = cap.chainAddresses;
  if (cap.curve === 'SECP256K1')
    return Boolean(ca?.evm?.trim() || ca?.btcP2wpkh?.trim() || ca?.btcP2tr?.trim());
  if (cap.curve === 'ED25519')
    return Boolean(ca?.sui?.trim() || ca?.solana?.trim() || ca?.aptos?.trim());
  return false;
}

function GasAmountBlock({ row }: { row: DwalletHomeGasRow }) {
  return (
    <>
      <span className="cd-dwGasAmt">{row.gasAmountFormatted}</span>
      <span className="cd-dwGasUsd">{row.usdValue != null ? formatUsd(row.usdValue) : '—'}</span>
    </>
  );
}

export function DWalletCard({
  cap,
  networks,
  isActiveMeta,
  displayLabel,
  customDisplayName,
  dragControls,
  onNamesChanged,
  onViewPortfolio,
  vaultHomeGas,
}: {
  cap: OwnedCap;
  networks: Networks | null;
  isActiveMeta?: boolean;
  displayLabel: string;
  customDisplayName: string;
  dragControls?: DragControls;
  onNamesChanged?: () => void;
  onViewPortfolio: (dwalletId: string) => void;
  /** batched in `WalletPage` so we do not open N tRPC ports (MV3 SW overload). */
  vaultHomeGas: { rows: DwalletHomeGasRow[]; loading: boolean };
}) {
  const renameFieldId = useId();
  const renameMaxCharsHintId = useId();
  const hasRails = hasAnyRailAddress(cap);
  const gasRows = vaultHomeGas.rows;
  const gasLoading = vaultHomeGas.loading;
  const showGasRailsUi =
    cap.dwalletId !== 'unknown' && (cap.curve === 'SECP256K1' || cap.curve === 'ED25519');
  /** avoid "pending" copy while we already got rows from the worker (client cap can lag `listOwnedDWalletCaps`). */
  const pendingHint = useMemo(
    () =>
      !hasRails && gasRows.length === 0 && !gasLoading ? pendingHintForCap(cap) : null,
    [hasRails, gasRows.length, gasLoading, cap],
  );
  const explorerPrefs = useExplorerPreferences();
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [nameBusy, setNameBusy] = useState(false);
  const reduceMotion = useReducedMotion();

  const networkHint = useMemo(() => {
    if (!networks) return null;
    const ac = networks.active.evmChainId;
    const evmNet = networks.evm.find((n) => n.chainId === ac);
    return {
      suiNetworkId: networks.active.suiNetworkId,
      solNetworkId: networks.active.solNetworkId,
      aptNetworkId: networks.active.aptNetworkId,
      activeEvmChainId: ac,
      activeEvmChainName: evmNet?.name ?? `EVM ${ac}`,
    };
  }, [networks]);

  const skeletonRows = useMemo(
    () => primaryRailSkeletonsForCap(cap as OwnedDWalletCapView, networkHint),
    [cap, networkHint],
  );

  const gasByKey = useMemo(() => {
    const m = new Map<string, DwalletHomeGasRow>();
    for (const r of gasRows) m.set(r.rowKey, r);
    return m;
  }, [gasRows]);

  /** long rail grids: skip per-row motion to avoid many simultaneous framer subtrees (i-optimize). */
  const skipGasRowEntranceMotion =
    Boolean(reduceMotion) || skeletonRows.length > 12 || gasRows.length > 12;

  const canRename = cap.curve === 'SECP256K1' || cap.curve === 'ED25519';

  function renderSkeletonRow(s: DwalletPrimaryRail, i: number) {
    const g = gasByKey.get(s.rowKey);
    const addrHref = networks
      ? gasRowAddressExplorerHref(
          explorerPrefs,
          networks,
          s.icon,
          s.address,
          evmChainIdFromGasRowKey(s.rowKey),
        )
      : null;
    const cells = (
      <>
        <div className="cd-dwGasCol cd-dwGasColChain">
          <DwChainMark rowKey={s.rowKey} icon={s.icon} />
          <span className="cd-dwGasChainLabel" title={s.chainLabel}>
            {s.chainTag}
          </span>
        </div>
        <div className="cd-dwGasCol cd-dwGasColAddr">
          <ExplorerValueRow
            fullValue={s.address}
            href={addrHref}
            truncateTail={4}
            copyLabel={`copy ${s.chainLabel} address`}
            linkClassName="cd-explorerMonoLink cd-addr cd-addr--tail"
          />
        </div>
        <div className="cd-dwGasCol cd-dwGasColGas">
          {gasLoading ? (
            <div className="cd-dwGasColGasInner">
              <GasLoadingEllipsis reducedMotion={reduceMotion} />
            </div>
          ) : g ? (
            <div className="cd-dwGasColGasInner cd-dwGasColGasInner--amounts">
              <GasAmountBlock row={g} />
            </div>
          ) : (
            <div className="cd-dwGasColGasInner cd-muted">—</div>
          )}
        </div>
      </>
    );
    if (skipGasRowEntranceMotion) {
      return (
        <div key={s.rowKey} className="cd-dwGasRow cd-dwGasRow--grid">
          {cells}
        </div>
      );
    }
    return (
      <motion.div
        key={s.rowKey}
        className="cd-dwGasRow cd-dwGasRow--grid"
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: reduceMotion ? 0 : Math.min(i * 0.02, 0.12) }}
      >
        {cells}
      </motion.div>
    );
  }

  function renderLoadedGasRow(row: DwalletHomeGasRow, i: number) {
    const loadedHref =
      row.address && networks
        ? gasRowAddressExplorerHref(
            explorerPrefs,
            networks,
            row.icon,
            row.address,
            evmChainIdFromGasRowKey(row.rowKey),
          )
        : null;
    const cells = (
      <>
        <div className="cd-dwGasCol cd-dwGasColChain">
          <DwChainMark rowKey={row.rowKey} icon={row.icon} />
          <span className="cd-dwGasChainLabel" title={row.chainLabel}>
            {row.chainTag}
          </span>
        </div>
        <div className="cd-dwGasCol cd-dwGasColAddr">
          {row.address ? (
            <ExplorerValueRow
              fullValue={row.address}
              href={loadedHref}
              truncateTail={4}
              copyLabel={`copy ${row.chainLabel} address`}
              linkClassName="cd-explorerMonoLink cd-addr cd-addr--tail"
            />
          ) : (
            <span className="cd-muted cd-addrPending">pending…</span>
          )}
        </div>
        <div className="cd-dwGasCol cd-dwGasColGas">
          <div className="cd-dwGasColGasInner cd-dwGasColGasInner--amounts">
            <GasAmountBlock row={row} />
          </div>
        </div>
      </>
    );
    if (skipGasRowEntranceMotion) {
      return (
        <div key={row.rowKey} className="cd-dwGasRow cd-dwGasRow--grid">
          {cells}
        </div>
      );
    }
    return (
      <motion.div
        key={row.rowKey}
        className="cd-dwGasRow cd-dwGasRow--grid"
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: reduceMotion ? 0 : Math.min(i * 0.02, 0.12) }}
      >
        {cells}
      </motion.div>
    );
  }

  return (
    <article className={`cd-card cd-card--dwallet${isActiveMeta ? ' cd-card--active' : ''}`}>
      <div className="cd-cardHead">
        <div className="cd-cardTitle">{displayLabel}</div>
        <div className="cd-cardHeadActions">
          {dragControls ? (
            <span
              className="cd-cardDragHandle"
              title="hold and drag to reorder (pointer or touch)"
              aria-hidden
              tabIndex={-1}
              onPointerDown={(e) => dragControls.start(e)}
            >
              <GripVertical size={16} strokeWidth={2} />
            </span>
          ) : null}
          {canRename ? (
            <button
              type="button"
              className="cd-cardTitleEdit"
              aria-label={renaming ? 'Cancel rename' : 'Rename dWallet label'}
              onClick={() => {
                if (renaming) {
                  setRenaming(false);
                } else {
                  const custom = customDisplayName.trim();
                  setNameDraft(custom.length > 0 ? custom : displayLabel);
                  setRenaming(true);
                }
              }}
            >
              <Pencil size={14} strokeWidth={2} />
            </button>
          ) : null}
        </div>
      </div>
      {renaming && canRename ? (
        <div className="cd-cardRename">
          <label htmlFor={renameFieldId} className="ch-srOnly">
            dWallet label
          </label>
          <span id={renameMaxCharsHintId} className="ch-srOnly">
            Optional nickname shown in this list, up to 64 characters
          </span>
          <input
            id={renameFieldId}
            type="text"
            className="sp-input"
            value={nameDraft}
            maxLength={64}
            autoComplete="off"
            aria-describedby={renameMaxCharsHintId}
            onChange={(e) => setNameDraft(e.target.value)}
          />
          <div className="cd-cardRenameActions">
            <button
              type="button"
              className="sp-btn sp-btnPrimary"
              disabled={nameBusy}
              onClick={() => {
                setNameBusy(true);
                void trpc.setDwalletDisplayName
                  .mutate({ dwalletId: cap.dwalletId, name: nameDraft })
                  .then(() => {
                    setRenaming(false);
                    onNamesChanged?.();
                  })
                  .catch(() => {})
                  .finally(() => setNameBusy(false));
              }}
            >
              {nameBusy ? '…' : 'save'}
            </button>
            <button type="button" className="sp-btn" disabled={nameBusy} onClick={() => setRenaming(false)}>
              cancel
            </button>
          </div>
        </div>
      ) : null}

      <div className="cd-cardDwalletBody">
        {showGasRailsUi && gasLoading ? (
          <div className="cd-dwGasFetchHint" aria-live="polite">
            Loading native gas balances across your chains…
          </div>
        ) : null}
        {showGasRailsUi && (skeletonRows.length > 0 || gasRows.length > 0 || gasLoading) ? (
          <div className="cd-dwGasScroll cd-dwGasScroll--alignCols">
            {gasLoading && skeletonRows.length > 0
              ? skeletonRows.map((s, i) => renderSkeletonRow(s, i))
              : gasRows.length > 0
                ? gasRows.map((row, i) => renderLoadedGasRow(row, i))
                : skeletonRows.length > 0
                  ? skeletonRows.map((s, i) => renderSkeletonRow(s, i))
                  : gasLoading
                    ? <div className="cd-muted cd-dwPendingHint">Loading rail balances…</div>
                    : null}
          </div>
        ) : null}
        {pendingHint ? <div className="cd-muted cd-dwPendingHint">{pendingHint}</div> : null}
      </div>

      {(cap.curve === 'SECP256K1' || cap.curve === 'ED25519') && (
        <DwalletEncryptedLabel curve={cap.curve} />
      )}

      <motion.button
        type="button"
        className="cd-portfolioBtn cd-portfolioBtn--dwalletFooter"
        disabled={cap.dwalletId === 'unknown'}
        onClick={() => onViewPortfolio(cap.dwalletId)}
        whileHover={cap.dwalletId !== 'unknown' ? { scale: 1.02 } : undefined}
        whileTap={cap.dwalletId !== 'unknown' ? { scale: 0.97 } : undefined}
      >
        View Portfolio
      </motion.button>
    </article>
  );
}

export function PendingDWalletCard({
  cap,
  networks,
  busy,
  onComplete,
}: {
  cap: OwnedCap;
  networks: Networks | null;
  busy?: boolean;
  onComplete: () => void;
}) {
  const explorerPrefs = useExplorerPreferences();
  const dwHref = dwalletObjectExplorerHref(explorerPrefs, networks, cap.dwalletId);
  return (
    <article className="cd-card cd-card--pending">
      <div className="cd-pendingLabel">Pending — finish zero-trust to use this dWallet</div>
      <ExplorerValueRow
        fullValue={cap.dwalletId}
        href={dwHref}
        truncateMid={{ head: 14, tail: 8 }}
        copyLabel="copy dWallet id"
        className="cd-pendingDwalletIdRow"
        linkClassName="cd-explorerMonoLink cd-muted"
      />
      <button type="button" className="sp-btn sp-btnPrimary" style={{ marginTop: 10 }} disabled={busy} onClick={onComplete}>
        {busy ? 'working…' : 'Complete'}
      </button>
    </article>
  );
}
