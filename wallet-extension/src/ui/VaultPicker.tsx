import { useRef, useState } from 'react';
import { Wallet } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { useOnClickOutside } from '@/lib/hooks/use-on-click-outside';
import type { VaultNameHint } from '@/lib/hooks/use-vault-name-hints';
import { VaultLabelAvatar } from '@/ui/components/VaultLabelAvatar';

export type VaultSummary = Awaited<ReturnType<typeof trpc.listVaults.query>>[number];

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
}: {
  vaults: VaultSummary[];
  activeVaultId: string | null;
  onSwitched: () => void;
  /** optional on-chain name / PFP hints */
  nameHints?: Map<string, VaultNameHint>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  useOnClickOutside(wrapRef, () => setOpen(false), open && vaults.length > 1);

  if (vaults.length <= 1) return null;

  const active = vaults.find((v) => v.id === activeVaultId) ?? vaults[0]!;
  const activeHint = nameHints?.get(active.id);
  const activeAvatar = vaultAvatarUrl(active, activeHint);

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
          {vaults.map((v) => {
            const hi = nameHints?.get(v.id);
            const av = vaultAvatarUrl(v, hi);
            return (
              <button
                key={v.id}
                type="button"
                role="option"
                className={`sp-vaultPickerItem${v.id === activeVaultId ? ' sp-vaultPickerItemActive' : ''}`}
                onClick={() => void pick(v.id)}
              >
                <VaultLabelAvatar label={v.label} imageUrl={av} ikaBaseChain={v.baseChain} size={22} />
                <span className="sp-vaultPickerItemLabel">{v.label}</span>
                <span className="sp-vaultPickerMeta sp-vaultPickerMeta--count" aria-label={`${v.dwalletCount} d wallets`}>
                  <Wallet size={14} strokeWidth={2} className="sp-vaultPickerMetaIcon" aria-hidden />
                  <span>{v.dwalletCount}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
