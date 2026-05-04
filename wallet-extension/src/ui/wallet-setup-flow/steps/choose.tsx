import { useState, type CSSProperties } from 'react';
import type { WalletSetupSurface } from '../internal';
import type { WalletSetupHook } from '../use-wallet-setup';
import { hardwareConnectOptionLabels } from '../hardware-connect-preview';

/**
 * choose step: primary onboarding entry point.
 *
 * only the **current** ika base's two primary CTAs (Sui: passkey + waap, Solana: lazor + seeker).
 * hardware, then advanced. chain switch sits **below** advanced so add-vault users see they're
 * scoped to one base without opening advanced.
 */
export function ChooseStep({
  surface,
  box,
  onDismiss,
  hook,
}: {
  surface: WalletSetupSurface;
  box: CSSProperties;
  onDismiss?: () => void;
  hook: WalletSetupHook;
}) {
  const {
    mode,
    setStep,
    setIntent,
    setCrossChainReuseVaultId,
    effectiveIkaBase,
    ikaChainLabel,
    otherChainHdVaults,
    reuseVaultSelect,
    setReuseVaultSelect,
    addVaultAllVaults,
    setChooseIkaBaseDraft,
    addVaultChainPickerLocked,
  } = hook;

  const [advancedOpen, setAdvancedOpen] = useState(false);

  const chooseCls = `ws-choose ws-choose--${surface}${mode === 'addVault' ? ' ws-choose--addVault' : ''}`;

  function goToStep(intent: 'passkey' | 'waap' | 'lazor' | 'seeker') {
    setCrossChainReuseVaultId(null);
    setIntent(intent);
    // seeker (mwa-solana hardware) needs a chromatika password in bootstrap mode to seed
    // the encrypted vault blob - PasskeyStep / WaapStep / LazorStep collect their own
    // (or derive from the auth method), but SeekerStep is a thin wrapper around HardwareStep
    // and has no password UI of its own. route through PasswordStep for first-vault seeker
    // setup; in addVault mode the wallet is already unlocked so we go direct.
    if (intent === 'seeker' && mode === 'bootstrap') {
      setStep('password');
      return;
    }
    setStep(intent);
  }

  const hwPreviewLines = hardwareConnectOptionLabels({
    ikaBase: effectiveIkaBase,
    mode,
    vaultSummaries: mode === 'addVault' ? addVaultAllVaults : null,
  });

  const solanaPrimary = (
    <>
      <div className="ws-choose-section ws-choose-section--first">On Solana</div>
      <button type="button" className="ws-choose-btn ws-choose-btn--primary" onClick={() => goToStep('lazor')}>
        <span className="ws-choose-btn-stack">
          <span>create with lazor</span>
          <span className="ws-choose-btn-sub">passkey-secured solana smart wallet</span>
        </span>
      </button>
      <button type="button" className="ws-choose-btn ws-choose-btn--primary" onClick={() => goToStep('seeker')}>
        <span className="ws-choose-btn-stack">
          <span>connect seeker</span>
          <span className="ws-choose-btn-sub">your solana phone signs every transaction</span>
        </span>
      </button>
    </>
  );

  const suiPrimary = (
    <>
      <div className="ws-choose-section ws-choose-section--first">On Sui</div>
      <button type="button" className="ws-choose-btn ws-choose-btn--primary" onClick={() => goToStep('passkey')}>
        <span className="ws-choose-btn-stack">
          <span>create with passkey</span>
          <span className="ws-choose-btn-sub">face id · fingerprint · pin</span>
        </span>
      </button>
      <button type="button" className="ws-choose-btn ws-choose-btn--primary" onClick={() => goToStep('waap')}>
        <span className="ws-choose-btn-stack">
          <span>sign in with waap</span>
          <span className="ws-choose-btn-sub">email · phone · google · discord · twitter · github · bluesky</span>
        </span>
      </button>
    </>
  );

  const crossBaseVaultKind = effectiveIkaBase === 'solana' ? 'Sui' : 'Solana';

  return (
    <div style={box} className={chooseCls}>
      <div className="ws-choose-brand">
        <img className="ws-choose-logo" src="/chromatika-clean-key.png" alt="" width={100} height={100} />
      </div>
      {mode !== 'addVault' && (
        <p className="ws-choose-lead">
          Pick how you want to sign in. Each option creates a <strong>dWallet Vault</strong> with addresses on every
          supported chain — passkey + waap anchor on <strong>Sui</strong>, lazor + seeker anchor on{' '}
          <strong>Solana</strong>.
        </p>
      )}

      <div
        className="ws-choose-actions"
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.preventDefault();
        }}
      >
        {effectiveIkaBase === 'solana' ? solanaPrimary : suiPrimary}

        <button
          type="button"
          className="ws-choose-btn ws-choose-btn--secondary"
          title="Ledger, Trezor, WalletConnect, Solana Mobile — fee signing on device; ika keys copied or derived from wallet signature"
          onClick={() => {
            setCrossChainReuseVaultId(null);
            setIntent('hardware');
            setStep('password');
          }}
        >
          <span className="ws-choose-btn-stack">
            <span>connect other hardware wallet</span>
            {hwPreviewLines.length > 0 ? (
              <span className="ws-choose-btn-sub">{hwPreviewLines.join(' · ')}</span>
            ) : null}
          </span>
        </button>

        <button
          type="button"
          className="ws-choose-advanced-toggle"
          aria-expanded={advancedOpen}
          aria-controls="ws-choose-advanced-panel"
          onClick={() => setAdvancedOpen((v) => !v)}
        >
          advanced {advancedOpen ? '▴' : '▾'}
        </button>

        {advancedOpen && (
          <div className="ws-choose-advanced-panel" id="ws-choose-advanced-panel">
            {mode === 'addVault' && otherChainHdVaults.length > 0 && (
              <>
                <label className="ws-choose-selectWrap">
                  <span className="ws-choose-selectLabel ws-choose-selectLabel--sentence">
                    Use seed from existing {crossBaseVaultKind} vault
                  </span>
                  <select
                    className="ws-choose-select"
                    value={reuseVaultSelect}
                    onChange={(e) => setReuseVaultSelect(e.target.value)}
                  >
                    <option value="">no vault selected</option>
                    {otherChainHdVaults.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.label}
                      </option>
                    ))}
                  </select>
                </label>
                {reuseVaultSelect !== '' && (
                  <button
                    type="button"
                    className="ws-choose-btn ws-choose-btn--secondary"
                    onClick={() => {
                      setCrossChainReuseVaultId(reuseVaultSelect);
                      setIntent('create');
                      setStep('password');
                    }}
                  >
                    continue with selected vault&apos;s seed ({ikaChainLabel} base)
                  </button>
                )}
              </>
            )}
            <button
              type="button"
              className="ws-choose-btn ws-choose-btn--secondary"
              onClick={() => {
                setCrossChainReuseVaultId(null);
                setIntent('create');
                setStep('password');
              }}
            >
              create new seed phrase
            </button>
            <button
              type="button"
              className="ws-choose-btn ws-choose-btn--secondary"
              onClick={() => {
                setCrossChainReuseVaultId(null);
                setIntent('import');
                setStep('password');
              }}
            >
              import seed phrase / mnemonic
            </button>
            <button
              type="button"
              className="ws-choose-btn ws-choose-btn--secondary"
              onClick={() => {
                setCrossChainReuseVaultId(null);
                setIntent('importPrivateKey');
                setStep('password');
              }}
            >
              import private key
            </button>
          </div>
        )}

        {mode === 'addVault' && !addVaultChainPickerLocked && (
          <div className="ws-choose-chainFoot">
            <p className="ws-choose-chainFoot-scope">
              {effectiveIkaBase === 'solana' ? (
                <>
                  You&apos;re adding a vault on <strong>Solana</strong> ika base - only Solana entry points are listed
                  above. You can still change ika base in the header.
                </>
              ) : (
                <>
                  You&apos;re adding a vault on <strong>Sui</strong> ika base - only Sui entry points are listed above.
                  You can still change ika base in the header.
                </>
              )}
            </p>
            <p className="ws-choose-chainFoot-switch">
              {effectiveIkaBase === 'solana' ? (
                <>
                  Need passkey or waap instead?{' '}
                  <button type="button" className="ws-choose-inlineLink" onClick={() => setChooseIkaBaseDraft('sui')}>
                    Show Sui options here
                  </button>
                </>
              ) : (
                <>
                  Need lazor or Seeker instead?{' '}
                  <button
                    type="button"
                    className="ws-choose-inlineLink"
                    onClick={() => setChooseIkaBaseDraft('solana')}
                  >
                    Show Solana options here
                  </button>
                </>
              )}
            </p>
          </div>
        )}
      </div>

      <p className="ws-choose-tagline">getcha getcha getcha getcha wallet on</p>
      {mode === 'addVault' && onDismiss && (
        <button type="button" className="ws-choose-btn ws-choose-btn--secondary" style={{ marginTop: 12 }} onClick={onDismiss}>
          ← back to settings
        </button>
      )}
    </div>
  );
}
