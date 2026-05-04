import type { CSSProperties } from 'react';
import type { WalletSetupSurface } from '../internal';
import type { WalletSetupHook } from '../use-wallet-setup';

export function BackupStep({
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
    generatedMnemonic,
    backupConfirmed,
    setBackupConfirmed,
    error,
    backupBusy,
    afterBackupUnlock,
    backFromBackup,
  } = hook;

  const backupCls = `ws-backup ws-backup--${surface}`;
  return (
    <form
      style={box}
      className={backupCls}
      onSubmit={(e) => {
        e.preventDefault();
        void afterBackupUnlock();
      }}
    >
      <div className="ws-backup-brand">
        <img className="ws-backup-logo" src="/chromatika-clean-key.png" alt="" width={100} height={100} />
        <h2 className="ws-backup-title">{mode === 'addVault' ? 'save this vault’s phrase' : 'save your phrase'}</h2>
        <p className="ws-backup-sub">
          {mode === 'addVault'
            ? 'this phrase is only for this new vault. write it down offline - anyone with it controls this vault.'
            : 'write this seed/mnemonic phrase down offline. anyone with it controls your wallet.'}
        </p>
      </div>
      <p className="ws-backup-lead">
        when you continue below, we encrypt the vault and derive ika keys (can take 10-60s on slower devices). if you back
        out before that, nothing is stored yet.
      </p>
      <div className="ws-backup-phrase">
        <span className="ws-backup-phrase-label">recovery phrase</span>
        <textarea
          readOnly
          className="ws-backup-mnemonic"
          value={generatedMnemonic}
          spellCheck={false}
          autoComplete="off"
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.shiftKey) return;
            e.preventDefault();
            (e.currentTarget.form as HTMLFormElement | null)?.requestSubmit();
          }}
        />
      </div>
      <label className="ws-backup-confirm">
        <input type="checkbox" checked={backupConfirmed} onChange={(e) => setBackupConfirmed(e.target.checked)} disabled={backupBusy} />
        <span>i saved it somewhere safe</span>
      </label>
      {error && <p className="ws-password-error">{error}</p>}
      {backupBusy && <p className="ws-backup-hint">encrypting vault and generating keys - stay on this screen…</p>}
      <div className="ws-backup-actions">
        <button type="submit" className="ws-password-btn ws-password-btn--primary" disabled={backupBusy}>
          {backupBusy ? 'working…' : mode === 'addVault' ? 'done' : 'open wallet'}
        </button>
        <button type="button" className="ws-password-btn ws-password-btn--ghost" disabled={backupBusy} onClick={backFromBackup}>
          back to password
        </button>
      </div>
    </form>
  );
}
