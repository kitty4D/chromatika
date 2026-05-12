import { useEffect, useMemo, useRef, useState } from 'react';
import { trpc } from '@/lib/trpc';
import { buildDwalletIndexMap, resolveDwalletLabel, type DwalletCurve } from '@/lib/dwallet-display-names';
import type { Balances, Networks } from '@/ui/types';
import type { IkaBaseMode } from '@/background/ika-base-mode';
import { useExplorerPreferences } from '@/lib/use-explorer-preferences';
import {
  capPrimaryAddressExplorerHref,
  dwalletObjectExplorerHref,
  gasRowAddressExplorerHref,
} from '@/lib/explorer-href';
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
            <div style={{ color: 'var(--theme-banner-error-fg, oklch(0.7 0.2 25))', fontSize: 11, padding: '4px 8px' }}>{err}</div>
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

/**
 * trim a dapp origin to a readable product name for the pill. strips leading subdomains
 * commonly used for "the app surface" (`app.`, `www.`, `mobile.`, `m.`, `dapp.`, `beta.`,
 * `testnet.`, `mainnet.`) and a trailing common TLD (`.com`, `.org`, `.io`, `.app`, `.xyz`,
 * `.finance`, `.network`, `.so`, `.ag`, `.tech`, `.fi`, `.exchange`, `.trade`). full origin
 * stays in the `title` attribute on the pill so phishing checks still work via hover.
 */
function hostFromOrigin(origin: string): string {
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    return origin;
  }
  host = host.replace(/^(app|www|mobile|m|dapp|beta|testnet|mainnet)\./i, '');
  host = host.replace(/\.(com|org|io|app|xyz|finance|network|so|ag|tech|fi|exchange|trade)$/i, '');
  return host;
}

/** raw hostname (no trimming) - used in the dapp pill tooltip so the user can verify origin. */
function rawHostFromOrigin(origin: string): string {
  try {
    return new URL(origin).hostname;
  } catch {
    return origin;
  }
}

type AddrRow = { tag: string; addr: string; icon: 'evm' | 'btc' | 'sui' | 'sol' | 'apt' };

/**
 * every chain address a dWallet exposes for sign-time, in display order. Selecting a dWallet
 * picks the whole key, not one chain - the same SECP256K1 dWallet signs both EVM and BTC
 * transactions, the same ED25519 dWallet signs Sui, Solana, and Aptos. Distinct labels for
 * the two BTC encodings (Segwit P2WPKH vs Taproot P2TR) since those are genuinely different
 * on-chain addresses with different scripts even though they share the same key.
 */
function addressesForRow(c: {
  curve: string;
  chainAddresses?: {
    evm?: string;
    btcP2wpkh?: string;
    btcP2tr?: string;
    sui?: string;
    solana?: string;
    aptos?: string;
  };
}): AddrRow[] {
  const a = c.chainAddresses ?? {};
  const out: AddrRow[] = [];
  if (c.curve === 'SECP256K1') {
    if (a.evm) out.push({ tag: 'evm', addr: a.evm, icon: 'evm' });
    if (a.btcP2wpkh) out.push({ tag: 'btc·sw', addr: a.btcP2wpkh, icon: 'btc' });
    if (a.btcP2tr) out.push({ tag: 'btc·tr', addr: a.btcP2tr, icon: 'btc' });
  } else if (c.curve === 'ED25519') {
    if (a.sui) out.push({ tag: 'sui', addr: a.sui, icon: 'sui' });
    if (a.solana) out.push({ tag: 'sol', addr: a.solana, icon: 'sol' });
    if (a.aptos) out.push({ tag: 'apt', addr: a.aptos, icon: 'apt' });
  }
  return out;
}

function ConnectedDappsPill({ origins }: { origins: string[] }) {
  if (origins.length === 0) return null;
  const cleanHosts = origins.map(hostFromOrigin);
  const rawHosts = origins.map(rawHostFromOrigin);
  const label = cleanHosts.length === 1 ? cleanHosts[0] : `${cleanHosts[0]} +${cleanHosts.length - 1}`;
  // tooltip + aria use the FULL hostname so the user can verify the origin (anti-phishing)
  // even though the visible label is trimmed to the product name.
  return (
    <span
      className="cv-dwalletBar-dappsPill"
      title={`connected dapps: ${rawHosts.join(', ')}`}
      aria-label={`${origins.length} connected ${origins.length === 1 ? 'dapp' : 'dapps'}: ${rawHosts.join(', ')}`}
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

  const primaryHref = addr
    ? addrExplorerHref
    : active
      ? dwalletObjectExplorerHref(explorerPrefs, networks, active.dwalletId)
      : null;
  const addrDisplay = active ? addr || active.dwalletId : '';

  if (caps.length === 1) {
    return (
      <div className="cv-dwalletBar cv-dwalletBar--singleWrap">
        <div className="cv-dwalletBar-row1">
          <button type="button" className="cv-dwalletBar-singleNav" onClick={() => onNavigateDwallet?.()}>
            <span className="cv-dwalletBar-label">{activeLabel}</span>
          </button>
          <div className="cv-dwalletBar-row1-spacer" />
          <NetworkSwitcherPill networks={networks} ikaMode={ikaMode} onSwitched={onSwitched} />
        </div>
        <div className="cv-dwalletBar-row2">
          {addrDisplay ? (
            <ExplorerValueRow
              fullValue={addrDisplay}
              href={primaryHref}
              truncateMid={{ head: 8, tail: 6 }}
              copyLabel={addr ? 'copy dWallet address' : 'copy dWallet id'}
              className="cv-dwalletBar-addrRow"
              linkClassName="cd-explorerMonoLink cv-dwalletBar-addrLink"
            />
          ) : (
            <span className="cv-dwalletBar-addrEmpty mono">…</span>
          )}
          <ConnectedDappsPill origins={activeOrigins} />
        </div>
      </div>
    );
  }

  function onTriggerKey(e: React.KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (!busy) setOpen(!open);
    } else if (e.key === 'Escape' && open) {
      setOpen(false);
    }
  }

  return (
    <div className="cv-dwalletBar" ref={menuWrapRef}>
      <div
        className="cv-dwalletBar-triggerBtn"
        role="button"
        tabIndex={busy ? -1 : 0}
        onClick={() => !busy && setOpen(!open)}
        onKeyDown={onTriggerKey}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="choose dWallet"
        aria-disabled={busy}
      >
        <div className="cv-dwalletBar-row1">
          <span className="cv-dwalletBar-label">{active ? activeLabel : 'dWallet'}</span>
          <div className="cv-dwalletBar-row1-spacer" />
          <span
            className="cv-dwalletBar-inlineGuard"
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <NetworkSwitcherPill networks={networks} ikaMode={ikaMode} onSwitched={onSwitched} />
          </span>
          <span className="cv-dwalletBar-triggerChev" aria-hidden>
            {open ? '▴' : '▾'}
          </span>
        </div>
        <div className="cv-dwalletBar-row2">
          {active && addrDisplay ? (
            <span
              className="cv-dwalletBar-inlineGuard cv-dwalletBar-addrGuard"
              onClick={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
            >
              <ExplorerValueRow
                fullValue={addrDisplay}
                href={primaryHref}
                truncateMid={{ head: 8, tail: 6 }}
                copyLabel={addr ? 'copy dWallet address' : 'copy dWallet id'}
                className="cv-dwalletBar-addrRow"
                linkClassName="cd-explorerMonoLink cv-dwalletBar-addrLink"
              />
            </span>
          ) : (
            <span className="cv-dwalletBar-addrEmpty mono">…</span>
          )}
          <span
            className="cv-dwalletBar-inlineGuard"
            onClick={(e) => e.stopPropagation()}
          >
            <ConnectedDappsPill origins={activeOrigins} />
          </span>
        </div>
      </div>
      {open && (
        <div className="cv-dwalletBar-menu" role="listbox">
          {err && <div className="sp-error" style={{ padding: '6px 10px' }}>{err}</div>}
          {caps.map((c) => {
            const rowAddrs = addressesForRow(c);
            const rowDwalletHref = dwalletObjectExplorerHref(explorerPrefs, networks, c.dwalletId);
            const rowOrigins =
              c.curve === 'SECP256K1' || c.curve === 'ED25519'
                ? originsForDwallet(permissions, c.curve, c.dwalletId)
                : [];
            const isActiveRow = c.dwalletId === active?.dwalletId;
            return (
              <div
                key={c.capObjectId}
                role="option"
                tabIndex={busy ? -1 : 0}
                aria-selected={isActiveRow}
                className={`cv-dwalletBar-itemRow${isActiveRow ? ' cv-dwalletBar-itemRow--active' : ''}`}
                onClick={() => !busy && void pick(c.dwalletId)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    if (!busy) void pick(c.dwalletId);
                  }
                }}
              >
                <div className="cv-dwalletBar-itemHead">
                  <span className="cv-dwalletBar-itemLabel">
                    {c.curve === 'SECP256K1' || c.curve === 'ED25519'
                      ? resolveDwalletLabel(c.dwalletId, c.curve as DwalletCurve, nameMap, indexMap)
                      : c.curve}
                  </span>
                  <ConnectedDappsPill origins={rowOrigins} />
                </div>
                {rowAddrs.length === 0 ? (
                  <div
                    className="cv-dwalletBar-itemAddrRow"
                    onClick={(e) => e.stopPropagation()}
                    onPointerDown={(e) => e.stopPropagation()}
                    onKeyDown={(e) => e.stopPropagation()}
                  >
                    <ExplorerValueRow
                      fullValue={c.dwalletId}
                      href={rowDwalletHref}
                      truncateMid={{ head: 8, tail: 6 }}
                      copyLabel="copy dWallet id"
                      className="cv-dwalletBar-itemExplorer"
                      linkClassName="cd-explorerMonoLink cv-dwalletBar-itemMeta"
                    />
                  </div>
                ) : (
                  rowAddrs.map((row) => (
                    <div
                      key={row.tag}
                      className="cv-dwalletBar-itemAddrRow"
                      onClick={(e) => e.stopPropagation()}
                      onPointerDown={(e) => e.stopPropagation()}
                      onKeyDown={(e) => e.stopPropagation()}
                    >
                      <span className="cv-dwalletBar-itemChainTag">{row.tag}</span>
                      <ExplorerValueRow
                        fullValue={row.addr}
                        href={gasRowAddressExplorerHref(explorerPrefs, networks, row.icon, row.addr)}
                        truncateMid={{ head: 8, tail: 6 }}
                        copyLabel={`copy ${row.tag} address`}
                        className="cv-dwalletBar-itemExplorer"
                        linkClassName="cd-explorerMonoLink cv-dwalletBar-itemMeta"
                      />
                    </div>
                  ))
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
