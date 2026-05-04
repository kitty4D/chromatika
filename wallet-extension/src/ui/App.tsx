import { useEffect, useLayoutEffect, useState } from 'react';
import { trpc } from '@/lib/trpc';
import { WalletSetupFlow, type WalletSetupIntent, type WalletSetupStep } from '@/ui/wallet-setup-flow';
import { TitleBar } from '@/ui/components/TitleBar';
import { CollapsibleIkaLabDrawer } from '@/ui/components/WalletChromeIkaLabStrip';
import { WithPopupHeader } from '@/ui/components/WithPopupHeader';
import { HardwareSignRouter } from '@/ui/screens/hardware-sign-router';
import { PasskeyRegister } from '@/ui/passkey/PasskeyRegister';
import { PasskeySign } from '@/ui/passkey/PasskeySign';
import { DappApprovalScreen } from '@/ui/screens/dapp-approval-screen';
import { ApproveTxScreen } from '@/ui/screens/tx-approval-screen';
import { McpApprovalScreen } from '@/ui/screens/mcp-approval-screen';
import { McpSendSolApprovalScreen } from '@/ui/screens/mcp-send-sol-approval-screen';
import { X402ApprovalScreen } from '@/ui/screens/x402-approval-screen';
import { MainWalletShell } from '@/ui/MainWalletShell';
import { NeedIkaBaseVaultGate } from '@/ui/NeedIkaBaseVaultGate';
import { ikaModeFromActiveVault } from '@/lib/derive-ika-mode-from-vault';
import { UnlockScreen } from '@/ui/unlock-screen';
import { useUnlockMethods } from '@/ui/unlock-methods';
import { CodeCurrent } from '@/ui/effects/code-current';
import { useWalletAppState } from '@/ui/use-wallet-app-state';
import type { Tab } from '@/ui/types';

import './wallet.css';
import { STORAGE_KEYS } from '@/background/storage';

const ONBOARDING_AUTOTAB_KEY = STORAGE_KEYS.ONBOARDING_AUTOTAB_V1;

export function App() {
  const params = new URLSearchParams(location.search);
  const devMode = params.get('dev') === '1';
  const devVaultExists = params.get('vaultExists') === '1';
  const devUnlocked = params.get('unlocked') === '1';

  function asDevSetupStep(v: string | null): WalletSetupStep | null {
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
  function asDevSetupIntent(v: string | null): WalletSetupIntent | null {
    if (v === 'create' || v === 'import') return v;
    return null;
  }

  const DEV_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  const devSetupMode = params.get('setupMode') === 'addVault' ? 'addVault' : 'bootstrap';
  const devSetupStep = asDevSetupStep(params.get('setupStep'));
  const devSetupIntent = asDevSetupIntent(params.get('setupIntent')) ?? 'create';
  const devBackupConfirmed = params.get('backupConfirmed') === '1';
  const devGeneratedForBackup = devSetupStep === 'backup' ? DEV_MNEMONIC : undefined;
  const devMnemonicForImport = devSetupStep === 'import' ? DEV_MNEMONIC : undefined;

  const DEV_BALANCES = {
    locked: false as const,
    ikaBase: 'sui' as const,
    network: 'mainnet',
    feePayerAddress: '0xfeePayer',
    canonicalReceiveAddress: '0xcanon',
    canonicalSource: 'dwallet_ed25519_active',
    address: '0xcanon',
    sui: '5000000000',
    ika: '1000000000',
    funding: { ready: true, missing: [] },
  } as Awaited<ReturnType<typeof trpc.balances.query>>;

  // URL params: approval popup mode (set by background when a dapp / tx / hw sign request fires)
  const [pendingDappReqId] = useState<string | null>(() => {
    try { return new URL(location.href).searchParams.get('dappreq'); }
    catch { return null; }
  });
  const [pendingHwSignId] = useState<string | null>(() => {
    try { return new URL(location.href).searchParams.get('hwsign'); }
    catch { return null; }
  });
  const [pendingTxApproveId] = useState<string | null>(() => {
    try { return new URL(location.href).searchParams.get('txapprove'); }
    catch { return null; }
  });
  const [pendingPasskeyRegisterId] = useState<string | null>(() => {
    try { return new URL(location.href).searchParams.get('passkeyregister'); }
    catch { return null; }
  });
  const [pendingPasskeySignId] = useState<string | null>(() => {
    try { return new URL(location.href).searchParams.get('passkeysign'); }
    catch { return null; }
  });
  const [pendingMcpApproveId] = useState<string | null>(() => {
    try { return new URL(location.href).searchParams.get('mcpapprove'); }
    catch { return null; }
  });
  const [pendingMcpSendSolId] = useState<string | null>(() => {
    try { return new URL(location.href).searchParams.get('mcpsendsol'); }
    catch { return null; }
  });
  const [pendingX402ApproveId] = useState<string | null>(() => {
    try { return new URL(location.href).searchParams.get('x402approve'); }
    catch { return null; }
  });

  const isApprovalPopupUrl = Boolean(
    pendingDappReqId || pendingTxApproveId || pendingHwSignId || pendingPasskeyRegisterId || pendingPasskeySignId || pendingMcpApproveId || pendingMcpSendSolId || pendingX402ApproveId,
  );
  // hw sign + tx approve + passkey register/sign + mcp approve + mcp send-sol + x402 approve windows skip the wallet lifecycle entirely (they own routing)
  const skipLifecycle = Boolean(
    pendingHwSignId || pendingTxApproveId || pendingPasskeyRegisterId || pendingPasskeySignId || pendingMcpApproveId || pendingMcpSendSolId || pendingX402ApproveId,
  );

  useLayoutEffect(() => {
    if (!isApprovalPopupUrl) return;
    document.documentElement.classList.add('ch-ext--approval-popup');
    return () => {
      document.documentElement.classList.remove('ch-ext--approval-popup');
    };
  }, [isApprovalPopupUrl]);

  const state = useWalletAppState({
    devMode,
    skipLifecycle,
    dev: {
      vaultExists: devMode ? devVaultExists : null,
      unlocked: devMode ? devUnlocked : null,
      balances: devMode ? DEV_BALANCES : null,
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
    setBalances,
    balanceError,
    setBalanceError,
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
    refresh,
    refreshBalances,
  } = state;

  // multi-envelope unlock methods. fetches the wallet's envelopes when the unlock screen
  // appears, so the user sees passkey / waap / etc. buttons next to (or instead of) the
  // password field. password-only wallets are unchanged: extra methods is empty.
  const unlockMethodsState = useUnlockMethods({
    vaultExists: vaultExists === true,
    autoLockMinutes: 30,
    setError: state.setUnlockError,
    onUnlocked: () => setUnlocked(true),
  });

  const [popupVaultLabel, setPopupVaultLabel] = useState<string | null>(devMode ? 'default' : null);
  const [popupTab, setPopupTab] = useState<Tab>('vault');
  type PopupWalletOverlay = null | 'vaultMgmt' | 'dwalletMgmt' | 'send';
  const [popupWalletOverlay, setPopupWalletOverlay] = useState<PopupWalletOverlay>(null);
  const [ikaGateLabDrawerOpen, setIkaGateLabDrawerOpen] = useState(false);

  // keep popup vault label in sync with vault summaries / active id
  useEffect(() => {
    if (devMode) return;
    if (!vaultSummaries) {
      setPopupVaultLabel(null);
      return;
    }
    const v = vaultSummaries.find((x) => x.id === activeVaultId);
    setPopupVaultLabel(v?.label ?? null);
  }, [devMode, vaultSummaries, activeVaultId]);

  // first-time setup: open full-tab onboarding once (popup only)
  useEffect(() => {
    if (devMode) return;
    if (vaultExists !== false) return;
    if (pendingHwSignId || pendingTxApproveId || pendingDappReqId || pendingMcpApproveId || pendingX402ApproveId) return;
    try {
      if (/onboarding\.html/i.test(location.pathname)) return;
      chrome.storage.local.get([ONBOARDING_AUTOTAB_KEY], (r) => {
        if (r[ONBOARDING_AUTOTAB_KEY]) return;
        const url = chrome.runtime.getURL('onboarding.html');
        chrome.tabs.create({ url });
        chrome.storage.local.set({ [ONBOARDING_AUTOTAB_KEY]: true });
      });
    } catch {
      /* not extension context */
    }
  }, [vaultExists, pendingHwSignId, pendingTxApproveId, pendingDappReqId, pendingMcpApproveId, pendingX402ApproveId, devMode]);

  // when leaving "main" (e.g. back to unlock), clear popup-only overlays. we do
  // NOT reset popupTab here: a transient `unlocked=false` flip (SW restart
  // between unlock and the unlock-cache rehydrate write — `getTrpcBalanceSummary`
  // returns `{ locked: true }` on missing session, which the use-wallet-app-state
  // "balances came back locked" effect amplifies into setUnlocked(false)) was
  // bouncing users off whichever tab they had just opened. tab persistence is
  // fine: when the user re-unlocks they land on the same tab.
  useEffect(() => {
    const onMain = vaultExists === true && unlocked === true;
    if (!onMain) {
      setPopupWalletOverlay(null);
    }
  }, [vaultExists, unlocked]);

  function openOnboardingTab() {
    try {
      const url = chrome.runtime.getURL('onboarding.html');
      chrome.tabs.create({ url });
    } catch {
      setBalanceError('could not open tab');
    }
  }

  // hw sign popup: skip everything (device holds the key, no unlock needed)
  if (pendingHwSignId) {
    return (
      <WithPopupHeader ikaMode={ikaBaseDisplay} onIkaMode={handleIkaModeSelect}>
        <HardwareSignRouter requestId={pendingHwSignId} />
      </WithPopupHeader>
    );
  }

  // passkey register popup: WebAuthn requires a user gesture in a visible window. background
  // queued the request via `enqueuePasskeyRegister`; this popup runs `navigator.credentials.create`
  // with the PRF hmac-secret extension and posts the artifacts back to background.
  if (pendingPasskeyRegisterId) {
    return (
      <WithPopupHeader ikaMode={ikaBaseDisplay} onIkaMode={handleIkaModeSelect}>
        <PasskeyRegister requestId={pendingPasskeyRegisterId} />
      </WithPopupHeader>
    );
  }

  // passkey sign popup: same user-gesture rules. background queued via `enqueuePasskeySign`,
  // this popup reconstructs `PasskeyKeypair` from the stored credentialId + publicKey, signs
  // the requested challenge, and posts the BCS-encoded Sui passkey signature back.
  if (pendingPasskeySignId) {
    return (
      <WithPopupHeader ikaMode={ikaBaseDisplay} onIkaMode={handleIkaModeSelect} headerMode="approval">
        <PasskeySign requestId={pendingPasskeySignId} />
      </WithPopupHeader>
    );
  }

  // tx approval popup: background already owns auth, popup just runs the approval UI
  if (pendingTxApproveId) {
    return (
      <WithPopupHeader ikaMode={ikaBaseDisplay} onIkaMode={handleIkaModeSelect} headerMode="approval">
        <ApproveTxScreen requestId={pendingTxApproveId} />
      </WithPopupHeader>
    );
  }

  // mcp approval popup: agent surface signMessage requires explicit user click; bg signs after approve.
  if (pendingMcpApproveId) {
    return (
      <WithPopupHeader ikaMode={ikaBaseDisplay} onIkaMode={handleIkaModeSelect} headerMode="approval">
        <McpApprovalScreen requestId={pendingMcpApproveId} />
      </WithPopupHeader>
    );
  }

  // mcp send-sol popup: agent-driven native SOL transfer requires explicit user click; bg signs +
  // broadcasts after approve via `sendSolanaNativeTransfer` (which also writes to tx-record).
  if (pendingMcpSendSolId) {
    return (
      <WithPopupHeader ikaMode={ikaBaseDisplay} onIkaMode={handleIkaModeSelect} headerMode="approval">
        <McpSendSolApprovalScreen requestId={pendingMcpSendSolId} />
      </WithPopupHeader>
    );
  }

  // x402 approval popup: paid-content / agent commerce payments require explicit user click;
  // bg signs the Solana exact-scheme tx after approve and returns the PAYMENT-SIGNATURE header.
  if (pendingX402ApproveId) {
    return (
      <WithPopupHeader ikaMode={ikaBaseDisplay} onIkaMode={handleIkaModeSelect} headerMode="approval">
        <X402ApprovalScreen requestId={pendingX402ApproveId} />
      </WithPopupHeader>
    );
  }

  // initial probe state - loading or transport error
  if (vaultExists === null) {
    if (vaultPresenceError) {
      return (
        <WithPopupHeader ikaMode={ikaBaseDisplay} onIkaMode={handleIkaModeSelect} track="center">
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
        </WithPopupHeader>
      );
    }
    return (
      <WithPopupHeader ikaMode={ikaBaseDisplay} onIkaMode={handleIkaModeSelect} track="center">
        <div className="sp-loading">Loading…</div>
      </WithPopupHeader>
    );
  }

  // setup
  if (!vaultExists) {
    return (
      <WithPopupHeader ikaMode={ikaBaseDisplay} onIkaMode={handleIkaModeSelect} unlockChrome>
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
            <div className="sp-unlockTitle" style={{ marginTop: 12 }}>
              welcome to chromatika
            </div>
            <p className="sp-muted" style={{ fontSize: 13, lineHeight: 1.5, marginTop: 10 }}>
              Multi-chain wallet with ika dWallets. Create a <strong>dWallet Vault</strong> here, or open the full
              onboarding tab from the extension popup for the guided tour.
            </p>
            <button type="button" className="sp-btn sp-btnPrimary" style={{ marginTop: 8 }} onClick={openOnboardingTab}>
              open full onboarding tab
            </button>
            {balanceError && <p className="sp-muted" style={{ color: 'rgba(255,99,132,0.95)', fontSize: 12, marginTop: 8 }}>{balanceError}</p>}
          </div>
          <WalletSetupFlow
            surface="sidepanel"
            mode={devMode ? devSetupMode : undefined}
            onVaultReady={() => {
              setVaultExists(true);
              setUnlocked(true);
              setBalanceError(null);
            }}
            initialStep={devMode ? (devSetupStep ?? 'choose') : undefined}
            initialIntent={devMode ? devSetupIntent : undefined}
            initialMnemonicIn={devMode ? devMnemonicForImport : undefined}
            initialGeneratedMnemonic={devMode ? devGeneratedForBackup : undefined}
            initialBackupConfirmed={devMode ? devBackupConfirmed : undefined}
          />
        </div>
      </WithPopupHeader>
    );
  }

  // unlock
  if (vaultExists && !unlocked) {
    const hidePassword = !unlockMethodsState.passwordEnvelopeAvailable
      && unlockMethodsState.extraMethods.length > 0;
    return (
      <WithPopupHeader ikaMode={ikaBaseDisplay} onIkaMode={handleIkaModeSelect} unlockChrome>
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
            hidePasswordSection={hidePassword}
          />
        </CodeCurrent>
      </WithPopupHeader>
    );
  }

  // dapp approval (after unlock)
  if (pendingDappReqId) {
    return (
      <WithPopupHeader ikaMode={ikaBaseDisplay} onIkaMode={handleIkaModeSelect} headerMode="approval">
        <DappApprovalScreen requestId={pendingDappReqId} />
      </WithPopupHeader>
    );
  }

  // main: gate first if header ika mode has no vault yet
  if (!devMode && ikaGateEffective && vaultSummaries !== null) {
    return (
      <div className="sp-root">
        <TitleBar
          variant="wallet"
          mode={ikaBaseDisplay}
          onSelect={(m) => void handleIkaModeSelect(m)}
          onActiveSameMode={() => setPopupWalletOverlay('vaultMgmt')}
          onOpenSettings={() => {
            setPopupWalletOverlay(null);
            setPopupTab('settings');
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
              setPopupWalletOverlay(null);
              setPopupTab('ikaStake');
            }}
            onOpenLab={() => {
              setPopupWalletOverlay(null);
              setPopupTab('lab');
            }}
            onOpenPayments={() => {
              setPopupWalletOverlay(null);
              setPopupTab('payments');
            }}
            onOpenAgents={() => {
              setPopupWalletOverlay(null);
              setPopupTab('agents');
            }}
          />
        </div>
      </div>
    );
  }

  // main: balance still loading or load failed
  if (!balances || balances.locked) {
    const loadFailed = Boolean(balanceError);
    return (
      <WithPopupHeader ikaMode={ikaBaseDisplay} onIkaMode={handleIkaModeSelect} track="center">
        <div style={{ maxWidth: 420, padding: '0 var(--ch-content-pad)', textAlign: 'center' }}>
          <p style={{ margin: 0, fontWeight: loadFailed ? 700 : 400 }}>
            {loadFailed ? "couldn't load wallet" : 'loading wallet…'}
          </p>
          {loadFailed && (
            <p className="sp-muted" style={{ color: 'rgba(255,99,132,0.95)', fontSize: 13, margin: '12px 0 0 0', lineHeight: 1.4 }}>
              {balanceError}
            </p>
          )}
          <button
            type="button"
            className="sp-btn sp-btnPrimary"
            style={{ marginTop: 12, width: '100%' }}
            onClick={() => refreshBalances({ clearStaleError: true })}
          >
            retry
          </button>
          {loadFailed && (
            <button
              type="button"
              className="sp-btn"
              style={{ marginTop: 10, width: '100%' }}
              onClick={() => {
                setBalanceError(null);
                setBalances(null);
                setUnlocked(false);
              }}
            >
              enter password instead
            </button>
          )}
        </div>
      </WithPopupHeader>
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
      vaultLabelFallback={popupVaultLabel}
      tab={popupTab}
      setTab={setPopupTab}
      walletOverlay={popupWalletOverlay}
      setWalletOverlay={setPopupWalletOverlay}
      refresh={refresh}
      onVaultSwitched={refresh}
      onDwalletBarSwitched={refresh}
    />
  );
}
