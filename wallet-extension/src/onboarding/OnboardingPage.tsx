import { useCallback, useEffect, useState } from 'react';
import { runChromatikaThemeFlash } from '@/lib/run-chromatika-theme-flash';
import { markLocalThemeChangeFromThisDocument } from '@/lib/theme-flash-storage-suppress';
import { trpc } from '@/lib/trpc';
import { WalletSetupFlow } from '@/ui/wallet-setup-flow';
import { AppChromeHeader } from '@/ui/AppChromeHeader';
import { ModeSelectorPanel } from '@/ui/mode-selector/ModeSelectorPanel';
import { OnboardingCelebration } from '@/onboarding/OnboardingCelebration';
import { useIkaBaseMode } from '@/lib/use-ika-base-mode';
import { useAppearanceMode } from '@/lib/use-appearance-mode';
import { useChromatikaThemeDocument } from '@/lib/use-theme-document';
import type { IkaBaseMode } from '@/background/ika-base-mode';
import '@/onboarding/onboarding.css';

const WALLET_EXISTS_RETRY_DELAYS_MS = [0, 200, 500];

export function OnboardingPage() {
  const [exists, setExists] = useState<boolean | null>(null);
  const [presenceError, setPresenceError] = useState<string | null>(null);
  const [vaultProbeNonce, setVaultProbeNonce] = useState(0);
  const [finished, setFinished] = useState(false);
  const [celebrate, setCelebrate] = useState(false);
  const { mode, setMode: setModePersist } = useIkaBaseMode();
  const { appearance } = useAppearanceMode();
  const ikaDisplay = mode ?? 'sui';
  useChromatikaThemeDocument(ikaDisplay, appearance);

  const setMode = useCallback(
    async (m: IkaBaseMode) => {
      if (m === ikaDisplay) return;
      markLocalThemeChangeFromThisDocument();
      await runChromatikaThemeFlash(() => setModePersist(m));
    },
    [ikaDisplay, setModePersist],
  );

  useEffect(() => {
    let cancelled = false;
    setExists(null);
    setPresenceError(null);

    void (async () => {
      let lastErr = 'could not reach the wallet background';
      for (let i = 0; i < WALLET_EXISTS_RETRY_DELAYS_MS.length; i++) {
        const delay = WALLET_EXISTS_RETRY_DELAYS_MS[i]!;
        if (i > 0) {
          const prev = WALLET_EXISTS_RETRY_DELAYS_MS[i - 1]!;
          await new Promise((r) => setTimeout(r, delay - prev));
        }
        if (cancelled) return;
        try {
          const ok = await trpc.walletExists.query();
          if (cancelled) return;
          setExists(ok);
          return;
        } catch (e) {
          lastErr = e instanceof Error ? e.message : String(e);
        }
      }
      if (!cancelled) setPresenceError(lastErr);
    })();

    return () => {
      cancelled = true;
    };
  }, [vaultProbeNonce]);

  const onVaultReady = useCallback(() => {
    setCelebrate(true);
  }, []);

  const onCelebrationComplete = useCallback(() => {
    setCelebrate(false);
    setExists(true);
    setFinished(true);
  }, []);

  if (exists === null && presenceError === null) {
    return (
      <div className="ob-page">
        <div className="ob-noise" />
        <div className="ob-topChrome">
          <AppChromeHeader variant="onboarding" mode={ikaDisplay} onSelect={(m) => void setMode(m)} />
        </div>
        <div className="ob-shell">
          <p className="ob-lead" style={{ margin: 0 }}>loading…</p>
        </div>
      </div>
    );
  }

  if (presenceError) {
    return (
      <div className="ob-page">
        <div className="ob-noise" />
        <div className="ob-topChrome">
          <AppChromeHeader variant="onboarding" mode={ikaDisplay} onSelect={(m) => void setMode(m)} />
        </div>
        <div className="ob-shell">
          <p className="ob-lead" style={{ margin: '0 0 8px 0', fontWeight: 600 }}>
            couldn&apos;t reach the wallet background
          </p>
          <p className="ob-lead" style={{ margin: '0 0 16px 0', color: 'rgba(255,99,132,0.95)', fontSize: 13, lineHeight: 1.45 }}>
            {presenceError}
          </p>
          <p className="ob-lead" style={{ margin: '0 0 16px 0', fontSize: 13, opacity: 0.85, lineHeight: 1.5 }}>
            if you already created a vault, it is still saved. retry here, or open the side panel after the extension wakes up.
          </p>
          <button
            type="button"
            className="ob-doneBtn"
            onClick={() => setVaultProbeNonce((n) => n + 1)}
          >
            retry
          </button>
        </div>
      </div>
    );
  }

  const asideContent =
    finished ? (
      <div className="ob-done">
        <h2>wallet ready</h2>
        <p>
          use the Chromatika icon → side panel for the main wallet. pin the extension if you want it one click away.
        </p>
        <button type="button" className="ob-doneBtn" onClick={() => window.close()}>
          close this tab
        </button>
      </div>
    ) : exists ? (
      <div className="ob-done">
        <h2>already set up</h2>
        <p>this machine already has a vault. unlock from the extension popup or side panel.</p>
        <button type="button" className="ob-doneBtn" onClick={() => window.close()}>
          close
        </button>
      </div>
    ) : celebrate ? (
      <OnboardingCelebration onComplete={onCelebrationComplete} />
    ) : (
      <WalletSetupFlow surface="onboarding" onVaultReady={onVaultReady} />
    );

  return (
    <div className="ob-page">
      <div className="ob-noise" />
      <div className="ob-topChrome">
        <AppChromeHeader variant="onboarding" mode={ikaDisplay} onSelect={(m) => void setMode(m)} />
      </div>
      <div className="ob-shell">
        <header className="ob-hero">
          <p className="ob-kicker">chromatika</p>
          <h1 className="ob-headline">on the spectrum? ur wallet should be too</h1>
          <div className="ob-ikaModeBanner">
            <div className="ob-heroModeRow">
              <ModeSelectorPanel active={ikaDisplay} onSelect={(m) => void setMode(m)} variant="hero" />
              <div className="ob-heroModeLabels">
                <p className="ob-heroModeLabel">pick your ika base chain</p>
                <p className="ob-heroModeHint">
                  <strong>Sui</strong> or <strong>Solana</strong> anchors your dWallet Vaults on-chain. switch anytime; the
                  vibe changes with the chain.
                </p>
              </div>
            </div>
            <p className="ob-ikaModeExplainer">
              <span className="ob-ikaModeExplainer-lead">
                same switcher lives in the top bar everywhere in the app — tweak it whenever your mood shifts.
              </span>
            </p>
          </div>
          <p className="ob-lead">
            Chromatika is a browser wallet that uses Ika dWallets to provide a secure and private way to interact with the blockchain, with support for Ethereum, Bitcoin, Solana, Sui, Aptos, and more.
          </p>
          <ol className="ob-steps">
            <li className="ob-step">
              <span className="ob-stepNum">1</span>
              <div>
                <h3 className="ob-stepTitle">ika base chain + dWallet Vaults</h3>
                <p className="ob-stepBody" style={{ gridColumn: '1 / -1', marginTop: 8 }}>
                  pick <strong>Sui</strong> or <strong>Solana</strong> as your base chain using the switcher in the top bar.
                  this is the blockchain on which the <strong>dWallet Vaults</strong> (wallets that hold/own your dWallets)
                  live. a dWallet Vault can be created, and you&apos;ll receive the seed/mnemonic phrase for safekeeping, or
                  it can be imported in a variety of ways - this is a process you&apos;ll be familiar with as a crypto dork.
                </p>
              </div>
            </li>
            <li className="ob-step">
              <span className="ob-stepNum">2</span>
              <div>
                <h3 className="ob-stepTitle">getcha getcha dWallets</h3>
                <p className="ob-stepBody" style={{ gridColumn: '1 / -1', marginTop: 8 }}>
                  after you add a vault, you meet ika <strong>dWallets</strong> in two ways: we discover dWallets already tied
                  to that owner if you imported, or you create new dWallets. to create them, the vault address must be funded
                  for gas and ika fees. later we plan to let you bootstrap that path using <strong>ETH</strong>,{' '}
                  <strong>BTC</strong>, and <strong>USDC</strong>, instead of only with native tokens on the base chain.
                </p>
              </div>
            </li>
            <li className="ob-step">
              <span className="ob-stepNum">3</span>
              <div>
                <h3 className="ob-stepTitle">one dWallet =&gt; one address on every chain</h3>
                <p className="ob-stepBody" style={{ gridColumn: '1 / -1', marginTop: 8 }}>
                  one <strong>dWallet</strong> surfaces one address per supported chain type you care about: typically one
                  EVM address, one Bitcoin receive identity, one Solana address, one Sui address, one Aptos address, and so
                  on, derived from the curves ika exposes. and one dWallet Vault can have as many dWallets as it is able to fund
                  the creation of.
                </p>
              </div>
            </li>
            <li className="ob-step">
              <span className="ob-stepNum">4</span>
              <div>
                <h3 className="ob-stepTitle">chromatika puts u in the dWallet driver&apos;s seat</h3>
                <p className="ob-stepBody" style={{ gridColumn: '1 / -1', marginTop: 8 }}>
                  this is Chromatika: the chrome between your dWallet-backed addresses and the web. you operate the associated
                  wallets from your dWallets the same way you use any other wallet app - you can connect to dApps, review and
                  sign txns, see balances and activity, and switch vault or dWallet when you need to.
                </p>
              </div>
            </li>
          </ol>
        </header>

        <aside className="ob-aside">
          <p className="ob-asideLabel">create or restore</p>
          <div style={{ maxWidth: 520 }}>
            {asideContent}
          </div>
        </aside>
      </div>
    </div>
  );
}
