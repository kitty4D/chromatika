/**
 * shared main-wallet chrome: title bar, vault/dwallet headers, scroll track, bottom nav.
 * overlay routing matches side panel (overlays first, then AnimatePresence keyed by tab only).
 */

import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { trpc } from '@/lib/trpc';
import type { VaultSummary } from '@/ui/VaultPicker';
import type { AppearanceMode } from '@/background/appearance-mode';
import type { IkaBaseMode } from '@/background/ika-base-mode';
import { TitleBar } from '@/ui/components/TitleBar';
import { CollapsibleIkaLabDrawer } from '@/ui/components/WalletChromeIkaLabStrip';
import { BottomNav } from '@/ui/components/BottomNav';
import { useVaultNameHints } from '@/lib/hooks/use-vault-name-hints';
import { VaultContextHeader } from '@/ui/components/VaultContextHeader';
import { DWalletContextBar } from '@/ui/components/DWalletContextBar';
import { AlertBanner } from '@/ui/components/AlertBanner';
import { OperationProgressBanner } from '@/ui/components/OperationProgressBanner';
import { TeamFundingOfferBanner } from '@/ui/components/TeamFundingOfferBanner';
import { WalletPage } from '@/ui/pages/WalletPage';
import { PostCreatePolicyVaultPrompt } from '@/ui/components/PostCreatePolicyVaultPrompt';
import type { ListedDwalletCap } from '@/ui/wallet-recording-stub-caps';
import type { SettingsTab } from '@/ui/pages/SettingsPage';
import type { Tab, Balances, Networks } from '@/ui/types';

const SendPage = lazy(() => import('@/ui/pages/SendPage').then((m) => ({ default: m.SendPage })));
const ActivityPage = lazy(() => import('@/ui/pages/ActivityPage').then((m) => ({ default: m.ActivityPage })));
const SettingsPage = lazy(() => import('@/ui/pages/SettingsPage').then((m) => ({ default: m.SettingsPage })));
const DWalletPortfolioPage = lazy(() =>
  import('@/ui/pages/DWalletPortfolioPage').then((m) => ({ default: m.DWalletPortfolioPage })),
);
const IkaStakingPage = lazy(() => import('@/ui/pages/IkaStakingPage').then((m) => ({ default: m.IkaStakingPage })));
const ChromaLabPage = lazy(() => import('@/ui/pages/ChromaLabPage').then((m) => ({ default: m.ChromaLabPage })));
const PaymentsPage = lazy(() => import('@/ui/pages/PaymentsPage').then((m) => ({ default: m.PaymentsPage })));
const AgentsPage = lazy(() => import('@/ui/pages/AgentsPage').then((m) => ({ default: m.AgentsPage })));
const PolicyVaultPage = lazy(() =>
  import('@/ui/pages/PolicyVaultPage').then((m) => ({ default: m.PolicyVaultPage })),
);
const VaultManagementScreen = lazy(() =>
  import('@/ui/pages/VaultManagementScreen').then((m) => ({ default: m.VaultManagementScreen })),
);
const DWalletManagementScreen = lazy(() =>
  import('@/ui/pages/DWalletManagementScreen').then((m) => ({ default: m.DWalletManagementScreen })),
);

function ShellRouteFallback() {
  return (
    <div className="sp-page sp-shellRouteFallback" role="status" aria-live="polite">
      <p className="sp-muted" style={{ marginTop: 0, fontSize: 12 }}>
        Loading…
      </p>
    </div>
  );
}

export type WalletShellOverlay = null | 'vaultMgmt' | 'dwalletMgmt';

/**
 * cross-tab preselect for the Send tab. set by the shell when (a) a legacy
 * `openSendOverlay()` caller (vault home / dWallet portfolio) hands a PC-Token deep-link,
 * or (b) a portfolio row's Send icon hands a fully resolved token row so the user lands
 * directly on the Recipient step with the asset already chosen. SendPage reads it on mount
 * and calls `onConsumed()` to clear it after wiring its own internal state.
 */
export type SendNav = {
  initialStage?: 'select-token' | 'select-recipient';
  preselectedToken?: import('@/background/services/send-token-types').SendTokenRow;
  initialPcMarketId?: string;
};

export type MainWalletShellProps = {
  ikaMode: IkaBaseMode;
  onIkaModeSelect: (m: IkaBaseMode) => void | Promise<void>;
  balances: Balances | null;
  balanceError: string | null;
  networks: Networks | null;
  advanced: boolean;
  onAdvancedChange: (v: boolean) => void;
  uiHelpHints: boolean;
  onUiHelpHintsChange: (v: boolean) => void;
  appearance: AppearanceMode;
  setAppearance: (v: AppearanceMode) => void | Promise<void>;
  vaultSummaries: VaultSummary[] | null;
  activeVaultId: string | null;
  /** when vault summaries lag behind (e.g. popup), optional label for WalletPage */
  vaultLabelFallback?: string | null;
  tab: Tab;
  setTab: (t: Tab) => void;
  walletOverlay: WalletShellOverlay;
  setWalletOverlay: (o: WalletShellOverlay) => void;
  refresh: (opts?: { clearStaleBalanceError?: boolean }) => void;
  onVaultSwitched: () => void;
  onDwalletBarSwitched: () => void;
  settingsInitialTab?: SettingsTab;
  /** fired when balance summary flips to locked while the shell is mounted (defense in depth) */
  onSessionLockDetected?: () => void;
  /**
   * VaultPicker CTA: clicking "create a dWallet vault on <chain>" delegates upstream so the
   * existing `NeedIkaBaseVaultGate` flow renders with `vaultBaseChainOverride` preselected.
   */
  onAddVaultForBase?: (baseChain: 'sui' | 'solana') => void;
  /**
   * dev side panel urls: surface the post-create policy bottom sheet without a fresh dwallet dkg,
   * e.g. policyPromptDemo=SECP256K1&simulatePolicyWrap=1
   */
  devPolicyPromptCurve?: 'SECP256K1' | 'ED25519';
  devPolicyPromptSimulateWrap?: boolean;
  /** dev `walletRecordingStub=1`: synthetic caps for dWallet bar + home without ika session */
  recordingStubCaps?: ListedDwalletCap[];
};

export function MainWalletShell({
  ikaMode,
  onIkaModeSelect,
  balances,
  balanceError,
  networks,
  advanced,
  onAdvancedChange,
  uiHelpHints,
  onUiHelpHintsChange,
  appearance,
  setAppearance,
  vaultSummaries,
  activeVaultId,
  vaultLabelFallback,
  tab,
  setTab,
  walletOverlay,
  setWalletOverlay,
  refresh,
  onVaultSwitched,
  onDwalletBarSwitched,
  settingsInitialTab,
  onSessionLockDetected,
  onAddVaultForBase,
  devPolicyPromptCurve,
  devPolicyPromptSimulateWrap = false,
  recordingStubCaps,
}: MainWalletShellProps) {
  const titleBarMeasureRef = useRef<HTMLDivElement>(null);
  const [titleBarH, setTitleBarH] = useState(48);
  const [bottomIkaLabOpen, setBottomIkaLabOpen] = useState(false);
  /**
   * UI-level focused dWallet for the dWallet tab + header dropdown. `dwalletMeta` is per-curve
   * (drives signing); without this, the portfolio + bar always pick SECP when both metas exist,
   * so clicking the ED25519 card or dropdown row appears to do nothing.
   */
  const [selectedDwalletId, setSelectedDwalletId] = useState<string | undefined>(undefined);
  /**
   * preselect target for the Send tab. set by callers like the WalletPage / DWalletPortfolioPage
   * "Send" buttons + portfolio row Send icons; consumed by SendPage on mount, then cleared.
   */
  const [sendNav, setSendNav] = useState<SendNav | null>(null);
  const vaultNameHints = useVaultNameHints(vaultSummaries);

  useEffect(() => {
    if (balances?.locked) onSessionLockDetected?.();
  }, [balances?.locked, onSessionLockDetected]);

  function openSendOverlay(opts?: { pcMarketId?: string }) {
    setSendNav(opts?.pcMarketId ? { initialPcMarketId: opts.pcMarketId } : null);
    setWalletOverlay(null);
    setTab('send');
  }

  function openSendForRow(preselectedToken: import('@/background/services/send-token-types').SendTokenRow) {
    setSendNav({ initialStage: 'select-recipient', preselectedToken });
    setWalletOverlay(null);
    setTab('send');
  }

  useLayoutEffect(() => {
    const el = titleBarMeasureRef.current;
    if (!el) return;
    const apply = () => setTitleBarH(Math.max(40, Math.round(el.getBoundingClientRect().height)));
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  function openSettings() {
    setWalletOverlay(null);
    setTab('settings');
  }

  function openIkaStaking() {
    setWalletOverlay(null);
    setTab('ikaStake');
  }

  function openLab() {
    setWalletOverlay(null);
    setTab('lab');
  }

  function openPayments() {
    setWalletOverlay(null);
    setTab('payments');
  }

  function openAgents() {
    setWalletOverlay(null);
    setTab('agents');
  }

  function goDwalletTab() {
    setWalletOverlay(null);
    setTab('dwallet');
  }

  function onNavChange(t: Tab) {
    setWalletOverlay(null);
    setTab(t);
  }

  async function activateDwalletThenRefresh(dwalletId: string) {
    setSelectedDwalletId(dwalletId);
    await trpc.setActiveDwallet.mutate({ dwalletId });
    setWalletOverlay(null);
    setTab('dwallet');
    refresh();
  }

  return (
    <div className="sp-root">
      <div ref={titleBarMeasureRef} className="sp-titleBarMeasureWrap">
        <TitleBar
          variant="wallet"
          mode={ikaMode}
          onSelect={(m) => void onIkaModeSelect(m)}
          onActiveSameMode={() => setWalletOverlay('vaultMgmt')}
          onOpenSettings={openSettings}
          modeSize="xs"
        />
      </div>
      <VaultContextHeader
        balances={balances}
        networks={networks}
        vaultSummaries={vaultSummaries}
        activeVaultId={activeVaultId}
        onVaultSwitched={onVaultSwitched}
        nameHints={vaultNameHints}
        onAddVault={onAddVaultForBase}
      />
      <DWalletContextBar
        balances={balances}
        networks={networks}
        ikaMode={ikaMode}
        selectedDwalletId={selectedDwalletId}
        onSelect={setSelectedDwalletId}
        onNavigateDwallet={goDwalletTab}
        onSwitched={onDwalletBarSwitched}
        recordingStubCaps={recordingStubCaps}
      />
      <AlertBanner onOpenHistory={openSettings} />
      <OperationProgressBanner
        onAction={(action) => {
          if (
            action.kind === 'recreate-ed25519-dwallet'
            || action.kind === 'recreate-secp256k1-dwallet'
          ) {
            setWalletOverlay('dwalletMgmt');
          } else if (action.kind === 'retry-team-funding') {
            // mutation re-runs `triggerTeamFunding` against the active session's Sui address.
            // it owns its own progress banner via `beginOperation` so we just fire and ignore;
            // any error is surfaced through the banner with another retry affordance.
            void trpc.retryTeamFunding.mutate().catch(() => { /* banner handles surfacing */ });
          }
        }}
      />
      <TeamFundingOfferBanner />
      <main className="sp-content">
        <div className="sp-contentTrackShell">
          <div className="sp-contentTrack ch-scrollbar">
            {walletOverlay === 'vaultMgmt' ? (
              <Suspense fallback={<ShellRouteFallback />}>
                <VaultManagementScreen
                  vaultSummaries={vaultSummaries}
                  activeVaultId={activeVaultId}
                  onBack={() => setWalletOverlay(null)}
                  onVaultsChanged={refresh}
                  nameHints={vaultNameHints}
                />
              </Suspense>
            ) : walletOverlay === 'dwalletMgmt' ? (
              balances && !balances.locked ? (
                <Suspense fallback={<ShellRouteFallback />}>
                  <DWalletManagementScreen
                    balances={balances}
                    networks={networks}
                    advanced={advanced}
                    onBack={() => setWalletOverlay(null)}
                    onRefresh={refresh}
                    onOpenPolicyVault={() => {
                      // Close the dWallet-management overlay then route to the Policy Vault tab.
                      setWalletOverlay(null);
                      setTab('policy');
                    }}
                  />
                </Suspense>
              ) : (
                <div className="sp-page">
                  <button type="button" className="sp-backBtn" onClick={() => setWalletOverlay(null)}>
                    ← back
                  </button>
                  <ShellRouteFallback />
                </div>
              )
            ) : (
              // AnimatePresence + Suspense + lazy children was a known-bad combination here:
              // when the parent (App.tsx) unmounted MainWalletShell on the gate flip
              // (e.g. switching ika base to Solana with no Solana vault yet), framer-motion's
              // wait-mode bookkeeping and React's Suspense boundary tear-down raced and threw
              // `NotFoundError: removeChild ... not a child of this node`. motion.div alone
              // (no AnimatePresence) keeps the enter animation; we lose the exit-on-tab-change.
              <motion.div
                key={tab}
                role="presentation"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
                style={{ width: '100%', minWidth: 0 }}
              >
                <Suspense fallback={<ShellRouteFallback />}>
                  {tab === 'vault' && (
                    <WalletPage
                      balances={balances}
                      balanceError={balanceError}
                      onRefresh={refresh}
                      vaultLabel={
                        vaultSummaries?.find((v) => v.id === activeVaultId)?.label ?? vaultLabelFallback ?? undefined
                      }
                      networks={networks}
                      onViewPortfolio={(id) => void activateDwalletThenRefresh(id)}
                      onOpenDWalletMgmt={() => setWalletOverlay('dwalletMgmt')}
                      onOpenSend={() => openSendOverlay()}
                      onOpenPolicyVault={() => setTab('policy')}
                      uiHelpHints={uiHelpHints}
                      recordingStubCaps={recordingStubCaps}
                    />
                  )}
                  {tab === 'dwallet' && (
                    <div className="sp-dwalletTabFill">
                      <DWalletPortfolioPage
                        dwalletId={selectedDwalletId}
                        networks={networks}
                        balances={balances}
                        onOpenSend={openSendOverlay}
                        onOpenSendForRow={openSendForRow}
                      />
                    </div>
                  )}
                  {tab === 'send' && (
                    <SendPage
                      balances={balances}
                      networks={networks}
                      sendNav={sendNav}
                      onSendNavConsumed={() => setSendNav(null)}
                    />
                  )}
                  {tab === 'activity' && (
                    <ActivityPage balances={balances} advanced={advanced} networks={networks} />
                  )}
                  {tab === 'ikaStake' && <IkaStakingPage balances={balances} networks={networks} onDone={() => refresh()} />}
                  {tab === 'lab' && <ChromaLabPage ikaMode={ikaMode} balances={balances} />}
                  {tab === 'payments' && <PaymentsPage onBack={() => setTab('vault')} />}
                  {tab === 'agents' && <AgentsPage onBack={() => setTab('vault')} />}
                  {tab === 'policy' && <PolicyVaultPage />}
                  {tab === 'settings' && (
                    <SettingsPage
                      networks={networks}
                      advanced={advanced}
                      appearance={appearance}
                      setAppearance={setAppearance}
                      onAdvancedChange={onAdvancedChange}
                      uiHelpHints={uiHelpHints}
                      onUiHelpHintsChange={onUiHelpHintsChange}
                      onRefresh={refresh}
                      initialStab={settingsInitialTab}
                      onOpenVaultManagement={() => setWalletOverlay('vaultMgmt')}
                    />
                  )}
                </Suspense>
              </motion.div>
            )}
          </div>
        </div>
      </main>
      <div className={`sp-bottomNavShell${bottomIkaLabOpen ? ' sp-bottomNavShell--drawerOpen' : ''}`}>
        <CollapsibleIkaLabDrawer
          expanded={bottomIkaLabOpen}
          onToggleExpanded={() => setBottomIkaLabOpen((o) => !o)}
          titleBarHeightPx={titleBarH}
          onOpenIkaStaking={openIkaStaking}
          onOpenLab={openLab}
          onOpenPayments={openPayments}
          onOpenAgents={openAgents}
        />
        <BottomNav active={tab} onChange={onNavChange} />
      </div>
      {devPolicyPromptCurve ? (
        <PostCreatePolicyVaultPrompt
          curve={devPolicyPromptCurve}
          simulateWrapOnly={devPolicyPromptSimulateWrap}
          onClose={() => {
            /* dev url demo: dismissal is intentional no-op unless parent reloads url */
          }}
          onCustomize={() => {
            setTab('policy');
          }}
          onWrapped={() => {
            setTab('policy');
          }}
        />
      ) : null}
    </div>
  );
}
