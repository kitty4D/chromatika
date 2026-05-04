import { useEffect, useMemo, useRef, useState } from 'react';
import { trpc } from '@/lib/trpc';
import { buildDwalletIndexMap, resolveDwalletLabel, type DwalletCurve } from '@/lib/dwallet-display-names';
import type { Balances, Networks } from '@/ui/types';
import type { IkaBaseMode } from '@/background/ika-base-mode';
import { useExplorerPreferences } from '@/lib/use-explorer-preferences';
import { capPrimaryAddressExplorerHref, dwalletObjectExplorerHref } from '@/lib/explorer-href';
import { ExplorerValueRow } from '@/ui/components/ExplorerValueRow';
import { useOnClickOutside } from '@/lib/hooks/use-on-click-outside';

type Cap = Awaited<ReturnType<typeof trpc.listOwnedDWalletCaps.query>>[number];
type Permissions = Awaited<ReturnType<typeof trpc.getDappPermissions.query>>;

/**
 * inline switcher pill for the dWallet's network on the active ika base chain.
 * hits trpc.setActiveSuiNetwork / setActiveSolanaNetwork with tier='dwallet'.
 * skips render when there's 0 or 1 networks (nothing to switch to). EVM chains
 * stay in the full networks page since "mainnet/testnet/devnet" doesn't map cleanly.
 */
function NetworkSwitcherPill({
  networks,
  ikaMode,
  onSwitched,
}: {
  networks: Networks | null;
  ikaMode: IkaBaseMode;
  onSwitched?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  useOnClickOutside(wrapRef, () => setOpen(false), open);

  if (!networks) return null;

  const list = ikaMode === 'sui' ? networks.sui ?? [] : networks.solana ?? [];
  const activeId =
    ikaMode === 'sui'
      ? networks.dwalletTier?.suiNetworkId ?? networks.active?.suiNetworkId
      : networks.dwalletTier?.solana?.solNetworkId ?? networks.active?.solNetworkId;
  const active = list.find((n) => n.id === activeId);

  if (list.length <= 1) return null;

  async function pick(id: string) {
    if (id === activeId) {
      setOpen(false);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      if (ikaMode === 'sui') {
        await trpc.setActiveSuiNetwork.mutate({ networkId: id, tier: 'dwallet' });
      } else {
        await trpc.setActiveSolanaNetwork.mutate({ networkId: id, tier: 'dwallet' });
      }
      onSwitched?.();
      setOpen(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div ref={wrapRef} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        disabled={busy}
        title={`switch ${ikaMode} dWallet network`}
        aria-haspopup="listbox"
        aria-expanded={open}
        style={{
          fontSize: 10,
          padding: '2px 8px',
          borderRadius: 999,
          border: '1px solid rgba(255,255,255,0.18)',
          background: 'rgba(255,255,255,0.06)',
          color: 'rgba(255,255,255,0.85)',
          cursor: busy ? 'wait' : 'pointer',
          textTransform: 'lowercase',
          fontWeight: 500,
          whiteSpace: 'nowrap',
        }}
      >
        {active?.name ?? 'network'} {open ? '▴' : '▾'}
      </button>
      {open && (
        <div
          role="listbox"
          style={{
            position: 'absolute',
            top: '100%',
            right: 0,
            marginTop: 4,
            background: 'rgba(20, 20, 28, 0.96)',
            border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: 8,
            padding: 4,
            zIndex: 30,
            minWidth: 160,
            boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
          }}
        >
          {err && (
            <div style={{ color: 'rgba(255,99,132,0.95)', fontSize: 11, padding: '4px 8px' }}>{err}</div>
          )}
          {list.map((n) => (
            <button
              key={n.id}
              type="button"
              role="option"
              aria-selected={n.id === activeId}
              onClick={() => void pick(n.id)}
              disabled={busy}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: '6px 10px',
                fontSize: 12,
                background: n.id === activeId ? 'rgba(255,255,255,0.08)' : 'transparent',
                border: 'none',
                color: 'inherit',
                borderRadius: 4,
                cursor: busy ? 'wait' : 'pointer',
              }}
            >
              {n.name}
              {n.id === activeId ? ' ✓' : ''}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * map a dWallet id to connected dapp origins. curve-driven so the same rule applies to every base
 * chain: SECP256K1 caps surface origins via `selectedDwalletId` (EVM/BTC), ED25519 via
 * `selectedEd25519DwalletId` (SOL/SUI/APT). origins permissioned to a different dWallet on the same
 * curve do NOT show up here, so each persona only advertises its own connections.
 */
function originsForDwallet(perms: Permissions | null, curve: string, dwalletId: string): string[] {
  if (!perms || !dwalletId) return [];
  const out: string[] = [];
  for (const [origin, rec] of Object.entries(perms)) {
    if (curve === 'SECP256K1' && rec.selectedDwalletId === dwalletId) out.push(origin);
    else if (curve === 'ED25519' && rec.selectedEd25519DwalletId === dwalletId) out.push(origin);
  }
  return out;
}

function hostFromOrigin(origin: string): string {
  try {
    return new URL(origin).hostname;
  } catch {
    return origin;
  }
}

function ConnectedDappsPill({ origins }: { origins: string[] }) {
  if (origins.length === 0) return null;
  const hosts = origins.map(hostFromOrigin);
  const label = origins.length === 1 ? hosts[0] : `${hosts[0]} +${origins.length - 1}`;
  return (
    <span
      className="cv-dwalletBar-dappsPill"
      title={`connected dapps: ${hosts.join(', ')}`}
      aria-label={`${origins.length} connected ${origins.length === 1 ? 'dapp' : 'dapps'}: ${hosts.join(', ')}`}
    >
      <span aria-hidden>🔌</span>
      <span className="cv-dwalletBar-dappsPillLabel">{label}</span>
    </span>
  );
}

export function DWalletContextBar({
  balances,
  networks,
  ikaMode,
  selectedDwalletId,
  onSelect,
  onNavigateDwallet,
  onSwitched,
}: {
  balances: Balances | null;
  networks: Networks | null;
  /** active ika base chain, drives which network list the inline switcher shows. */
  ikaMode: IkaBaseMode;
  /** UI-level focused dWallet (overrides per-curve `dwalletMeta` so picking ED25519 actually shows it). */
  selectedDwalletId?: string;
  onSelect?: (dwalletId: string) => void;
  onNavigateDwallet?: () => void;
  onSwitched?: () => void;
}) {
  const explorerPrefs = useExplorerPreferences();
  const [caps, setCaps] = useState<Cap[] | null>(null);
  const [book, setBook] = useState<Awaited<ReturnType<typeof trpc.dwalletAddressBook.query>> | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [nameMap, setNameMap] = useState<Record<string, string>>({});
  const [permissions, setPermissions] = useState<Permissions | null>(null);
  const menuWrapRef = useRef<HTMLDivElement>(null);
  useOnClickOutside(menuWrapRef, () => setOpen(false), open && !!caps && caps.length > 1);

  const indexMap = useMemo(() => (caps ? buildDwalletIndexMap(caps) : new Map<string, number>()), [caps]);

  useEffect(() => {
    if (!balances || balances.locked) {
      setCaps(null);
      return;
    }
    void Promise.all([
      trpc.listOwnedDWalletCaps.query().then(setCaps).catch(() => setCaps([])),
      trpc.dwalletAddressBook.query().then(setBook).catch(() => setBook(null)),
      trpc.getDwalletDisplayNames
        .query()
        .then((r) => setNameMap(r.names))
        .catch(() => setNameMap({})),
      trpc.getDappPermissions.query().then(setPermissions).catch(() => setPermissions(null)),
    ]);
  }, [balances]);

  useEffect(() => {
    const t = window.setInterval(() => {
      if (!balances || balances.locked) return;
      trpc.listOwnedDWalletCaps
        .query()
        .then(setCaps)
        .catch(() => {});
      trpc.getDappPermissions
        .query()
        .then(setPermissions)
        .catch(() => {});
    }, 8000);
    return () => clearInterval(t);
  }, [balances]);

  const metaId = book?.SECP256K1?.dwalletId ?? book?.ED25519?.dwalletId;
  const active =
    (selectedDwalletId ? caps?.find((c) => c.dwalletId === selectedDwalletId) : undefined) ??
    caps?.find((c) => c.dwalletId === metaId) ??
    caps?.find((c) => c.dwalletId !== 'unknown' && (c.curve === 'SECP256K1' || c.curve === 'ED25519')) ??
    caps?.[0];
  const addr =
    active?.chainAddresses?.evm ??
    active?.chainAddresses?.sui ??
    active?.chainAddresses?.solana ??
    '';

  const addrExplorerHref = useMemo(
    () => capPrimaryAddressExplorerHref(explorerPrefs, networks, active?.chainAddresses),
    [explorerPrefs, networks, active?.chainAddresses],
  );

  if (!balances || balances.locked) return null;

  const activeLabel =
    active && (active.curve === 'SECP256K1' || active.curve === 'ED25519')
      ? resolveDwalletLabel(active.dwalletId, active.curve as DwalletCurve, nameMap, indexMap)
      : 'dWallet';

  const activeOrigins =
    active && (active.curve === 'SECP256K1' || active.curve === 'ED25519')
      ? originsForDwallet(permissions, active.curve, active.dwalletId)
      : [];

  async function pick(id: string) {
    if (id === active?.dwalletId) {
      setOpen(false);
      return;
    }
    setErr(null);
    setBusy(true);
    try {
      await trpc.setActiveDwallet.mutate({ dwalletId: id });
      onSelect?.(id);
      setOpen(false);
      onSwitched?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!caps || caps.length === 0) {
    return (
      <div className="cv-dwalletBar cv-dwalletBar--empty">
        <span className="cv-dwalletBar-muted">no dWallet yet</span>
      </div>
    );
  }

  if (caps.length === 1) {
    return (
      <div className="cv-dwalletBar cv-dwalletBar--singleWrap">
        <button type="button" className="cv-dwalletBar-singleNav" onClick={() => onNavigateDwallet?.()}>
          <span className="cv-dwalletBar-label">{activeLabel}</span>
        </button>
        {addr ? (
          <ExplorerValueRow
            fullValue={addr}
            href={addrExplorerHref}
            truncateTail={6}
            copyLabel="copy dWallet address"
            className="cv-dwalletBar-addrExplorer"
            linkClassName="cd-explorerMonoLink cv-dwalletBar-addr"
          />
        ) : (
          <span className="cv-dwalletBar-addr mono">…</span>
        )}
        <ConnectedDappsPill origins={activeOrigins} />
        <NetworkSwitcherPill networks={networks} ikaMode={ikaMode} onSwitched={onSwitched} />
      </div>
    );
  }

  const primaryHref = addr
    ? addrExplorerHref
    : active
      ? dwalletObjectExplorerHref(explorerPrefs, networks, active.dwalletId)
      : null;

  return (
    <div className="cv-dwalletBar" ref={menuWrapRef}>
      <div className="cv-dwalletBar-triggerWrap">
        <button
          type="button"
          className="cv-dwalletBar-triggerLabel"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          disabled={busy}
        >
          <span className="cv-dwalletBar-label">{active ? activeLabel : 'dWallet'}</span>
        </button>
        {active ? (
          <div className="cv-dwalletBar-triggerAddr">
            <span className="cv-dwalletBar-curveHint mono" aria-hidden>
              {active.curve.slice(0, 4)} ·{' '}
            </span>
            <ExplorerValueRow
              fullValue={addr || active.dwalletId}
              href={primaryHref}
              truncateTail={4}
              copyLabel={addr ? 'copy dWallet address' : 'copy dWallet id'}
              className="cv-dwalletBar-addrExplorer"
              linkClassName="cd-explorerMonoLink cv-dwalletBar-addr"
            />
            <ConnectedDappsPill origins={activeOrigins} />
          </div>
        ) : (
          <span className="cv-dwalletBar-addr mono">…</span>
        )}
        <NetworkSwitcherPill networks={networks} ikaMode={ikaMode} onSwitched={onSwitched} />
        <button
          type="button"
          className="cv-dwalletBar-triggerChev"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          disabled={busy}
          aria-label="choose dWallet"
        >
          {open ? '▴' : '▾'}
        </button>
      </div>
      {open && (
        <div className="cv-dwalletBar-menu" role="listbox">
          {err && <div className="sp-error" style={{ padding: '6px 10px' }}>{err}</div>}
          {caps.map((c) => {
            const rowAddr =
              c.chainAddresses?.evm ?? c.chainAddresses?.sui ?? c.chainAddresses?.solana ?? '';
            const rowAddrHref = capPrimaryAddressExplorerHref(explorerPrefs, networks, c.chainAddresses);
            const rowDwalletHref = dwalletObjectExplorerHref(explorerPrefs, networks, c.dwalletId);
            const rowOrigins =
              c.curve === 'SECP256K1' || c.curve === 'ED25519'
                ? originsForDwallet(permissions, c.curve, c.dwalletId)
                : [];
            return (
              <div
                key={c.capObjectId}
                role="presentation"
                className={`cv-dwalletBar-itemRow${c.dwalletId === active?.dwalletId ? ' cv-dwalletBar-itemRow--active' : ''}`}
              >
                <button
                  type="button"
                  role="option"
                  className="cv-dwalletBar-itemMain"
                  aria-selected={c.dwalletId === active?.dwalletId}
                  onClick={() => void pick(c.dwalletId)}
                >
                  <span className="cv-dwalletBar-itemMainInner">
                    <span>
                      {c.curve === 'SECP256K1' || c.curve === 'ED25519'
                        ? resolveDwalletLabel(c.dwalletId, c.curve as DwalletCurve, nameMap, indexMap)
                        : c.curve}
                    </span>
                    <ConnectedDappsPill origins={rowOrigins} />
                  </span>
                </button>
                <ExplorerValueRow
                  fullValue={rowAddr || c.dwalletId}
                  href={rowAddr ? rowAddrHref : rowDwalletHref}
                  truncateMid={{ head: 6, tail: 4 }}
                  copyLabel={rowAddr ? 'copy dWallet address' : 'copy dWallet id'}
                  className="cv-dwalletBar-itemExplorer"
                  linkClassName="cd-explorerMonoLink cv-dwalletBar-itemMeta"
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
