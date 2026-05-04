/**
 * SidePanelApp - primary chrome surface. full-height, tab-based navigation.
 * Popup stays as quick-action / approval surface; this is the main wallet UX.
 */

import { useState } from 'react';
import { TitleBar } from '@/ui/components/TitleBar';
import { CollapsibleIkaLabDrawer } from '@/ui/components/WalletChromeIkaLabStrip';
import { WalletSetupFlow, type WalletSetupIntent, type WalletSetupStep } from '@/ui/wallet-setup-flow';
import type { VaultSummary } from '@/ui/VaultPicker';
import { UnlockScreen } from '@/ui/unlock-screen';
import { useUnlockMethods } from '@/ui/unlock-methods';
import { CodeCurrent } from '@/ui/effects/code-current';
import { BUILTIN_APTOS, BUILTIN_BITCOIN, BUILTIN_EVM, BUILTIN_SOLANA, BUILTIN_SUI } from '@/config/networks';
import type { SettingsTab } from '@/ui/pages/SettingsPage';
import { MainWalletShell } from '@/ui/MainWalletShell';
import { NeedIkaBaseVaultGate } from '@/ui/NeedIkaBaseVaultGate';
import { ikaModeFromActiveVault } from '@/lib/derive-ika-mode-from-vault';
import { useWalletAppState } from '@/ui/use-wallet-app-state';
import type { Tab, Balances, Networks } from '@/ui/types';
import './wallet.css';

// ---------- root ----------

export function SidePanelApp() {
  const devGallery = new URLSearchParams(location.search).get('devGallery') === '1';
  if (devGallery) return <SidePanelDevGallery />;
  return <SidePanelMain />;
}

function SidePanelMain() {
  const params = new URLSearchParams(location.search);
  const devMode = params.get('dev') === '1';

  function asTab(v: string | null): Tab | null {
    if (
      v === 'vault' ||
      v === 'dwallet' ||
      v === 'assets' ||
      v === 'activity' ||
      v === 'policy' ||
      v === 'ikaStake' ||
      v === 'lab' ||
      v === 'settings'
    )
      return v;
    return null;
  }

  function asSetupStep(v: string | null): WalletSetupStep | null {
    if (
      v === 'choose'
      || v === 'password'
      || v === 'backup'
      || v === 'import'
      || v === 'importKey'
      || v === 'hardware'
    ) {
      return v;
    }
    return null;
  }

  function asSetupIntent(v: string | null): WalletSetupIntent | null {
    if (v === 'create' || v === 'import') return v;
    return null;
  }

  function asSettingsTab(v: string | null): SettingsTab | null {
    if (v === 'main' || v === 'networks' || v === 'dapps') return v;
    return null;
  }

  const devTab = asTab(params.get('tab')) ?? 'vault';
  const devVaultExists = params.get('vaultExists') === '1';
  const devUnlocked = params.get('unlocked') === '1';
  const devSetupMode = params.get('setupMode') === 'addVault' ? 'addVault' : 'bootstrap';
  const devSetupStep = asSetupStep(params.get('setupStep'));
  const devSetupIntent = asSetupIntent(params.get('setupIntent')) ?? 'create';
  const devBackupConfirmed = params.get('backupConfirmed') === '1';
  const devSettingsTab = asSettingsTab(params.get('settingsTab')) ?? 'main';
  /** dev-only: mock ika Solana pre-alpha balance summary for VaultBaseCard / e2e */
  const devSolanaIka = params.get('solanaIka') === '1';

  const DEV_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

  const DEV_NETWORKS: Networks = {
    evm: BUILTIN_EVM,
    solana: BUILTIN_SOLANA,
    sui: BUILTIN_SUI,
    aptos: BUILTIN_APTOS,
    bitcoin: BUILTIN_BITCOIN,
    active: {
      evmChainId: 1,
      solNetworkId: 'sol-devnet',
      suiNetworkId: 'sui-mainnet',
      aptNetworkId: 'apt-mainnet',
      btcNetworkId: 'btc-mainnet',
    },
  } as Networks;

  const DEV_BALANCES: Balances = {
    locked: false as const,
    ikaBase: 'sui' as const,
    network: 'mainnet',
    feePayerAddress: '0xfeePayer',
    canonicalReceiveAddress: '0xcanon',
    canonicalSource: 'dwallet_ed25519_active',
    address: '0xcanon',
    sui: '1234567890',
    ika: '0',
    funding: { ready: true, missing: [] },
  } as Balances;

  const DEV_BALANCES_SOLANA: Balances = {
    locked: false as const,
    ikaBase: 'solana' as const,
    network: 'testnet',
    solanaNetworkId: 'sol-devnet',
    solanaRpcUrl: 'https://api.devnet.solana.com',
    feePayerAddress: 'So11111111111111111111111111111111111111112',
    canonicalReceiveAddress: 'So11111111111111111111111111111111111111112',
    canonicalSource: 'solana_fee_payer',
    address: 'So11111111111111111111111111111111111111112',
    sui: '0',
    ika: '0',
    solanaLamports: '2500000',
    solanaPreAlpha: true,
    solanaRpcMissing: false,
    solanaBalanceFetchDegraded: false,
    funding: { ready: true, missing: [] },
  } as Balances;

  const devBalancesInitial = devSolanaIka ? DEV_BALANCES_SOLANA : DEV_BALANCES;

  const devSolLookupRpc =
    DEV_NETWORKS.solana.find((n) => n.id === DEV_NETWORKS.active.solNetworkId)?.rpcUrl ?? DEV_NETWORKS.solana[0]!.rpcUrl;
  const DEV_VAULTS: VaultSummary[] = [
    {
      id: 'dev-vault-1',
      label: 'default',
      baseChain: 'sui' as const,
      accountKind: 'hd' as const,
      createdAtMs: Date.now() - 1000,
      dwalletCount: 1,
      suiGraphqlUrl: 'https://graphql.mainnet.sui.io/graphql',
      solanaLookupRpcUrl: devSolLookupRpc,
    },
    {
      id: 'dev-vault-2',
      label: 'vault 2',
      baseChain: 'sui' as const,
      accountKind: 'hd' as const,
      createdAtMs: Date.now() - 500,
      dwalletCount: 1,
      suiGraphqlUrl: 'https://graphql.mainnet.sui.io/graphql',
      solanaLookupRpcUrl: devSolLookupRpc,
    },
  ];

  const state = useWalletAppState({
    devMode,
    dev: {
      vaultExists: devMode ? devVaultExists : null,
      unlocked: devMode ? devUnlocked : null,
      balances: devMode ? devBalancesInitial : null,
      networks: devMode ? DEV_NETWORKS : null,
      vaultSummaries: devMode ? DEV_VAULTS : null,
      activeVaultId: devMode ? DEV_VAULTS[0]?.id ?? null : null,
      advanced: devMode ? params.get('advanced') === '1' : false,
    },
  });

  const {
    vaultExists,
    setVaultExists,
    vaultPresenceError,
    retryVaultProbe,
    unlocked,
    setUnlocked,
    password,
    setPassword,
    bioEnrolled,
    bioBusy,
    unlockError,
    onUnlock,
    onUnlockWithBiometric,
    balances,
    balanceError,
    networks,
    advanced,
    setAdvanced,
    uiHelpHints,
    setUiHelpHints,
    vaultSummaries,
    activeVaultId,
    ikaBaseDisplay,
    ikaGateEffective,
    setIkaGateMissingChain,
    handleIkaModeSelect,
    setIkaModePersist,
    appearance,
    setAppearance,
    loadVaults,
    refresh,
  } = state;

  const [tab, setTab] = useState<Tab>(devMode ? devTab : 'vault');
  type WalletOverlay = null | 'vaultMgmt' | 'dwalletMgmt' | 'send';
  const [walletOverlay, setWalletOverlay] = useState<WalletOverlay>(null);
  const [ikaGateLabDrawerOpen, setIkaGateLabDrawerOpen] = useState(false);

  // multi-envelope unlock methods (passkey / waap / etc.). same wiring as in App.tsx.
  const unlockMethodsState = useUnlockMethods({
    vaultExists: vaultExists === true,
    autoLockMinutes: 30,
    setError: state.setUnlockError,
    onUnlocked: () => setUnlocked(true),
  });

  if (vaultExists === null || (vaultExists && unlocked === null)) {
    if (vaultPresenceError && vaultExists === null) {
      return (
        <div className="sp-root">
          <TitleBar variant="wallet" mode={ikaBaseDisplay} onSelect={(m) => void handleIkaModeSelect(m)} modeSize="xs" />
          <div className="sp-bodyScroll">
            <div className="sp-contentTrackShell">
              <div className="sp-contentTrack ch-scrollbar sp-contentTrack--center">
                <div style={{ maxWidth: 420, padding: '0 var(--ch-content-pad)', textAlign: 'center' }}>
                  <p style={{ margin: '0 0 8px 0', fontWeight: 600 }}>couldn't reach the wallet background</p>
                  <p className="sp-muted" style={{ fontSize: 13, color: 'rgba(255,99,132,0.95)', margin: '0 0 16px 0', lineHeight: 1.45 }}>
                    {vaultPresenceError}
                  </p>
                  <button
                    type="button"
                    className="sp-btn sp-btnPrimary"
                    style={{ width: '100%' }}
                    onClick={retryVaultProbe}
                  >
                    retry
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      );
    }
    return (
      <div className="sp-root">
        <TitleBar variant="wallet" mode={ikaBaseDisplay} onSelect={(m) => void handleIkaModeSelect(m)} modeSize="xs" />
        <div className="sp-bodyScroll">
          <div className="sp-contentTrackShell">
            <div className="sp-contentTrack ch-scrollbar sp-contentTrack--center">
              <div className="sp-loading">Loading…</div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!vaultExists) {
    return (
      <div className="sp-root sp-unlock">
        <TitleBar variant="wallet" mode={ikaBaseDisplay} onSelect={(m) => void handleIkaModeSelect(m)} modeSize="xs" />
        <div className="sp-bodyScroll">
          <div className="sp-contentTrackShell">
            <div className="sp-contentTrack ch-scrollbar">
            <div
              style={{
                maxWidth: 520,
                margin: '0 auto',
                padding: '0 var(--ch-content-pad) 22px',
                width: '100%',
                boxSizing: 'border-box',
                minWidth: 0,
              }}
            >
          <div style={{ textAlign: 'center', marginBottom: 20 }}>
            <img src="/chromatika-clean-key.png" alt="" width={100} height={100} style={{ display: 'block', margin: '0 auto', borderRadius: 0 }} />
            <div className="sp-unlockTitle" style={{ marginTop: 12 }}>welcome to chromatika</div>
            <p className="sp-muted" style={{ fontSize: 13, lineHeight: 1.5, marginTop: 10 }}>
              Multi-chain wallet with ika dWallets. Create a <strong>dWallet Vault</strong> here, or open the full
              onboarding tab from the extension popup for the guided tour.
            </p>
            <button
              type="button"
              className="sp-btn sp-btnPrimary"
              style={{ marginTop: 8 }}
              onClick={() => {
                try {
                  const url = chrome.runtime.getURL('onboarding.html');
                  chrome.tabs.create({ url });
                } catch { /* noop */ }
              }}
            >
              open full onboarding tab
            </button>
          </div>
          <WalletSetupFlow
            surface="sidepanel"
            mode={devSetupMode}
            onVaultReady={() => {
              setVaultExists(true);
              setUnlocked(true);
              refresh();
            }}
            initialStep={devMode ? (devSetupStep ?? 'choose') : undefined}
            initialIntent={devMode ? devSetupIntent : undefined}
            initialMnemonicIn={devMode && devSetupStep === 'import' ? DEV_MNEMONIC : undefined}
            initialGeneratedMnemonic={devMode && devSetupStep === 'backup' ? DEV_MNEMONIC : undefined}
            initialBackupConfirmed={devMode && devSetupStep === 'backup' ? devBackupConfirmed : undefined}
          />
            </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!unlocked) {
    return (
      <div className="sp-root sp-unlock">
        <TitleBar variant="wallet" mode={ikaBaseDisplay} onSelect={(m) => void handleIkaModeSelect(m)} modeSize="xs" />
        <div className="sp-bodyScroll">
          <div className="sp-contentTrackShell">
            <div className="sp-contentTrack ch-scrollbar">
              <CodeCurrent options={{ targetSelectors: ['.sp-input', '.sp-btnPrimary'], count: 24 }}>
                <UnlockScreen
                  password={password}
                  onPasswordChange={setPassword}
                  onSubmit={() => void onUnlock()}
                  error={unlockError}
                  bioEnrolled={bioEnrolled}
                  bioBusy={bioBusy}
                  onBiometricUnlock={() => void onUnlockWithBiometric()}
                  extraMethods={unlockMethodsState.extraMethods}
                  hidePasswordSection={
                    !unlockMethodsState.passwordEnvelopeAvailable
                    && unlockMethodsState.extraMethods.length > 0
                  }
                />
              </CodeCurrent>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!devMode && ikaGateEffective) {
    return (
      <div className="sp-root">
        <TitleBar
          variant="wallet"
          mode={ikaBaseDisplay}
          onSelect={(m) => void handleIkaModeSelect(m)}
          onActiveSameMode={() => setWalletOverlay('vaultMgmt')}
          onOpenSettings={() => {
            setWalletOverlay(null);
            setTab('settings');
          }}
          modeSize="xs"
        />
        <div className="sp-bodyScroll">
          <div className="sp-contentTrackShell">
            <div className="sp-contentTrack ch-scrollbar">
              <NeedIkaBaseVaultGate
                chain={ikaGateEffective}
                onCancel={() => {
                  setIkaGateMissingChain(null);
                  const vd = ikaModeFromActiveVault(vaultSummaries, activeVaultId);
                  if (vd) void setIkaModePersist(vd);
                }}
                onVaultReady={() => {
                  setIkaGateMissingChain(null);
                  refresh();
                  loadVaults();
                }}
              />
            </div>
          </div>
        </div>
        <div className={`sp-bottomNavShell sp-bottomNavShell--gateOnly${ikaGateLabDrawerOpen ? ' sp-bottomNavShell--drawerOpen' : ''}`}>
          <CollapsibleIkaLabDrawer
            expanded={ikaGateLabDrawerOpen}
            onToggleExpanded={() => setIkaGateLabDrawerOpen((o) => !o)}
            titleBarHeightPx={52}
            onOpenIkaStaking={() => {
              setWalletOverlay(null);
              setTab('ikaStake');
            }}
            onOpenLab={() => {
              setWalletOverlay(null);
              setTab('lab');
            }}
            onOpenPayments={() => {
              setWalletOverlay(null);
              setTab('payments');
            }}
            onOpenAgents={() => {
              setWalletOverlay(null);
              setTab('agents');
            }}
          />
        </div>
      </div>
    );
  }

  return (
    <MainWalletShell
      ikaMode={ikaBaseDisplay}
      onIkaModeSelect={handleIkaModeSelect}
      balances={balances}
      balanceError={balanceError}
      networks={networks}
      advanced={advanced}
      onAdvancedChange={setAdvanced}
      uiHelpHints={uiHelpHints}
      onUiHelpHintsChange={setUiHelpHints}
      appearance={appearance}
      setAppearance={setAppearance}
      vaultSummaries={vaultSummaries}
      activeVaultId={activeVaultId}
      tab={tab}
      setTab={setTab}
      walletOverlay={walletOverlay}
      setWalletOverlay={setWalletOverlay}
      refresh={refresh}
      onVaultSwitched={refresh}
      onDwalletBarSwitched={refresh}
      settingsInitialTab={devMode ? devSettingsTab : undefined}
    />
  );
}

function SidePanelDevGallery() {
  const dev = 1;
  const side = (q: Record<string, string | number | boolean | null | undefined>) => {
    const params2 = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) {
      if (v === undefined || v === null) continue;
      params2.set(k, String(v));
    }
    return `side_panel.html?${params2.toString()}`;
  };

  const popup = (q: Record<string, string | number | boolean | null | undefined>) => {
    const params2 = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) {
      if (v === undefined || v === null) continue;
      params2.set(k, String(v));
    }
    return `index.html?${params2.toString()}`;
  };

  const links: Array<{ label: string; href: string; pill?: string }> = [
    { label: 'side panel: setup choose', href: side({ dev, vaultExists: 0, unlocked: 0, setupStep: 'choose', setupIntent: 'create' }), pill: 'setup' },
    { label: 'side panel: setup password', href: side({ dev, vaultExists: 0, unlocked: 0, setupStep: 'password', setupIntent: 'create' }), pill: 'setup' },
    { label: 'side panel: setup backup', href: side({ dev, vaultExists: 0, unlocked: 0, setupStep: 'backup', setupIntent: 'create', backupConfirmed: 1 }), pill: 'setup' },
    { label: 'side panel: setup import', href: side({ dev, vaultExists: 0, unlocked: 0, setupStep: 'import', setupIntent: 'import' }), pill: 'setup' },

    { label: 'side panel: unlock (mock)', href: side({ dev, vaultExists: 1, unlocked: 0 }), pill: 'unlock' },
    { label: 'side panel: vault tab', href: side({ dev, vaultExists: 1, unlocked: 1, tab: 'vault' }), pill: 'tab' },
    { label: 'side panel: dWallet tab', href: side({ dev, vaultExists: 1, unlocked: 1, tab: 'dwallet' }), pill: 'tab' },
    { label: 'side panel: assets tab', href: side({ dev, vaultExists: 1, unlocked: 1, tab: 'assets' }), pill: 'tab' },
    { label: 'side panel: activity tab', href: side({ dev, vaultExists: 1, unlocked: 1, tab: 'activity' }), pill: 'tab' },

    { label: 'side panel: settings main', href: side({ dev, vaultExists: 1, unlocked: 1, tab: 'settings', settingsTab: 'main' }), pill: 'settings' },
    { label: 'side panel: settings networks', href: side({ dev, vaultExists: 1, unlocked: 1, tab: 'settings', settingsTab: 'networks' }), pill: 'settings' },
    { label: 'side panel: settings dapps', href: side({ dev, vaultExists: 1, unlocked: 1, tab: 'settings', settingsTab: 'dapps' }), pill: 'settings' },

    { label: 'popup: setup choose', href: popup({ dev, vaultExists: 0, unlocked: 0, setupStep: 'choose', setupIntent: 'create' }), pill: 'popup' },
    { label: 'popup: setup password', href: popup({ dev, vaultExists: 0, unlocked: 0, setupStep: 'password', setupIntent: 'create' }), pill: 'popup' },
    { label: 'popup: setup backup', href: popup({ dev, vaultExists: 0, unlocked: 0, setupStep: 'backup', setupIntent: 'create', backupConfirmed: 1 }), pill: 'popup' },
    { label: 'popup: setup import', href: popup({ dev, vaultExists: 0, unlocked: 0, setupStep: 'import', setupIntent: 'import' }), pill: 'popup' },

    { label: 'popup: unlock screen', href: popup({ dev, vaultExists: 1, unlocked: 0 }), pill: 'popup' },
    { label: 'popup: main screen', href: popup({ dev, vaultExists: 1, unlocked: 1 }), pill: 'popup' },
  ];

  return (
    <div className="sp-root" style={{ padding: 16 }}>
      <div style={{ marginBottom: 12 }}>
        <div className="sp-pageTitle">dev screen gallery</div>
        <div className="sp-muted" style={{ fontSize: 12, marginTop: 6, lineHeight: 1.5 }}>
          quick links to render UI states without creating a real wallet.
          side panel renders mocked balances/networks when <code>dev=1</code>.
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 10 }}>
        {links.map((l) => (
          <a
            key={l.label}
            href={l.href}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              padding: '10px 12px',
              borderRadius: 14,
              border: '1px solid rgba(255,255,255,0.14)',
              background: 'rgba(255,255,255,0.04)',
              color: 'rgba(240,244,255,0.94)',
              textDecoration: 'none',
            }}
          >
            <span style={{ fontSize: 13, fontWeight: 650 }}>{l.label}</span>
            {l.pill ? (
              <span
                style={{
                  fontSize: 11,
                  padding: '2px 10px',
                  borderRadius: 999,
                  border: '1px solid rgba(124,92,252,0.35)',
                  color: 'rgba(234,240,255,0.75)',
                  flexShrink: 0,
                }}
              >
                {l.pill}
              </span>
            ) : null}
          </a>
        ))}
      </div>
    </div>
  );
}
