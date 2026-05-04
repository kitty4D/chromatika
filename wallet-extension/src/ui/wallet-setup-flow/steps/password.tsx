import type { CSSProperties } from 'react';
import type { WalletSetupSurface } from '../internal';
import type { WalletSetupHook } from '../use-wallet-setup';
import { PwEyeIcon } from '../pw-eye-icon';

export function PasswordStep({
  surface,
  box,
  hook,
}: {
  surface: WalletSetupSurface;
  box: CSSProperties;
  hook: WalletSetupHook;
}) {
  const {
    mode,
    intent,
    setStep,
    setIntent,
    password,
    setPassword,
    password2,
    setPassword2,
    error,
    setError,
    passwordBusy,
    setPasswordBusy,
    showPw,
    setShowPw,
    mnemonicWordCount,
    setMnemonicWordCount,
    crossChainReuseVaultId,
    setCrossChainReuseVaultId,
    otherChainHdVaults,
    ikaBaseReady,
    ikaChainLabel,
    onCreateFinal,
  } = hook;

  if (intent === null) return null;

  const proceedLabel =
    intent === 'import'
      ? 'proceed to import vault'
      : intent === 'importPrivateKey'
        ? 'proceed to private key import'
        : intent === 'hardware' || intent === 'seeker'
          ? 'continue to hardware vault setup'
          : 'proceed to create vault';
  const passwordCls = `ws-password ws-password--${surface}`;
  const inputCls = surface === 'sidepanel' ? 'sp-input' : undefined;

  function cancelPassword() {
    setError(null);
    setIntent(null);
    setPassword('');
    setPassword2('');
    setCrossChainReuseVaultId(null);
    setStep('choose');
  }

  async function onPasswordProceed() {
    setError(null);
    // bootstrap (first-vault) is the only path where chromatika needs to seed a fresh
    // encrypted blob - addVault rides the in-session vaultKey so the password input is
    // unnecessary and would block passkey / waap / lazor / seeker users (they may have
    // no password to type at all).
    if (mode === 'bootstrap') {
      if (password.length < 8) {
        setError('password must be at least 8 characters');
        return;
      }
      if (password !== password2) {
        setError('passwords do not match');
        return;
      }
    }
    if (intent === 'import') {
      setStep('import');
      return;
    }
    if (intent === 'importPrivateKey') {
      setStep('importKey');
      return;
    }
    if (intent === 'hardware') {
      setStep('hardware');
      return;
    }
    if (intent === 'seeker') {
      // bootstrap-only path: choose.tsx routes seeker through password to collect the
      // first-vault password, then the seeker step wraps HardwareStep for pairing.
      setStep('seeker');
      return;
    }
    setPasswordBusy(true);
    try {
      await onCreateFinal();
    } finally {
      setPasswordBusy(false);
    }
  }

  return (
    <form
      style={box}
      className={passwordCls}
      onSubmit={(e) => {
        e.preventDefault();
        void onPasswordProceed();
      }}
    >
      <div className="ws-password-brand">
        <img className="ws-password-logo" src="/chromatika-clean-key.png" alt="" width={100} height={100} />
        <h2 className="ws-password-title">
          {mode === 'addVault' ? 'add a new vault' : 'set up your chromatika password'}
        </h2>
        <p className="ws-password-sub">
          {mode === 'addVault'
            ? 'your wallet is already unlocked - chromatika will reuse the active key to encrypt the new vault.'
            : 'this encrypts your vault on this device. we never send it anywhere.'}
        </p>
        {crossChainReuseVaultId && intent === 'create' && (
          <p className="ws-password-sub" style={{ marginTop: 12 }}>
            reusing the same seed as vault{' '}
            <strong>
              {otherChainHdVaults.find((v) => v.id === crossChainReuseVaultId)?.label ?? 'selected vault'}
            </strong>{' '}
            for this new {ikaChainLabel} vault.
          </p>
        )}
      </div>
      {intent === 'create' && !crossChainReuseVaultId && (
        <div
          className="ws-password-wordcount"
          role="radiogroup"
          aria-label="recovery phrase length"
          style={{ marginBottom: 16 }}
        >
          <span className="ws-password-label" style={{ display: 'block', marginBottom: 8 }}>
            recovery phrase length
          </span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 14 }}>
              <input
                type="radio"
                name="chromatika-mnemonic-len"
                checked={mnemonicWordCount === 12}
                onChange={() => setMnemonicWordCount(12)}
                disabled={passwordBusy}
              />
              12 words (default)
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 14 }}>
              <input
                type="radio"
                name="chromatika-mnemonic-len"
                checked={mnemonicWordCount === 24}
                onChange={() => setMnemonicWordCount(24)}
                disabled={passwordBusy}
              />
              24 words (stronger entropy)
            </label>
          </div>
        </div>
      )}
      {mode === 'bootstrap' && (
        <div className="ws-password-fields">
          <label className="ws-password-label">
            <span>password</span>
            <div className="ws-password-inputWrap">
              <input
                type={showPw ? 'text' : 'password'}
                autoComplete="new-password"
                placeholder="at least 8 characters"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={inputCls ?? 'ws-password-input'}
              />
              <button
                type="button"
                className="ws-password-toggle"
                onClick={() => setShowPw((v) => !v)}
                aria-label={showPw ? 'hide password' : 'show password'}
                tabIndex={-1}
              >
                <PwEyeIcon open={showPw} />
              </button>
            </div>
          </label>
          <label className="ws-password-label">
            <span>confirm password</span>
            <div className="ws-password-inputWrap">
              <input
                type={showPw ? 'text' : 'password'}
                autoComplete="new-password"
                placeholder="repeat password"
                value={password2}
                onChange={(e) => setPassword2(e.target.value)}
                className={inputCls ?? 'ws-password-input'}
              />
              <button
                type="button"
                className="ws-password-toggle"
                onClick={() => setShowPw((v) => !v)}
                aria-label={showPw ? 'hide password' : 'show password'}
                tabIndex={-1}
              >
                <PwEyeIcon open={showPw} />
              </button>
            </div>
          </label>
        </div>
      )}
      {error && <p className="ws-password-error">{error}</p>}
      {mode === 'addVault' && !ikaBaseReady && (
        <p className="ws-password-hint" style={{ fontSize: 13, margin: '0 0 10px 0', opacity: 0.85 }}>
          loading ika base chain from settings…
        </p>
      )}
      {passwordBusy && (
        <p className="ws-password-hint" style={{ fontSize: 13, margin: '0 0 10px 0', opacity: 0.85 }}>
          {crossChainReuseVaultId ? 'loading your existing phrase…' : 'generating your recovery phrase…'}
        </p>
      )}
      <div className="ws-password-actions">
        <button
          type="button"
          className="ws-password-btn ws-password-btn--ghost"
          onClick={cancelPassword}
          disabled={passwordBusy}
        >
          cancel
        </button>
        <button
          type="submit"
          className="ws-password-btn ws-password-btn--primary"
          disabled={passwordBusy || (mode === 'addVault' && !ikaBaseReady)}
        >
          {passwordBusy ? 'working…' : proceedLabel}
        </button>
      </div>
    </form>
  );
}
