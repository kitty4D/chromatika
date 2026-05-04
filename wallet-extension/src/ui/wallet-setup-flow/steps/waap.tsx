import { useEffect, useState, type CSSProperties } from 'react';
import { trpc } from '@/lib/trpc';
import { ensureWaapSuiWallet } from '@/ui/waap/waap-init';
import { IKA_USK_DERIVATION_MESSAGE } from '@/background/keyring/hd';
import type { WalletSetupSurface } from '../internal';
import type { WalletSetupHook } from '../use-wallet-setup';

type Phase =
  | { kind: 'idle' }
  | { kind: 'fetching-phrase' }
  | { kind: 'show-phrase' }
  | { kind: 'enter-phrase' }
  | { kind: 'connecting' }
  | { kind: 'probing' }
  | { kind: 'submitting' }
  | { kind: 'done' }
  | { kind: 'error'; message: string };

/**
 * waap (`@human.tech/waap-sdk`) vault create / add / restore step. mirrors Lazor's
 * three-mode `seedMode` toggle: `waap-signature` (deterministic) | `recovery-generate`
 * (chromatika picks a fresh phrase) | `recovery-restore` (user pastes existing phrase).
 *
 * **mode dispatch**:
 *   - **waap-signature** (recommended): chromatika runs the determinism probe (sign the
 *     same `IKA_USK_DERIVATION_MESSAGE` twice + compare bytes). on match, the signature
 *     IS the ika seed input via `keccak256(sig || index_le)`. same waap login on any device
 *     reproduces the same dWallet, so this mode covers BOTH "create new" and "restore
 *     existing" transparently. on mismatch, surface a clear error pointing the user at
 *     the recovery-words modes.
 *   - **recovery-generate**: chromatika generates a fresh BIP39 24-word phrase. user
 *     copies it. seed = `keccak256(bip39Seed || index_le)`. works on any waap auth method
 *     including non-deterministic ones. encrypted into the vault blob for later display.
 *   - **recovery-restore**: user pastes their existing 24-word phrase (presumably saved
 *     from a prior `recovery-generate` run). same seed = same dWallet. the waap login
 *     still has to be paired so the vault knows which Sui address to scan for existing
 *     dWallet caps; this is a connect-but-skip-probe path — determinism doesn't matter
 *     because the seed comes from the phrase, not from the signature.
 *
 * password requirement matches the passkey step: chromatika's local vault blob is still
 * Argon2id + AES-GCM encrypted under the user's password. recovery-words modes always
 * require a password (no signature → no envelope → no waap-only unlock fallback).
 */
export function WaapStep({
  surface,
  box,
  hook,
}: {
  surface: WalletSetupSurface;
  box: CSSProperties;
  hook: WalletSetupHook;
}) {
  const { mode, setStep, setIntent, password, setPassword, password2, setPassword2 } = hook;
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [localError, setLocalError] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [walletExists, setWalletExistsLocal] = useState<boolean | null>(null);
  const [seedMode, setSeedMode] = useState<
    'waap-signature' | 'recovery-generate' | 'recovery-restore'
  >('waap-signature');
  // generate-phrase path state
  const [phrase, setPhrase] = useState('');
  const [phraseConfirmed, setPhraseConfirmed] = useState(false);
  // restore-phrase path state
  const [restoreInput, setRestoreInput] = useState('');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const exists = await trpc.walletExists.query();
        if (!cancelled) setWalletExistsLocal(Boolean(exists));
      } catch {
        if (!cancelled) setWalletExistsLocal(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // generate-phrase: produce the phrase + transition to show-phrase.
  useEffect(() => {
    if (phase.kind !== 'fetching-phrase') return;
    let cancelled = false;
    void (async () => {
      try {
        const { mnemonic } = await trpc.generateSetupMnemonic.query({ wordCount: 24 });
        if (cancelled) return;
        setPhrase(mnemonic);
        setPhase({ kind: 'show-phrase' });
      } catch (e) {
        if (cancelled) return;
        setPhase({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [phase.kind]);

  const cls = `ws-step ws-step--${surface}`;
  const isBootstrap = mode === 'bootstrap';
  const isFreshBootstrap = isBootstrap && walletExists === false;
  const busy =
    phase.kind === 'fetching-phrase'
    || phase.kind === 'connecting'
    || phase.kind === 'probing'
    || phase.kind === 'submitting';

  /**
   * shared password validation. recovery-words modes ALWAYS require a password (no
   * signature envelope on those paths). waap-signature mode allows password-less for
   * non-bootstrap when an existing wallet is unlocked under another method.
   */
  function validatePassword(): string | null {
    const wantPassword = password.length > 0;
    if (walletExists === true && !wantPassword) {
      return 'enter the existing chromatika password to unlock this wallet first.';
    }
    if (seedMode !== 'waap-signature' && !wantPassword) {
      return 'recovery-words modes require a password (no waap-only unlock fallback).';
    }
    if (wantPassword && password.length < 8) {
      return walletExists === true
        ? 'password must be at least 8 characters'
        : 'password must be at least 8 characters (or leave it empty for waap-only when deterministic)';
    }
    if (isFreshBootstrap && wantPassword && password !== password2) {
      return 'passwords do not match';
    }
    return null;
  }

  /** dispatcher: validate password, branch on seedMode. */
  function start() {
    setLocalError(null);
    const err = validatePassword();
    if (err) {
      setLocalError(err);
      return;
    }
    if (seedMode === 'recovery-generate') {
      setPhase({ kind: 'fetching-phrase' });
      return;
    }
    if (seedMode === 'recovery-restore') {
      setPhase({ kind: 'enter-phrase' });
      return;
    }
    void runWaapSignaturePath();
  }

  /** generate-phrase confirm step → run the recovery-words path with the chromatika-picked phrase. */
  async function continueAfterGeneratedPhrase() {
    if (!phraseConfirmed) {
      setLocalError('confirm you have your recovery phrase saved');
      return;
    }
    await runRecoveryWordsPath(phrase);
  }

  /** restore-phrase typed step → run the recovery-words path with the user-pasted phrase. */
  async function continueAfterRestoreInput() {
    const phraseTrimmed = restoreInput.trim().replace(/\s+/g, ' ');
    if (!phraseTrimmed) {
      setLocalError('enter your recovery phrase');
      return;
    }
    await runRecoveryWordsPath(phraseTrimmed);
  }

  /**
   * waap-signature seed-source path. opens the waap modal, runs the determinism probe
   * (sign the same message twice + compare bytes). on match, persist with the signature
   * as the ika seed. on mismatch, surface a clear error pointing at the recovery-words
   * modes.
   */
  async function runWaapSignaturePath() {
    setLocalError(null);
    setPhase({ kind: 'connecting' });
    try {
      const wallet = await ensureWaapSuiWallet({ darkMode: true });
      const conn = await wallet.connect();
      const account = conn.accounts[0];
      if (!account) throw new Error('waap returned no account on connect');

      setPhase({ kind: 'probing' });
      const sigA = await wallet.signPersonalMessage({
        message: IKA_USK_DERIVATION_MESSAGE,
        account,
      });
      const sigB = await wallet.signPersonalMessage({
        message: IKA_USK_DERIVATION_MESSAGE,
        account,
      });
      const deterministic = sigA.signature === sigB.signature;

      if (!deterministic) {
        throw new Error(
          'waap signatures on this device are non-deterministic. switch to "generate a 24-word '
          + 'phrase" or "restore from phrase" below — those work on any authenticator. (apple '
          + 'platform authenticators + most hardware tokens are deterministic; some android '
          + 'implementations and older yubikeys are not.)',
        );
      }

      setPhase({ kind: 'submitting' });
      const labelTrimmed = label.trim() || (isBootstrap ? undefined : 'waap');
      const publicKeyB64 = btoa(String.fromCharCode(...new Uint8Array(account.publicKey)));
      const wantPassword = password.length > 0;
      const waapAuthMethod: 'email' | 'phone' | 'social' = 'social';

      const persistInput = {
        password: wantPassword ? password : undefined,
        waapSuiAddress: account.address,
        waapSuiPublicKeyB64: publicKeyB64,
        waapAuthMethod,
        seedSource: 'waap-signature' as const,
        pairingSignatureB64: sigA.signature,
        label: labelTrimmed,
      };
      if (isBootstrap) {
        await trpc.createVaultWaap.mutate(persistInput);
        if (wantPassword) {
          await trpc.unlockVault.mutate({ password, autoLockMinutes: 30 });
        }
      } else {
        await trpc.addVaultWaap.mutate(persistInput);
      }
      hook.setPassword('');
      hook.setPassword2('');
      setPhase({ kind: 'done' });
      hook.onVaultReady();
    } catch (e) {
      setPhase({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }

  /**
   * shared persist for both recovery-words sub-paths. the seed comes from the phrase, not
   * the waap signature. we still call `wallet.connect()` to obtain the user's waap Sui
   * address + public key (those are needed for the vault record + for dWallet discovery
   * scanning), but skip the determinism probe (irrelevant for this seed source).
   */
  async function runRecoveryWordsPath(phraseValue: string) {
    setLocalError(null);
    setPhase({ kind: 'connecting' });
    try {
      const wallet = await ensureWaapSuiWallet({ darkMode: true });
      const conn = await wallet.connect();
      const account = conn.accounts[0];
      if (!account) throw new Error('waap returned no account on connect');

      setPhase({ kind: 'submitting' });
      const labelTrimmed = label.trim() || (isBootstrap ? undefined : 'waap');
      const publicKeyB64 = btoa(String.fromCharCode(...new Uint8Array(account.publicKey)));
      const waapAuthMethod: 'email' | 'phone' | 'social' = 'social';

      const persistInput = {
        password,
        waapSuiAddress: account.address,
        waapSuiPublicKeyB64: publicKeyB64,
        waapAuthMethod,
        seedSource: 'recovery-words' as const,
        recoveryWords: phraseValue,
        label: labelTrimmed,
      };
      if (isBootstrap) {
        await trpc.createVaultWaap.mutate(persistInput);
        await trpc.unlockVault.mutate({ password, autoLockMinutes: 30 });
      } else {
        await trpc.addVaultWaap.mutate(persistInput);
      }
      hook.setPassword('');
      hook.setPassword2('');
      setPhrase('');
      setPhraseConfirmed(false);
      setRestoreInput('');
      setPhase({ kind: 'done' });
      hook.onVaultReady();
    } catch (e) {
      setPhase({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }

  const showInputs = phase.kind === 'idle' || phase.kind === 'enter-phrase';

  return (
    <div style={box} className={cls}>
      <h2 style={{ margin: '0 0 8px' }}>sign in with waap</h2>
      <p style={{ margin: '0 0 18px', fontSize: 13, lineHeight: 1.55, opacity: 0.85 }}>
        email, phone, or social (google · discord · twitter · github · bluesky) via waap's
        human network 2pc. waap signs your sui-base ika dwallet vault; addresses on every
        supported chain come from the dwallet mpc layer.
      </p>

      {phase.kind === 'idle' && (
        <fieldset
          style={{
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: 8,
            padding: '10px 12px',
            margin: '0 0 14px',
          }}
        >
          <legend style={{ fontSize: 12, opacity: 0.85, padding: '0 4px' }}>cross-chain identity source</legend>
          <label
            style={{
              display: 'flex',
              gap: 8,
              alignItems: 'flex-start',
              marginBottom: 8,
              fontSize: 12.5,
            }}
          >
            <input
              type="radio"
              name="waap-seed-mode"
              checked={seedMode === 'waap-signature'}
              onChange={() => setSeedMode('waap-signature')}
              disabled={busy}
              style={{ marginTop: 3 }}
            />
            <span>
              <strong>waap signature</strong> (recommended) - the same waap login produces the
              same dWallet on any device. no phrase to write down. requires deterministic
              waap signatures (verified by the determinism probe).
            </span>
          </label>
          <label
            style={{
              display: 'flex',
              gap: 8,
              alignItems: 'flex-start',
              marginBottom: 8,
              fontSize: 12.5,
            }}
          >
            <input
              type="radio"
              name="waap-seed-mode"
              checked={seedMode === 'recovery-generate'}
              onChange={() => setSeedMode('recovery-generate')}
              disabled={busy}
              style={{ marginTop: 3 }}
            />
            <span>
              <strong>generate a 24-word phrase</strong> - chromatika picks one for you. write
              it down to recover cross-chain on a new device. works on any waap authenticator
              including non-deterministic ones.
            </span>
          </label>
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12.5 }}>
            <input
              type="radio"
              name="waap-seed-mode"
              checked={seedMode === 'recovery-restore'}
              onChange={() => setSeedMode('recovery-restore')}
              disabled={busy}
              style={{ marginTop: 3 }}
            />
            <span>
              <strong>restore from phrase</strong> - paste your existing 24-word phrase. waap
              identity comes from logging in again with the same waap account.
            </span>
          </label>
        </fieldset>
      )}

      {phase.kind === 'show-phrase' && (
        <>
          <p style={{ margin: '0 0 12px', fontSize: 13, lineHeight: 1.5, opacity: 0.95 }}>
            <strong>write this 24-word phrase down before continuing.</strong> it's how you
            recover cross-chain (sui / evm / btc / aptos) on a new device. waap handles your
            identity via the same login on any device, but the cross-chain dWallet seed needs
            this phrase.
          </p>
          <textarea
            className="ws-backup-mnemonic"
            value={phrase}
            readOnly
            style={{ minHeight: 120, marginBottom: 12 }}
          />
          <label className="ws-backup-confirm" style={{ marginBottom: 12 }}>
            <input
              type="checkbox"
              checked={phraseConfirmed}
              onChange={(e) => setPhraseConfirmed(e.target.checked)}
              disabled={busy}
            />
            <span>i've written down my recovery phrase and stored it somewhere safe.</span>
          </label>
        </>
      )}

      {phase.kind === 'enter-phrase' && (
        <>
          <p style={{ margin: '0 0 8px', fontSize: 13, lineHeight: 1.5, opacity: 0.85 }}>
            paste your existing 24-word recovery phrase. spaces are normalized.
          </p>
          <textarea
            value={restoreInput}
            onChange={(e) => setRestoreInput(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            placeholder="word1 word2 word3 ..."
            style={{
              width: '100%',
              minHeight: 100,
              marginBottom: 12,
              fontFamily: 'monospace',
              fontSize: 12,
            }}
            disabled={busy}
          />
        </>
      )}

      {showInputs && (
        <>
          <label className="ws-password-label" style={{ display: 'block', marginBottom: 12 }}>
            <span>
              {walletExists === true
                ? 'your existing chromatika password (to unlock + add this waap login)'
                : seedMode === 'waap-signature'
                  ? 'password (optional — leave empty for waap-only unlock when deterministic)'
                  : 'password (required for recovery-words modes)'}
            </span>
            <input
              className="ws-password-input"
              type="password"
              autoComplete={isFreshBootstrap ? 'new-password' : 'current-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
              placeholder={
                walletExists === true
                  ? ''
                  : seedMode === 'waap-signature'
                    ? 'optional'
                    : 'required'
              }
            />
          </label>
          {isFreshBootstrap && password.length > 0 && (
            <label className="ws-password-label" style={{ display: 'block', marginBottom: 12 }}>
              <span>confirm password</span>
              <input
                className="ws-password-input"
                type="password"
                autoComplete="new-password"
                value={password2}
                onChange={(e) => setPassword2(e.target.value)}
                disabled={busy}
              />
            </label>
          )}
          <label className="ws-password-label" style={{ display: 'block', marginBottom: 12 }}>
            <span>vault label (optional)</span>
            <input
              className="ws-password-input"
              type="text"
              placeholder={isBootstrap ? 'default' : 'waap'}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              disabled={busy}
              maxLength={32}
            />
          </label>
        </>
      )}

      {(localError || phase.kind === 'error') && (
        <p
          role="alert"
          style={{ color: 'rgba(255,99,132,0.95)', fontSize: 13, lineHeight: 1.4, margin: '0 0 12px' }}
        >
          {localError ?? (phase.kind === 'error' ? phase.message : '')}
        </p>
      )}
      {phase.kind === 'connecting' && (
        <p style={{ fontSize: 13, opacity: 0.85, margin: '0 0 12px' }}>opening waap…</p>
      )}
      {phase.kind === 'probing' && (
        <p style={{ fontSize: 13, opacity: 0.85, margin: '0 0 12px' }}>
          asking waap to sign a deterministic probe…
        </p>
      )}
      {phase.kind === 'submitting' && (
        <p style={{ fontSize: 13, opacity: 0.85, margin: '0 0 12px' }}>
          {seedMode === 'recovery-restore'
            ? 're-deriving your existing dWallet…'
            : 'finalizing vault…'}
        </p>
      )}

      {phase.kind === 'idle' && (
        <button
          type="button"
          className="ws-choose-btn ws-choose-btn--primary"
          onClick={start}
          disabled={busy}
        >
          continue
        </button>
      )}
      {phase.kind === 'fetching-phrase' && (
        <button type="button" className="ws-choose-btn ws-choose-btn--primary" disabled>
          generating phrase…
        </button>
      )}
      {phase.kind === 'show-phrase' && (
        <button
          type="button"
          className="ws-choose-btn ws-choose-btn--primary"
          onClick={() => void continueAfterGeneratedPhrase()}
          disabled={!phraseConfirmed}
        >
          open waap
        </button>
      )}
      {phase.kind === 'enter-phrase' && (
        <button
          type="button"
          className="ws-choose-btn ws-choose-btn--primary"
          onClick={() => void continueAfterRestoreInput()}
          disabled={!restoreInput.trim()}
        >
          open waap
        </button>
      )}
      {phase.kind === 'error' && (
        <button
          type="button"
          className="ws-choose-btn ws-choose-btn--secondary"
          onClick={() => setPhase({ kind: 'idle' })}
        >
          try again
        </button>
      )}
      <button
        type="button"
        className="ws-choose-btn ws-choose-btn--secondary"
        style={{ marginTop: 10 }}
        onClick={() => {
          setIntent(null);
          setStep('choose');
          setPhrase('');
          setPhraseConfirmed(false);
          setRestoreInput('');
          setPhase({ kind: 'idle' });
        }}
        disabled={busy}
      >
        ← back
      </button>
    </div>
  );
}
