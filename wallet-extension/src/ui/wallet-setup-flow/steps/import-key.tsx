import type { CSSProperties } from 'react';
import type { WalletSetupSurface } from '../internal';
import type { WalletSetupHook } from '../use-wallet-setup';

export function ImportKeyStep({
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
    setStep,
    setError,
    privateKeyIn,
    setPrivateKeyIn,
    solanaKeyB64In,
    setSolanaKeyB64In,
    effectiveIkaBase,
    error,
    importKeyBusy,
    onImportPrivateKey,
    solanaKeyImportFormat,
    setSolanaKeyImportFormat,
  } = hook;

  const ikCls = `ws-import ws-import--${surface}`;
  const inputCls = surface === 'sidepanel' ? 'sp-input' : undefined;

  return (
    <form
      style={box}
      className={ikCls}
      onSubmit={(e) => {
        e.preventDefault();
        void onImportPrivateKey();
      }}
    >
      <div className="ws-import-brand">
        <img className="ws-import-logo" src="/chromatika-clean-key.png" alt="" width={100} height={100} />
        <h2 className="ws-import-title">Import private key</h2>
        <p className="ws-import-sub">
          {effectiveIkaBase === 'solana' ? (
            <>
              Paste your <strong>Solana fee payer</strong> secret key. This material pays ika gRPC fees and seeds the ika
              encryption root. Never share it — it stays on this device.
            </>
          ) : (
            <>
              Paste a Mysten <strong>suiprivkey</strong> (Ed25519). ika fee payer + encryption root use the same
              derivation as mnemonic path 0.
            </>
          )}
        </p>
      </div>
      {effectiveIkaBase === 'solana' ? (
        <>
          <div className="ws-import-keyFormatRow" role="group" aria-label="secret key format">
            <button
              type="button"
              className={
                solanaKeyImportFormat === 'base64'
                  ? 'ws-password-btn ws-password-btn--primary'
                  : 'ws-password-btn ws-password-btn--ghost'
              }
              disabled={importKeyBusy}
              onClick={() => {
                setError(null);
                setSolanaKeyImportFormat('base64');
              }}
            >
              base64 (64-byte keypair)
            </button>
            <button
              type="button"
              className={
                solanaKeyImportFormat === 'jsonArray'
                  ? 'ws-password-btn ws-password-btn--primary'
                  : 'ws-password-btn ws-password-btn--ghost'
              }
              disabled={importKeyBusy}
              onClick={() => {
                setError(null);
                setSolanaKeyImportFormat('jsonArray');
              }}
            >
              JSON array / keypair file
            </button>
          </div>
          <label className="ws-import-phrase-label" htmlFor="ws-import-sol-b64">
            {solanaKeyImportFormat === 'base64'
              ? 'Solana secret key (base64, 64 raw bytes)'
              : 'Byte array [0–255, …] or {"secretKey":[…]} (64 entries)'}
          </label>
          <textarea
            id="ws-import-sol-b64"
            placeholder={solanaKeyImportFormat === 'base64' ? 'base64…' : '[34,12,…] or paste solana-keygen json'}
            value={solanaKeyB64In}
            onChange={(e) => setSolanaKeyB64In(e.target.value)}
            className={['ws-import-mnemonic', inputCls].filter(Boolean).join(' ')}
            spellCheck={false}
            autoComplete="off"
            disabled={importKeyBusy}
            rows={solanaKeyImportFormat === 'jsonArray' ? 5 : 3}
          />
        </>
      ) : (
        <>
          <label className="ws-import-phrase-label" htmlFor="ws-import-pk-field">
            suiprivkey…
          </label>
          <textarea
            id="ws-import-pk-field"
            placeholder="suiprivkey…"
            value={privateKeyIn}
            onChange={(e) => setPrivateKeyIn(e.target.value)}
            className={['ws-import-mnemonic', inputCls].filter(Boolean).join(' ')}
            spellCheck={false}
            autoComplete="off"
            disabled={importKeyBusy}
            rows={3}
          />
        </>
      )}
      {error && <p className="ws-password-error">{error}</p>}
      {importKeyBusy && <p className="ws-import-hint">encrypting vault and deriving ika keys…</p>}
      <div className="ws-import-actions">
        <button type="submit" className="ws-password-btn ws-password-btn--primary" disabled={importKeyBusy}>
          {importKeyBusy ? 'working…' : mode === 'addVault' ? 'add vault' : 'import vault'}
        </button>
        <button
          type="button"
          className="ws-password-btn ws-password-btn--ghost"
          disabled={importKeyBusy}
          onClick={() => {
            setError(null);
            setStep('password');
          }}
        >
          back to password
        </button>
      </div>
    </form>
  );
}
