import { useEffect, useRef, useState } from 'react';
import { Plus, Wallet } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { useOnClickOutside } from '@/lib/hooks/use-on-click-outside';
import type { VaultNameHint } from '@/lib/hooks/use-vault-name-hints';
import { VaultLabelAvatar } from '@/ui/components/VaultLabelAvatar';
import { formatVaultTotalUsd } from '@/lib/format-vault-total';
import { vaultTotalCacheKey, parseStoredWireSnapshot } from '@/background/services/vault-total-cache';

export type VaultSummary = Awaited<ReturnType<typeof trpc.listVaults.query>>[number];
type Snap = Awaited<ReturnType<typeof trpc.getVaultTotal.query>>;
type BaseChain = 'sui' | 'solana';

const BASE_LABEL: Record<BaseChain, string> = {
  sui: 'Sui',
  solana: 'Solana',
};

/** group-header label is "<base>-base dWallet Vaults" so the user understands that
 *  one picker row = one Vault (not a base chain or a dWallet). prevents the audit
 *  finding where users read "Sui vaults" as "vaults on the Sui chain". */
const VAULTS_GROUP_LABEL: Record<BaseChain, string> = {
  sui: 'Sui-base dWallet Vaults',
  solana: 'Solana-base dWallet Vaults',
};

export function vaultAvatarUrl(v: VaultSummary, h?: VaultNameHint): string | null {
  if (!h) return null;
  if (v.baseChain === 'solana') return h.snsAvatarUrl;
  return h.suinsAvatarUrl;
}

export function VaultPicker({
  vaults,
  activeVaultId,
  onSwitched,
  nameHints,
  onAddVault,
  beginner = false,
}: {
  vaults: VaultSummary[];
  activeVaultId: string | null;
  onSwitched: () => void;
  nameHints?: Map<string, VaultNameHint>;
  /**
   * called when the user clicks the "create a dWallet vault on <chain>" CTA inside the
   * dropdown. when omitted, the CTA is hidden (the dropdown stays a pure switcher).
   * upstream wiring goes to `setIkaGateMissingChain` so the existing add-vault flow renders
   * with `vaultBaseChainOverride` preselected.
   */
  onAddVault?: (baseChain: BaseChain) => void;
  /** beginner tier: plain "accounts" wording instead of "<chain>-base dWallet Vaults". */
  beginner?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // map of vaultId -> snapshot (or null if a fetch failed). undefined = not yet fetched
  const [totals, setTotals] = useState<Map<string, Snap | null>>(() => new Map());
  const wrapRef = useRef<HTMLDivElement>(null);
  useOnClickOutside(wrapRef, () => setOpen(false), open && vaults.length > 1);

  // when the dropdown opens, fetch totals for all non-active vaults (SWR via tRPC)
  useEffect(() => {
    if (!open) return;
    const others = vaults.map((v) => v.id).filter((id) => id !== activeVaultId);
    if (others.length === 0) return;
    let cancelled = false;
    trpc.getVaultTotalsForOthers
      .query({ vaultIds: others })
      .then((snaps) => {
        if (cancelled) return;
        const arr = Array.isArray(snaps) ? snaps : [];
        setTotals((prev) => {
          const next = new Map(prev);
          others.forEach((id, i) => next.set(id, arr[i] ?? null));
          return next;
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open, vaults, activeVaultId]);

  // also refresh the active vault's snapshot for the dropdown's active row
  useEffect(() => {
    if (!open || !activeVaultId) return;
    let cancelled = false;
    trpc.getVaultTotal
      .query({ vaultId: activeVaultId })
      .then((snap) => {
        if (cancelled) return;
        setTotals((prev) => new Map(prev).set(activeVaultId, snap));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open, activeVaultId]);

  // live update on background storage writes from refreshVaultTotalsBatch
  useEffect(() => {
    if (!open) return;
    const watchedKeys = new Set(vaults.map((v) => vaultTotalCacheKey(v.id)));
    const handler = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'session') return;
      const updates: Array<[string, Snap | null]> = [];
      for (const v of vaults) {
        const k = vaultTotalCacheKey(v.id);
        if (!watchedKeys.has(k) || !(k in changes)) continue;
        updates.push([v.id, parseStoredWireSnapshot(changes[k].newValue)]);
      }
      if (updates.length === 0) return;
      setTotals((prev) => {
        const next = new Map(prev);
        for (const [id, snap] of updates) next.set(id, snap);
        return next;
      });
    };
    chrome.storage.onChanged.addListener(handler);
    return () => chrome.storage.onChanged.removeListener(handler);
  }, [open, vaults]);

  if (vaults.length <= 1) return null;
  const active = vaults.find((v) => v.id === activeVaultId) ?? vaults[0]!;
  const activeHint = nameHints?.get(active.id);
  const activeAvatar = vaultAvatarUrl(active, activeHint);

  // group by baseChain, active chain first, then divider, then the other chain
  // (or its CTA when empty). active vault always renders in its own group. inline
  // (no useMemo) because there's no path to call a hook here without breaking the
  // rules-of-hooks ordering against the `vaults.length <= 1` early return above.
  const suiVaults: VaultSummary[] = [];
  const solanaVaults: VaultSummary[] = [];
  for (const v of vaults) {
    if (v.baseChain === 'solana') solanaVaults.push(v);
    else suiVaults.push(v);
  }
  const activeChain: BaseChain = active.baseChain === 'solana' ? 'solana' : 'sui';
  const otherChain: BaseChain = activeChain === 'sui' ? 'solana' : 'sui';
  const primaryVaults = activeChain === 'sui' ? suiVaults : solanaVaults;
  const secondaryVaults = otherChain === 'sui' ? suiVaults : solanaVaults;

  async function pick(id: string) {
    if (id === activeVaultId) {
      setOpen(false);
      return;
    }
    setErr(null);
    setBusy(true);
    try {
      await trpc.switchVault.mutate({ vaultId: id });
      setOpen(false);
      onSwitched();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function rowUsdText(v: VaultSummary): string {
    const snap = totals.get(v.id);
    if (snap === undefined) return '…';
    if (snap === null) return '—';
    if (snap.perChain.length > 0 && snap.perChain.every((p) => !p.ok)) return '—';
    return formatVaultTotalUsd({ usdMicros: snap.usdMicros, partial: snap.partial }, 'compact');
  }

  return (
    <div className="sp-vaultPicker" ref={wrapRef}>
      <button
        type="button"
        className="sp-vaultPickerBtn"
        onClick={() => setOpen(!open)}
        disabled={busy}
        aria-expanded={open}
      >
        <VaultLabelAvatar label={active.label} imageUrl={activeAvatar} ikaBaseChain={active.baseChain} size={22} />
        <span className="sp-vaultPickerLabel">{active.label}</span>
        <span className="sp-vaultPickerChev">{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <div className="sp-vaultPickerMenu" role="listbox">
          {err && <div className="sp-error" style={{ padding: '6px 10px' }}>{err}</div>}
          {/* primary group: active chain's vaults */}
          <div className="sp-vaultPickerGroup" role="presentation">
            <div className="sp-vaultPickerGroupLabel">{beginner ? `${BASE_LABEL[activeChain]} accounts` : VAULTS_GROUP_LABEL[activeChain]}</div>
            {primaryVaults.map((v) => (
              <VaultPickerItem
                key={v.id}
                vault={v}
                activeVaultId={activeVaultId}
                nameHints={nameHints}
                usdText={rowUsdText(v)}
                onPick={pick}
              />
            ))}
          </div>
          <div className="sp-vaultPickerDivider" role="presentation" />
          {/* secondary group: other chain's vaults OR a CTA when empty */}
          <div className="sp-vaultPickerGroup" role="presentation">
            <div className="sp-vaultPickerGroupLabel">{beginner ? `${BASE_LABEL[otherChain]} accounts` : VAULTS_GROUP_LABEL[otherChain]}</div>
            {secondaryVaults.length > 0 ? (
              secondaryVaults.map((v) => (
                <VaultPickerItem
                  key={v.id}
                  vault={v}
                  activeVaultId={activeVaultId}
                  nameHints={nameHints}
                  usdText={rowUsdText(v)}
                  onPick={pick}
                />
              ))
            ) : onAddVault ? (
              <button
                type="button"
                className="sp-vaultPickerCta"
                onClick={() => {
                  setOpen(false);
                  onAddVault(otherChain);
                }}
              >
                <Plus size={14} strokeWidth={2} aria-hidden />
                <span>{beginner ? 'Create an account on' : 'Create a dWallet Vault on'} {BASE_LABEL[otherChain]}</span>
                <span className="sp-vaultPickerCtaArrow" aria-hidden>→</span>
              </button>
            ) : (
              <div className="sp-vaultPickerEmpty">{beginner ? `no ${BASE_LABEL[otherChain]} accounts` : `no ${BASE_LABEL[otherChain]}-base Vaults`}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function VaultPickerItem({
  vault,
  activeVaultId,
  nameHints,
  usdText,
  onPick,
}: {
  vault: VaultSummary;
  activeVaultId: string | null;
  nameHints?: Map<string, VaultNameHint>;
  usdText: string;
  onPick: (id: string) => void | Promise<void>;
}) {
  const hi = nameHints?.get(vault.id);
  const av = vaultAvatarUrl(vault, hi);
  return (
    <button
      type="button"
      role="option"
      className={`sp-vaultPickerItem${vault.id === activeVaultId ? ' sp-vaultPickerItemActive' : ''}`}
      onClick={() => void onPick(vault.id)}
    >
      <VaultLabelAvatar label={vault.label} imageUrl={av} ikaBaseChain={vault.baseChain} size={22} />
      <span className="sp-vaultPickerItemLabel">{vault.label}</span>
      <span className="sp-vaultPickerMeta sp-vaultPickerMeta--usd" aria-label="vault total usd">
        {usdText}
      </span>
      <span className="sp-vaultPickerMeta sp-vaultPickerMeta--count" aria-label={`${vault.dwalletCount} d wallets`}>
        <Wallet size={14} strokeWidth={2} className="sp-vaultPickerMetaIcon" aria-hidden />
        <span>{vault.dwalletCount}</span>
      </span>
    </button>
  );
}
