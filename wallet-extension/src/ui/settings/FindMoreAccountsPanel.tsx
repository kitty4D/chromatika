import { useEffect, useState } from 'react';
import { trpc } from '@/lib/trpc';
import { ScanResultsView } from '@/ui/scan/ScanResultsView';
import type { ScanResult } from '@/background/scan/scan-types';
import type { ScanChainEntry } from '@/config/scan-chains';
import { WalletSetupFlow, type WalletSetupStep, type WalletSetupIntent } from '@/ui/wallet-setup-flow';

type DwalletInventory = NonNullable<Awaited<ReturnType<typeof trpc.dwalletInventoryForActiveVault.query>>>;

/**
 * dev-only synthetic inventory for the orphan-detection e2e. when the page URL carries
 * `?syntheticInventory=<orphans>:<matched>` (e.g. `1:2` -> 1 orphan + 2 matched caps), the
 * panel skips the real `dwalletInventoryForActiveVault` query and renders synthetic rows
 * instead. enables Playwright specs to assert the orphan-badge UI without seeding real vaults.
 *
 * gated on `import.meta.env.DEV` so the synthetic path never ships in production.
 */
function readSyntheticInventoryFlag(): { orphans: number; matched: number } | null {
  if (!import.meta.env.DEV) return null;
  if (typeof window === 'undefined') return null;
  try {
    const v = new URL(window.location.href).searchParams.get('syntheticInventory');
    if (!v) return null;
    const [orphansStr, matchedStr] = v.split(':');
    const orphans = Number.parseInt(orphansStr ?? '', 10);
    const matched = Number.parseInt(matchedStr ?? '', 10);
    if (!Number.isFinite(orphans) || !Number.isFinite(matched)) return null;
    if (orphans < 0 || matched < 0) return null;
    return { orphans, matched };
  } catch {
    return null;
  }
}

function buildSyntheticInventory(orphans: number, matched: number): DwalletInventory {
  const siblings = matched === 0 ? [] : [
    {
      vaultId: 'synthetic-vault-0',
      label: 'default',
      ikaIndex: 0,
      isActive: true,
      knownDwalletIds: Array.from({ length: matched }, (_, i) => `0xMATCHED${i.toString().padStart(2, '0')}`),
    },
  ];
  const caps: DwalletInventory['caps'] = [
    ...Array.from({ length: matched }, (_, i) => ({
      capObjectId: `0xCAP_M_${i}`,
      dwalletId: `0xMATCHED${i.toString().padStart(2, '0')}`,
      curve: (i % 2 === 0 ? 'SECP256K1' : 'ED25519') as 'SECP256K1' | 'ED25519',
      status: 'Active',
      needsZeroTrustCompletion: false,
      chainAddresses: null,
      matchedVaultId: 'synthetic-vault-0',
      matchedVaultLabel: 'default',
      matchedIkaIndex: 0,
    })),
    ...Array.from({ length: orphans }, (_, i) => ({
      capObjectId: `0xCAP_O_${i}`,
      dwalletId: `0xORPHAN${i.toString().padStart(2, '0')}`,
      curve: 'SECP256K1' as const,
      status: 'Active',
      needsZeroTrustCompletion: false,
      chainAddresses: null,
      matchedVaultId: null,
      matchedVaultLabel: null,
      matchedIkaIndex: null,
    })),
  ];
  return {
    activeVaultId: 'synthetic-vault-0',
    activeAccountKind: 'passkey',
    activeBaseChain: 'sui',
    siblings,
    caps,
    capCount: caps.length,
    siblingCount: siblings.length,
    orphanCount: orphans,
  };
}

/**
 * post-unlock "find more accounts" entry. shows the user what activity / dwallets exist on
 * their active vault's identity across sui mainnet + solana mainnet + solana devnet (+ super-pro
 * chains).
 *
 * - **HD vaults**: paste phrase + password, scan additional bip44 accounts, batch-import via
 *   `importVaultsBatch`.
 * - **passkey / seeker / waap / lazor**: one-click "add sibling vault" mounts `WalletSetupFlow`
 *   inline with `mode='addVault'` + `initialStep` preselected, so the user goes straight into
 *   the right auth dance. on completion the panel reloads the active-vault context. background
 *   `add{Hardware,Waap,Lazor}Vault` auto-picks the next ika encryption index for the matched
 *   identity, mirroring how `addPasskeyVault` already auto-picks `passkeyEncryptionIndex`.
 *
 * mounted in `SettingsPage` only when the wallet is unlocked + the active vault has an identity
 * we can scan. `onOpenVaultManagement` stays as a fallback "manage all vaults" link in case the
 * user wants the bigger surface, but the primary CTA is the inline flow now.
 */
export function FindMoreAccountsPanel({
  onOpenVaultManagement,
}: {
  onOpenVaultManagement?: () => void;
} = {}) {
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [superProIds, setSuperProIds] = useState<Set<string>>(new Set());
  const [superProChains, setSuperProChains] = useState<ScanChainEntry[]>([]);
  const [activeVault, setActiveVault] = useState<null | { id: string; accountKind: string; baseChain: string; addr?: string }>(null);
  const [hdMnemonic, setHdMnemonic] = useState<string>('');
  const [hdPassword, setHdPassword] = useState<string>('');
  const [inventory, setInventory] = useState<DwalletInventory | null>(null);
  /** non-null when an inline `WalletSetupFlow` is active; carries the setup step + intent we launched into. */
  const [siblingFlow, setSiblingFlow] = useState<{ step: WalletSetupStep; intent: WalletSetupIntent } | null>(null);
  /** brief banner shown after a sibling-add completes. cleared when the user starts another flow. */
  const [postAddBanner, setPostAddBanner] = useState<string | null>(null);

  // load active vault identity + dwallet inventory on mount + whenever a sibling-add completes
  // (so the panel reflects the newly active vault's identity + the latest cap inventory).
  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // dev-only synthetic inventory short-circuit. used by the orphan-detection e2e to
        // exercise the per-cap UI without seeding real vaults. real path runs in production.
        const synthetic = readSyntheticInventoryFlag();
        if (synthetic) {
          if (cancelled) return;
          setActiveVault({
            id: 'synthetic-vault-0',
            accountKind: 'passkey',
            baseChain: 'sui',
            addr: '0xSYNTHETIC_PASSKEY_SUI_ADDRESS',
          });
          setInventory(buildSyntheticInventory(synthetic.orphans, synthetic.matched));
          return;
        }

        const [ctx, inv] = await Promise.all([
          trpc.scanContextForActiveVault.query(),
          trpc.dwalletInventoryForActiveVault.query().catch(() => null),
        ]);
        if (cancelled) return;
        if (ctx) {
          setActiveVault({
            id: ctx.vaultId,
            accountKind: ctx.accountKind,
            baseChain: ctx.baseChain,
            addr: ctx.suiAddress ?? ctx.solanaAddress,
          });
        }
        setInventory(inv);
      } catch {
        /* leave activeVault null - panel hides itself */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  async function ensureSuperProChainsLoaded() {
    if (superProChains.length > 0) return;
    try {
      const list = await trpc.scanListSuperProChains.query();
      setSuperProChains(list);
    } catch {
      /* leave empty */
    }
  }

  async function runScan(superProSelected: Set<string>) {
    if (!activeVault) {
      setError('no active vault to scan');
      return;
    }
    setBusy(true);
    setError(null);
    void ensureSuperProChainsLoaded();
    try {
      const superProChainIds = Array.from(superProSelected);
      let result: ScanResult;
      if (activeVault.accountKind === 'hd') {
        const phrase = hdMnemonic.trim();
        if (!phrase) {
          setError('to scan additional bip44 accounts on this vault\'s phrase, paste the phrase in the box above (it is not held in memory across the scan).');
          return;
        }
        result = await trpc.scanForHd.mutate({ mnemonic: phrase, defaults: true, superProChainIds });
      } else if (activeVault.accountKind === 'passkey' && activeVault.addr) {
        result = await trpc.scanForPasskey.mutate({ suiAddress: activeVault.addr, defaults: true, superProChainIds });
      } else if (activeVault.accountKind === 'hardware' && activeVault.addr) {
        result = await trpc.scanForSeeker.mutate({ solanaAddress: activeVault.addr, defaults: true, superProChainIds });
      } else if (activeVault.accountKind === 'waap' && activeVault.addr) {
        result = await trpc.scanForWaap.mutate({ suiAddress: activeVault.addr, defaults: true, superProChainIds });
      } else if (activeVault.accountKind === 'lazor' && activeVault.addr) {
        result = await trpc.scanForLazor.mutate({ lazorSmartWalletPubkeyB58: activeVault.addr, defaults: true, superProChainIds });
      } else {
        setError(`scan not supported for vault kind "${activeVault.accountKind}" (imported-key + dwallet-anchored vaults are single-account by design).`);
        return;
      }
      setScanResult(result);
      setSelectedKeys(new Set(result.suggestedKeys));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function importSelectedHd() {
    if (!scanResult || activeVault?.accountKind !== 'hd') return;
    const phrase = hdMnemonic.trim();
    if (!phrase) {
      setError('paste the phrase to import additional accounts');
      return;
    }
    if (hdPassword.length < 8) {
      setError('password must be at least 8 characters');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const accounts = scanResult.rows
        .filter((r) => selectedKeys.has(r.candidate.key))
        .filter((r) => r.candidate.accountIndex !== undefined && r.candidate.accountIndex > 0)
        .map((r) => ({ accountIndex: r.candidate.accountIndex!, label: `account ${r.candidate.accountIndex!}` }));
      if (accounts.length === 0) {
        setError('select at least one non-default account to add. account 0 is already imported.');
        return;
      }
      const out = await trpc.importVaultsBatch.mutate({ password: hdPassword, mnemonic: phrase, accounts });
      setError(null);
      setScanResult(null);
      setHdMnemonic('');
      setHdPassword('');
      setReloadKey((k) => k + 1);
      setPostAddBanner(`imported ${out.length} account${out.length === 1 ? '' : 's'} as sibling vault${out.length === 1 ? '' : 's'}. switch via vault management.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!activeVault) {
    return null;
  }

  /**
   * map active vault `accountKind` -> `WalletSetupFlow` step+intent. only the four multi-vault
   * methods are listed; HD goes through the inline phrase + scan flow above, imported-key /
   * dwallet-anchored don't support multi-vault by design (returns null and the CTA hides).
   */
  function siblingFlowTargetForKind(kind: string): { step: WalletSetupStep; intent: WalletSetupIntent } | null {
    switch (kind) {
      case 'passkey':
        return { step: 'passkey', intent: 'passkey' };
      case 'hardware':
        // most multi-vault hardware identities in chromatika today are MWA-Seeker (solana base);
        // route there. Ledger / Trezor multi-vault siblings can be added through the broader
        // "open vault management" fallback link below.
        return { step: 'seeker', intent: 'seeker' };
      case 'waap':
        return { step: 'waap', intent: 'waap' };
      case 'lazor':
        return { step: 'lazor', intent: 'lazor' };
      default:
        return null;
    }
  }

  const isNonHdMultiVaultMethod = siblingFlowTargetForKind(activeVault.accountKind) !== null;

  // mid-flow: inline `WalletSetupFlow` is rendered. user finishes (onVaultReady) or cancels
  // (onDismiss); both routes return to the panel default state. on success we bump `reloadKey`
  // so `scanContextForActiveVault` re-runs and the panel reflects the new sibling becoming active.
  if (siblingFlow) {
    return (
      <div className="sp-section">
        <div className="sp-sectionTitle">add sibling vault</div>
        <p className="sp-muted" style={{ fontSize: 12, marginBottom: 10 }}>
          finish the {activeVault.accountKind} flow below to add a new sibling vault from this identity.
          chromatika auto-picks the next ika encryption index so you get a clean new dwallet
          (= different cross-chain addresses) at the same on-chain identity.
        </p>
        <WalletSetupFlow
          surface="sidepanel"
          mode="addVault"
          initialStep={siblingFlow.step}
          initialIntent={siblingFlow.intent}
          onVaultReady={() => {
            setSiblingFlow(null);
            setReloadKey((k) => k + 1);
            setPostAddBanner(`sibling ${activeVault.accountKind} vault added. now active.`);
          }}
          onDismiss={() => setSiblingFlow(null)}
        />
      </div>
    );
  }

  return (
    <div className="sp-section">
      <div className="sp-sectionTitle">find more accounts</div>
      <p className="sp-muted" style={{ fontSize: 12, marginBottom: 10 }}>
        scans your {activeVault.accountKind} identity across sui mainnet + solana mainnet + solana devnet for
        activity, balances, and existing dwallets. super-pro mode adds evm L2s + bitcoin + aptos.
        {activeVault.accountKind === 'hd' && ' for HD vaults, you can import multiple accounts as sibling vaults from the same phrase.'}
      </p>

      {postAddBanner && (
        <div
          style={{
            margin: '0 0 10px',
            padding: '8px 10px',
            border: '1px solid rgba(70, 200, 130, 0.45)',
            borderRadius: 8,
            background: 'rgba(70, 200, 130, 0.08)',
            fontSize: 12,
            color: 'rgba(120, 220, 160, 0.95)',
          }}
        >
          {postAddBanner}
          <button
            type="button"
            style={{ float: 'right', background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: 0 }}
            aria-label="dismiss"
            onClick={() => setPostAddBanner(null)}
          >×</button>
        </div>
      )}

      {inventory && inventory.capCount > 0 && (
        <div
          style={{
            margin: '0 0 12px',
            padding: '10px 12px',
            border: inventory.orphanCount > 0 ? '1px solid rgba(255, 175, 70, 0.45)' : '1px solid rgba(255, 255, 255, 0.08)',
            borderRadius: 8,
            background: inventory.orphanCount > 0 ? 'rgba(255, 175, 70, 0.08)' : 'rgba(255, 255, 255, 0.02)',
            fontSize: 12,
            lineHeight: 1.5,
          }}
        >
          <div style={{ fontWeight: 500, marginBottom: 6 }}>
            dwallet inventory
            {inventory.orphanCount > 0 && (
              <span style={{ color: 'rgba(255, 175, 70, 0.95)', marginLeft: 6 }}>
                · {inventory.orphanCount} orphan{inventory.orphanCount === 1 ? '' : 's'}
              </span>
            )}
          </div>
          <div style={{ opacity: 0.8, marginBottom: 8 }}>
            {inventory.capCount} dwallet cap{inventory.capCount === 1 ? '' : 's'} owned by this {inventory.activeAccountKind} identity on chain;
            {' '}{inventory.siblingCount} local sibling vault{inventory.siblingCount === 1 ? '' : 's'} known.
            {inventory.orphanCount > 0 && (
              <span> {inventory.orphanCount === 1 ? 'one cap is not bound to any local sibling vault' : `${inventory.orphanCount} caps are not bound to any local sibling vault`} - click "add sibling vault" to bind the next index. (precise per-cap match via local dwalletMeta.)</span>
            )}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontFamily: 'monospace', fontSize: 11 }}>
            {inventory.caps.slice(0, 8).map((c) => {
              const isOrphan = c.matchedVaultId === null;
              return (
                <div
                  key={c.capObjectId}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: 8,
                    padding: '2px 4px',
                    borderRadius: 4,
                    background: isOrphan ? 'rgba(255, 175, 70, 0.08)' : 'transparent',
                  }}
                >
                  <span title={c.capObjectId}>{c.dwalletId.slice(0, 8)}…{c.dwalletId.slice(-4)}</span>
                  <span style={{ opacity: 0.75 }}>
                    {c.curve} · {c.status}
                    {isOrphan ? (
                      <span style={{ color: 'rgba(255, 175, 70, 0.95)', marginLeft: 6 }}>· orphan</span>
                    ) : (
                      <span style={{ opacity: 0.65, marginLeft: 6 }}>
                        · {c.matchedVaultLabel} (idx {c.matchedIkaIndex})
                      </span>
                    )}
                  </span>
                </div>
              );
            })}
            {inventory.caps.length > 8 && (
              <div style={{ opacity: 0.5 }}>... +{inventory.caps.length - 8} more</div>
            )}
          </div>
          {inventory.siblings.length > 1 && (
            <details style={{ marginTop: 8 }}>
              <summary style={{ cursor: 'pointer', fontSize: 11.5, opacity: 0.75 }}>
                local siblings ({inventory.siblings.length})
              </summary>
              <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 11 }}>
                {inventory.siblings.map((s) => (
                  <li key={s.vaultId}>
                    {s.label} · ika index {s.ikaIndex}{s.isActive ? ' · active' : ''}
                    {s.knownDwalletIds.length > 0 && (
                      <span style={{ opacity: 0.6 }}>
                        {' '}· {s.knownDwalletIds.length} bound dwallet{s.knownDwalletIds.length === 1 ? '' : 's'}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {isNonHdMultiVaultMethod && (
        <div
          style={{
            margin: '0 0 12px',
            padding: '10px 12px',
            border: '1px solid rgba(124, 92, 252, 0.35)',
            borderRadius: 8,
            background: 'rgba(124, 92, 252, 0.06)',
            fontSize: 12,
            lineHeight: 1.5,
          }}
        >
          <div style={{ fontWeight: 500, marginBottom: 4 }}>add a sibling vault from this {activeVault.accountKind} identity</div>
          <div style={{ opacity: 0.8 }}>
            this method supports multiple sibling vaults at different ika encryption indices - same on-chain
            {activeVault.accountKind === 'lazor' || activeVault.accountKind === 'hardware' ? ' solana' : ' sui'} address,
            different dwallets (= different cross-chain addresses). chromatika auto-picks the next slot when you re-run the {activeVault.accountKind} setup.
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="sp-btn"
              onClick={() => {
                const target = siblingFlowTargetForKind(activeVault.accountKind);
                if (target) {
                  setError(null);
                  setPostAddBanner(null);
                  setSiblingFlow(target);
                }
              }}
            >
              add sibling vault →
            </button>
            {onOpenVaultManagement && (
              <button
                type="button"
                className="sp-btn"
                onClick={onOpenVaultManagement}
                style={{ opacity: 0.85 }}
              >
                or manage all vaults →
              </button>
            )}
          </div>
        </div>
      )}

      {activeVault.accountKind === 'hd' && (
        <>
          <label style={{ display: 'block', marginBottom: 8 }}>
            <span style={{ fontSize: 12, opacity: 0.8 }}>recovery phrase (held only for this scan)</span>
            <textarea
              rows={2}
              value={hdMnemonic}
              onChange={(e) => setHdMnemonic(e.target.value)}
              spellCheck={false}
              autoComplete="off"
              style={{ width: '100%', fontFamily: 'monospace', fontSize: 12 }}
              disabled={busy}
            />
          </label>
          <label style={{ display: 'block', marginBottom: 8 }}>
            <span style={{ fontSize: 12, opacity: 0.8 }}>password (to encrypt new vaults)</span>
            <input
              type="password"
              value={hdPassword}
              onChange={(e) => setHdPassword(e.target.value)}
              autoComplete="current-password"
              style={{ width: '100%' }}
              disabled={busy}
            />
          </label>
        </>
      )}

      {error && <p className="ws-password-error" style={{ margin: '8px 0' }}>{error}</p>}

      {!scanResult && (
        <button type="button" className="sp-btn" disabled={busy} onClick={() => void runScan(superProIds)}>
          {busy ? 'scanning…' : 'scan now'}
        </button>
      )}

      {scanResult && (
        <ScanResultsView
          result={scanResult}
          superProChains={superProChains}
          selectedKeys={selectedKeys}
          onSelectionChange={setSelectedKeys}
          selectedSuperProIds={superProIds}
          onSuperProSelectionChange={setSuperProIds}
          onRescan={() => runScan(superProIds)}
          onImport={() => {
            if (activeVault.accountKind === 'hd') {
              void importSelectedHd();
            } else {
              // for non-HD methods the import action surfaces the inline sibling-add flow.
              const target = siblingFlowTargetForKind(activeVault.accountKind);
              if (target) {
                setError(null);
                setPostAddBanner(null);
                setSiblingFlow(target);
              } else {
                setError('this vault kind does not support sibling-add (single-account by design).');
              }
            }
          }}
          busy={busy}
        />
      )}
    </div>
  );
}
