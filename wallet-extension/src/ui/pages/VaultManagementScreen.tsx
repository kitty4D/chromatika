import { trpc } from '@/lib/trpc';
import type { VaultNameHint } from '@/lib/hooks/use-vault-name-hints';
import { VaultLabelAvatar } from '@/ui/components/VaultLabelAvatar';
import { vaultAvatarUrl, type VaultSummary } from '@/ui/VaultPicker';
import { WalletSetupFlow } from '@/ui/wallet-setup-flow';
import { IkaFeeManagementPanel } from '@/ui/pages/IkaFeeManagementPanel';
import { FindMoreAccountsPanel } from '@/ui/settings/FindMoreAccountsPanel';
import { useState } from 'react';

function renameLabelSuggestions(h?: VaultNameHint): Array<{ key: string; pill: string; value: string }> {
  const out: Array<{ key: string; pill: string; value: string }> = [];
  const suinsPrimary = h?.suinsNames?.[0];
  if (suinsPrimary) {
    out.push({ key: 'suins', pill: `SuiNS · ${suinsPrimary}`, value: suinsPrimary });
  }
  if (h?.snsName) {
    out.push({ key: 'sns', pill: `SNS · ${h.snsName}`, value: h.snsName });
  }
  if (h?.allDomainsName) {
    out.push({ key: 'alldomains', pill: `AllDomains · ${h.allDomainsName}`, value: h.allDomainsName });
  }
  return out;
}

export function VaultManagementScreen({
  vaultSummaries,
  activeVaultId,
  onBack,
  onVaultsChanged,
  nameHints,
}: {
  vaultSummaries: VaultSummary[] | null;
  activeVaultId: string | null;
  onBack: () => void;
  onVaultsChanged: () => void;
  nameHints?: Map<string, VaultNameHint>;
}) {
  const [busy, setBusy] = useState(false);
  const [flow, setFlow] = useState<null | 'create' | 'import'>(null);
  const [err, setErr] = useState<string | null>(null);
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState('');
  /** per-vault "manage ika fees" panel expansion: one open at a time keeps the page tidy. */
  const [feesExpandedFor, setFeesExpandedFor] = useState<string | null>(null);
  /** when true, the screen shows the "scan for more accounts" sub-screen for the active vault. */
  const [scanOpen, setScanOpen] = useState(false);

  async function switchVault(id: string) {
    if (id === activeVaultId) return;
    setBusy(true);
    try {
      await trpc.switchVault.mutate({ vaultId: id });
      onVaultsChanged();
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (!confirm('Remove this dWallet vault? This cannot be undone.')) return;
    setErr(null);
    setBusy(true);
    try {
      await trpc.removeVault.mutate({ vaultId: id });
      onVaultsChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function commitRename() {
    if (!renameId || !renameVal.trim()) {
      setRenameId(null);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await trpc.renameVault.mutate({ vaultId: renameId, label: renameVal.trim() });
      setRenameId(null);
      setRenameVal('');
      onVaultsChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (scanOpen) {
    const activeLabel = vaultSummaries?.find((v) => v.id === activeVaultId)?.label;
    return (
      <div className="sp-page cv-vaultMgmt">
        <div className="cv-vaultMgmt-head">
          <button type="button" className="sp-backBtn" onClick={() => setScanOpen(false)}>
            ← back
          </button>
          <h2 className="sp-pageTitle" style={{ marginBottom: 0 }}>
            scan{activeLabel ? ` · ${activeLabel}` : ''}
          </h2>
        </div>
        <p className="sp-muted" style={{ fontSize: 12, lineHeight: 1.45 }}>
          look for more accounts, dwallets, or activity attached to this vault's identity.
        </p>
        <FindMoreAccountsPanel onOpenVaultManagement={() => setScanOpen(false)} />
      </div>
    );
  }

  return (
    <div className="sp-page cv-vaultMgmt">
      <div className="cv-vaultMgmt-head">
        <button type="button" className="sp-backBtn" onClick={onBack}>
          ← back
        </button>
        <h2 className="sp-pageTitle" style={{ marginBottom: 0 }}>
          vault management
        </h2>
      </div>
      <p className="sp-muted" style={{ fontSize: 12, lineHeight: 1.45 }}>
        multi–dWallet Vault list for this install. rename or remove here.
      </p>
      {err && (
        <div className="sp-error" style={{ marginBottom: 8 }}>
          {err}
        </div>
      )}

      {vaultSummaries === null && <div className="sp-muted">loading vaults…</div>}

      {vaultSummaries?.map((v) => {
        const hint = nameHints?.get(v.id);
        const avatarUrl = vaultAvatarUrl(v, hint);
        const showFeesAction =
          v.baseChain === 'solana' && v.accountKind === 'hardware';
        const feesExpanded = feesExpandedFor === v.id;
        return (
        <div
          key={v.id}
          className={`cv-vaultMgmt-row${v.id === activeVaultId ? ' cv-vaultMgmt-row--active' : ''}`}
        >
          <div className="cv-vaultMgmt-info">
            <div className="cv-vaultMgmt-nameRow">
              <VaultLabelAvatar label={v.label} imageUrl={avatarUrl} ikaBaseChain={v.baseChain} size={36} />
              <div className="cv-vaultMgmt-nameBlock">
                <div className="cv-vaultMgmt-name">
                  {v.label}
                  {v.id === activeVaultId ? <span className="sp-muted"> — active</span> : null}
                </div>
                <div className="cv-vaultMgmt-meta sp-muted">
                  {v.baseChain} · {v.dwalletCount} dWallet{v.dwalletCount === 1 ? '' : 's'}
                </div>
              </div>
            </div>
          </div>
          <div className="cv-vaultMgmt-actions">
            {v.id === activeVaultId && (
              <button
                type="button"
                className="sp-revokeBtn"
                disabled={busy}
                onClick={() => setScanOpen(true)}
              >
                scan
              </button>
            )}
            <button
              type="button"
              className="sp-revokeBtn"
              disabled={busy}
              onClick={() => {
                setRenameId(v.id);
                setRenameVal(v.label);
              }}
            >
              rename
            </button>
            {showFeesAction && (
              <button
                type="button"
                className="sp-revokeBtn"
                disabled={busy}
                onClick={() => setFeesExpandedFor(feesExpanded ? null : v.id)}
              >
                {feesExpanded ? 'hide ika fees' : 'ika fees'}
              </button>
            )}
            <button
              type="button"
              className="sp-revokeBtn"
              disabled={busy || vaultSummaries.length <= 1}
              onClick={() => void remove(v.id)}
            >
              delete
            </button>
            {v.id !== activeVaultId && (
              <button type="button" className="sp-btn sp-btnPrimary" disabled={busy} onClick={() => void switchVault(v.id)}>
                switch
              </button>
            )}
          </div>
          {feesExpanded && showFeesAction && (
            <div style={{ width: '100%', marginTop: 12 }}>
              <IkaFeeManagementPanel
                vaultId={v.id}
                vaultLabel={v.label}
                vaultBaseChain={v.baseChain}
                vaultAccountKind={v.accountKind}
                isActive={v.id === activeVaultId}
              />
            </div>
          )}
        </div>
        );
      })}

      {renameId && (
        <div className="cv-vaultMgmt-renamePanel">
          {(() => {
            const rh = nameHints?.get(renameId);
            const chips = renameLabelSuggestions(rh);
            return chips.length ? (
              <div className="cv-vaultMgmt-renameChips">
                <span className="sp-muted" style={{ fontSize: 11, width: '100%' }}>
                  on-chain names (tap to use as label)
                </span>
                {chips.map((c) => (
                  <button
                    key={c.key}
                    type="button"
                    className="sp-chip"
                    disabled={busy}
                    onClick={() => setRenameVal(c.value)}
                  >
                    {c.pill}
                  </button>
                ))}
              </div>
            ) : null;
          })()}
          <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              className="sp-input"
              style={{ flex: 1, minWidth: 120 }}
              value={renameVal}
              onChange={(e) => setRenameVal(e.target.value)}
              placeholder="vault label"
            />
            <button type="button" className="sp-btn sp-btnPrimary" disabled={busy} onClick={() => void commitRename()}>
              save
            </button>
            <button type="button" className="sp-btn" disabled={busy} onClick={() => setRenameId(null)}>
              cancel
            </button>
          </div>
        </div>
      )}

      {flow ? (
        <div style={{ marginTop: 16 }}>
          <WalletSetupFlow
            surface="sidepanel"
            mode="addVault"
            onVaultReady={() => {
              setFlow(null);
              onVaultsChanged();
            }}
            onDismiss={() => setFlow(null)}
          />
        </div>
      ) : (
        <div className="cv-vaultMgmt-footer">
          <button type="button" className="sp-btn sp-btnPrimary" onClick={() => setFlow('create')}>
            Create New Vault
          </button>
          <button type="button" className="sp-btn" onClick={() => setFlow('import')}>
            Import Vault
          </button>
        </div>
      )}
    </div>
  );
}
