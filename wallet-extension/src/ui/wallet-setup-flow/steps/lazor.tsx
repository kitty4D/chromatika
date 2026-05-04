import { useEffect, useState, type CSSProperties } from 'react';
import { trpc } from '@/lib/trpc';
import {
  lazorConnect,
  LAZOR_DEFAULTS,
  lazorDeterminismProbe,
  resolveLazorSmartWalletPda,
  deployLazorSmartWallet,
} from '@/ui/lazor/lazor-init';
import type { WalletSetupSurface } from '../internal';
import type { WalletSetupHook } from '../use-wallet-setup';

type Phase =
  | { kind: 'idle' }
  | { kind: 'fetching-phrase' }
  | { kind: 'show-phrase' }
  | { kind: 'enter-phrase' }
  | { kind: 'connecting-portal' }
  | { kind: 'deploying-smart-wallet' }
  | { kind: 'probing-determinism' }
  | { kind: 'submitting' }
  | { kind: 'done' }
  | { kind: 'error'; message: string };

/**
 * lazor (`@lazorkit/wallet`) vault create / add step. lazor's portal at `https://portal.lazor.sh`
 * runs the WebAuthn dance: chromatika doesn't access WebAuthn directly. ika seed dispatch is
 * three-way:
 *
 * 1. **lazor-signature** (recommended/experimental): the lazor passkey signs
 *    `IKA_USK_DERIVATION_MESSAGE_LAZOR_V1` via `dialogManager.openSignMessage`. chromatika does
 *    a determinism probe (sign twice + compare). when deterministic, signature seeds ika - no
 *    phrase, no separate fee-payer-from-phrase. restore via "log into existing" at the portal
 *    with the same passkey re-derives the same dwallet.
 * 2. **recovery-generate**: chromatika generates a fresh 24-word phrase. user writes it down.
 *    works on any authenticator (incl. non-deterministic ones).
 * 3. **recovery-restore**: user pastes their existing 24-word phrase. lazor passkey can be the
 *    same one OR a new one (both work; the smart wallet PDA is keyed to the credential).
 *
 * default mode is lazor-signature. phrase modes stay as the safety net for users on
 * non-deterministic authenticators or anyone restoring a v1 phrase-only vault.
 */
export function LazorStep({
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
  const [phrase, setPhrase] = useState('');
  const [phraseConfirmed, setPhraseConfirmed] = useState(false);
  const [restoreInput, setRestoreInput] = useState('');
  const [seedMode, setSeedMode] = useState<'lazor-signature' | 'recovery-generate' | 'recovery-restore'>('lazor-signature');

  const cls = `ws-step ws-step--${surface}`;
  const isBootstrap = mode === 'bootstrap';
  const busy =
    phase.kind === 'fetching-phrase'
    || phase.kind === 'connecting-portal'
    || phase.kind === 'deploying-smart-wallet'
    || phase.kind === 'probing-determinism'
    || phase.kind === 'submitting';

  // network is fixed to devnet for v1 (lazor's default RPC + paymaster point at devnet).
  const lazorNetwork: 'devnet' | 'mainnet' = 'devnet';

  // generate-phrase path: produce the phrase + transition to show-phrase.
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

  /** entry point: validate password + dispatch on seed mode. */
  function start() {
    setLocalError(null);
    if (password.length < 8) {
      setLocalError('password must be at least 8 characters');
      return;
    }
    if (isBootstrap && password !== password2) {
      setLocalError('passwords do not match');
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
    // lazor-signature path skips phrase steps; goes straight to portal + determinism probe.
    void runLazorSignaturePath();
  }

  /**
   * lazor-signature seed-source path. opens portal, resolves PDA, runs determinism probe (sign
   * twice + compare). on deterministic match, persists vault with the signature as the ika seed.
   * on mismatch, surface a clear error with a one-click bail-out to the recovery-words path.
   */
  async function runLazorSignaturePath() {
    setLocalError(null);
    setPhase({ kind: 'connecting-portal' });
    try {
      const { publicKey, credentialId } = await lazorConnect();
      const credentialIdB64 = credentialId;
      const passkeyPubkeyB64 = btoa(publicKey);
      let resolved = await resolveLazorSmartWalletPda(credentialIdB64);
      if (!resolved) {
        // portal registers the passkey credential but does NOT deploy the on-chain WalletState
        // account - mirrors @lazorkit/wallet useWallet().connect() reference flow which deploys
        // via paymaster on first connect when the smart wallet doesn't exist yet.
        setPhase({ kind: 'deploying-smart-wallet' });
        const deployed = await deployLazorSmartWallet(credentialIdB64, publicKey);
        resolved = {
          smartWalletPdaB58: deployed.smartWalletPdaB58,
          passkeyPublicKeyBytes: deployed.passkeyPublicKeyBytes,
          walletState: deployed.walletState,
          walletDevice: deployed.walletDevice,
          programIdB58: deployed.programIdB58,
        };
      }
      const smartWalletPubkey = resolved.smartWalletPdaB58;
      const lazorWalletDevicePubkeyB58 = resolved.walletDevice;

      setPhase({ kind: 'probing-determinism' });
      const probe = await lazorDeterminismProbe(credentialIdB64);
      if (!probe.deterministic) {
        throw new Error(
          'Your authenticator does not produce deterministic signatures, so the lazor-signature '
          + 'seed source cannot be used (chromatika would not be able to restore the same dwallet '
          + 'on another device). switch to "use a 24-word recovery phrase" below and continue - '
          + 'that path works on any authenticator. (apple platform authenticators + most hardware '
          + 'tokens are deterministic; some android implementations and older yubikeys are not.)',
        );
      }

      setPhase({ kind: 'submitting' });
      const labelTrimmed = label.trim() || (isBootstrap ? undefined : 'lazor');
      // pulled live from the lazor SDK via the resolver above (same client instance that found
      // the smart-wallet PDA), so a future SDK / network rotation flows through automatically.
      const lazorProgramId = resolved.programIdB58;
      const persistInput = {
        password,
        lazorSmartWalletPubkeyB58: smartWalletPubkey,
        lazorCredentialIdB64: credentialIdB64,
        lazorPasskeyPubkeyB64: passkeyPubkeyB64,
        lazorWalletDevicePubkeyB58,
        lazorProgramId,
        lazorNetwork,
        lazorPortalUrl: LAZOR_DEFAULTS.PORTAL_URL,
        seedSource: 'lazor-signature' as const,
        pairingSignatureB64: probe.signatureB64,
        label: labelTrimmed,
      };
      if (isBootstrap) {
        await trpc.createVaultLazor.mutate(persistInput);
        await trpc.unlockVault.mutate({ password, autoLockMinutes: 30 });
      } else {
        await trpc.addVaultLazor.mutate(persistInput);
      }
      hook.setPassword('');
      hook.setPassword2('');
      setPhase({ kind: 'done' });
      hook.onVaultReady();
    } catch (e) {
      setPhase({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }

  /** generate-phrase path next step: user has confirmed phrase, open portal + persist. */
  async function continueAfterGeneratedPhrase() {
    if (!phraseConfirmed) {
      setLocalError('confirm you have your recovery phrase saved');
      return;
    }
    await runRecoveryWordsPath(phrase);
  }

  /** restore-phrase path next step: user has typed phrase, validate + open portal + persist. */
  async function continueAfterRestoreInput() {
    const phraseTrimmed = restoreInput.trim().replace(/\s+/g, ' ');
    if (!phraseTrimmed) {
      setLocalError('enter your recovery phrase');
      return;
    }
    await runRecoveryWordsPath(phraseTrimmed);
  }

  /** shared persist for both recovery-words sub-paths (generate / restore). */
  async function runRecoveryWordsPath(phraseValue: string) {
    setLocalError(null);
    setPhase({ kind: 'connecting-portal' });
    try {
      const { publicKey, credentialId } = await lazorConnect();
      const credentialIdB64 = credentialId;
      const passkeyPubkeyB64 = btoa(publicKey);
      let resolved = await resolveLazorSmartWalletPda(credentialIdB64);
      if (!resolved) {
        // see runLazorSignaturePath - portal registers the passkey but doesn't deploy the
        // on-chain WalletState; chromatika deploys via paymaster on first connect.
        setPhase({ kind: 'deploying-smart-wallet' });
        const deployed = await deployLazorSmartWallet(credentialIdB64, publicKey);
        resolved = {
          smartWalletPdaB58: deployed.smartWalletPdaB58,
          passkeyPublicKeyBytes: deployed.passkeyPublicKeyBytes,
          walletState: deployed.walletState,
          walletDevice: deployed.walletDevice,
          programIdB58: deployed.programIdB58,
        };
      }
      const smartWalletPubkey = resolved.smartWalletPdaB58;
      const lazorWalletDevicePubkeyB58 = resolved.walletDevice;

      setPhase({ kind: 'submitting' });
      const labelTrimmed = label.trim() || (isBootstrap ? undefined : 'lazor');
      // pulled live from the lazor SDK via the resolver above (same client instance that found
      // the smart-wallet PDA), so a future SDK / network rotation flows through automatically.
      const lazorProgramId = resolved.programIdB58;
      const persistInput = {
        password,
        lazorSmartWalletPubkeyB58: smartWalletPubkey,
        lazorCredentialIdB64: credentialIdB64,
        lazorPasskeyPubkeyB64: passkeyPubkeyB64,
        lazorWalletDevicePubkeyB58,
        lazorProgramId,
        lazorNetwork,
        lazorPortalUrl: LAZOR_DEFAULTS.PORTAL_URL,
        seedSource: 'recovery-words' as const,
        recoveryWords: phraseValue,
        label: labelTrimmed,
      };
      if (isBootstrap) {
        await trpc.createVaultLazor.mutate(persistInput);
        await trpc.unlockVault.mutate({ password, autoLockMinutes: 30 });
      } else {
        await trpc.addVaultLazor.mutate(persistInput);
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
      <h2 style={{ margin: '0 0 8px' }}>create with lazor</h2>
      <p style={{ margin: '0 0 18px', fontSize: 13, lineHeight: 1.55, opacity: 0.85 }}>
        passkey-secured solana smart wallet via lazor's hosted portal. lazor is your solana
        identity; chromatika ties cross-chain (sui / evm / btc / aptos) to it via an ika dwallet.
      </p>

      {showInputs && (
        <>
          <label className="ws-password-label" style={{ display: 'block', marginBottom: 12 }}>
            <span>chromatika password</span>
            <input
              className="ws-password-input"
              type="password"
              autoComplete={isBootstrap ? 'new-password' : 'current-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
            />
          </label>
          {isBootstrap && (
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
              placeholder={isBootstrap ? 'default' : 'lazor'}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              disabled={busy}
              maxLength={32}
            />
          </label>
        </>
      )}

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
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 8, fontSize: 12.5 }}>
            <input
              type="radio"
              name="lazor-seed-mode"
              checked={seedMode === 'lazor-signature'}
              onChange={() => setSeedMode('lazor-signature')}
              disabled={busy}
              style={{ marginTop: 3 }}
            />
            <span>
              <strong>lazor passkey</strong> (recommended) - the same passkey produces the same
              dwallet on any device. no phrase to write down. requires a deterministic
              authenticator (apple platform / most hardware tokens).
            </span>
          </label>
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 8, fontSize: 12.5 }}>
            <input
              type="radio"
              name="lazor-seed-mode"
              checked={seedMode === 'recovery-generate'}
              onChange={() => setSeedMode('recovery-generate')}
              disabled={busy}
              style={{ marginTop: 3 }}
            />
            <span>
              <strong>generate a 24-word phrase</strong> - chromatika picks one for you. write
              it down to recover cross-chain on a new device. works on any authenticator.
            </span>
          </label>
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12.5 }}>
            <input
              type="radio"
              name="lazor-seed-mode"
              checked={seedMode === 'recovery-restore'}
              onChange={() => setSeedMode('recovery-restore')}
              disabled={busy}
              style={{ marginTop: 3 }}
            />
            <span>
              <strong>restore from phrase</strong> - paste your existing 24-word phrase. solana
              identity comes from re-pairing the same lazor account at the portal.
            </span>
          </label>
        </fieldset>
      )}

      {phase.kind === 'show-phrase' && (
        <>
          <p style={{ margin: '0 0 12px', fontSize: 13, lineHeight: 1.5, opacity: 0.95 }}>
            <strong>write this 24-word phrase down before continuing.</strong> it's how you
            recover cross-chain (sui / evm / btc / aptos) on a new device. lazor handles solana
            via your passkey, but cross-chain identity needs the phrase.
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
            style={{ width: '100%', minHeight: 100, marginBottom: 12, fontFamily: 'monospace', fontSize: 12 }}
            disabled={busy}
          />
        </>
      )}

      {(localError || phase.kind === 'error') && (
        <p role="alert" style={{ color: 'rgba(255,99,132,0.95)', fontSize: 13, lineHeight: 1.4, margin: '0 0 12px' }}>
          {localError ?? (phase.kind === 'error' ? phase.message : '')}
        </p>
      )}
      {phase.kind === 'connecting-portal' && (
        <p style={{ fontSize: 13, opacity: 0.85, margin: '0 0 12px' }}>
          opening lazor portal... authorize with your passkey.
        </p>
      )}
      {phase.kind === 'deploying-smart-wallet' && (
        <p style={{ fontSize: 13, opacity: 0.85, margin: '0 0 12px' }}>
          deploying your lazor smart wallet on solana devnet (paid by lazor's paymaster - free for
          you). this only happens once per passkey and usually takes 5-15s...
        </p>
      )}
      {phase.kind === 'probing-determinism' && (
        <p style={{ fontSize: 13, opacity: 0.85, margin: '0 0 12px' }}>
          checking signature determinism (one extra portal tap)...
        </p>
      )}
      {phase.kind === 'submitting' && (
        <p style={{ fontSize: 13, opacity: 0.85, margin: '0 0 12px' }}>finalizing vault...</p>
      )}

      {phase.kind === 'idle' && (
        <button type="button" className="ws-choose-btn ws-choose-btn--primary" onClick={start}>
          continue
        </button>
      )}
      {phase.kind === 'fetching-phrase' && (
        <button type="button" className="ws-choose-btn ws-choose-btn--primary" disabled>
          generating phrase...
        </button>
      )}
      {phase.kind === 'show-phrase' && (
        <button
          type="button"
          className="ws-choose-btn ws-choose-btn--primary"
          onClick={() => void continueAfterGeneratedPhrase()}
          disabled={!phraseConfirmed}
        >
          open lazor portal
        </button>
      )}
      {phase.kind === 'enter-phrase' && (
        <button
          type="button"
          className="ws-choose-btn ws-choose-btn--primary"
          onClick={() => void continueAfterRestoreInput()}
          disabled={!restoreInput.trim()}
        >
          open lazor portal
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
