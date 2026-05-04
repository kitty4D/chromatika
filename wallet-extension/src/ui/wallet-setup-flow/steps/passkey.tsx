import { useEffect, useState, type CSSProperties } from 'react';
import { trpc } from '@/lib/trpc';
import type { WalletSetupSurface } from '../internal';
import type { WalletSetupHook } from '../use-wallet-setup';

/**
 * sui passkey vault create / add step. issues `runPasskeyOnboarding` (bootstrap) or
 * `runPasskeyAddVault` (sibling) which orchestrates: open popup -> WebAuthn registration with
 * PRF hmac-secret extension -> ika dWallet seed derivation -> vault persisted -> returns
 * `{ vaultId, suiAddress }`.
 *
 * WebAuthn requires a user gesture in a visible window: `navigator.credentials.create` runs in
 * the popup component (`?passkeyregister=ID`), not here. this step's job is collecting the
 * password (and an optional vault label) then handing off to the orchestrator. the popup opens
 * automatically when the mutation queues the request.
 *
 * password is required: chromatika's local vault blob is still Argon2id + AES-GCM encrypted under
 * the user's password. passkey provides the deterministic ika seed; the password protects the
 * local on-disk blob from a stolen device. passkey-only unlock (no password) is a follow-up.
 */
export function PasskeyStep({
  surface,
  box,
  hook,
}: {
  surface: WalletSetupSurface;
  box: CSSProperties;
  hook: WalletSetupHook;
}) {
  const { mode, setStep, setIntent, password, setPassword, password2, setPassword2 } = hook;
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  // null = still probing; true = wallet blob exists (we're really unlocking + adding); false = fresh.
  const [walletExists, setWalletExistsLocal] = useState<boolean | null>(null);

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

  const cls = `ws-step ws-step--${surface}`;
  // "fresh" = no chromatika blob exists yet AND we're in bootstrap mode. only fresh-wallet
  // creation needs the password+confirm pair; everything else is single-password (existing
  // wallet unlock OR addVault from settings).
  const isFreshBootstrap = mode === 'bootstrap' && walletExists === false;
  const isBootstrap = mode === 'bootstrap';

  async function start() {
    setLocalError(null);
    // password rules depend on whether we're truly bootstrapping a fresh wallet vs unlocking
    // an existing one to add a passkey vault as a sibling:
    //  - fresh bootstrap: password OPTIONAL (empty = passkey-only unlock); confirm required if set
    //  - existing wallet unlock + add: password REQUIRED (decrypts the existing blob); no confirm
    const wantPassword = password.length > 0;
    if (walletExists === true && !wantPassword) {
      setLocalError('enter the existing chromatika password to unlock this wallet first.');
      return;
    }
    if (wantPassword && password.length < 8) {
      setLocalError(
        walletExists === true
          ? 'password must be at least 8 characters'
          : 'password must be at least 8 characters (or leave it empty for passkey-only)',
      );
      return;
    }
    if (isFreshBootstrap && wantPassword && password !== password2) {
      setLocalError('passwords do not match');
      return;
    }
    setBusy(true);
    try {
      const rpId = (typeof chrome !== 'undefined' && chrome.runtime?.id) || window.location.hostname;
      const labelTrimmed = label.trim() || (isBootstrap ? undefined : 'passkey');
      if (isBootstrap) {
        await trpc.runPasskeyOnboarding.mutate({
          password: wantPassword ? password : undefined,
          rpId,
          rpName: 'Chromatika',
          userName: 'chromatika',
          userDisplayName: 'Chromatika dWallet Vault',
          label: labelTrimmed,
        });
        // mirror createVault -> unlockVault sequence so the side panel reads "unlocked".
        // unlockVault works only for password envelopes; for passkey-only wallets the user
        // unlocks via the passkey button on the unlock screen on next visit. we can't unlock
        // here without re-running WebAuthn, so we just let the side panel's normal flow handle it.
        if (wantPassword) {
          await trpc.unlockVault.mutate({ password, autoLockMinutes: 30 });
        }
      } else {
        await trpc.runPasskeyAddVault.mutate({
          password: wantPassword ? password : undefined,
          rpId,
          rpName: 'Chromatika',
          userName: 'chromatika',
          userDisplayName: 'Chromatika dWallet Vault',
          label: labelTrimmed,
        });
      }
      hook.setPassword('');
      hook.setPassword2('');
      // signal upstream that the vault is ready: drives the onboarding celebration in the
      // tab path and lets the side panel re-probe + transition to the main view.
      hook.onVaultReady();
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // banner shown when the user landed on the passkey step but a wallet already exists. they
  // should normally hit the unlock screen first, but if they got here (e.g., a stale
  // onboarding tab that was opened before the wallet existed), give them a clear off-ramp.
  const showWalletExistsBanner = isBootstrap && walletExists === true;

  return (
    <div style={box} className={cls}>
      <h2 style={{ margin: '0 0 8px' }}>
        {walletExists === true ? 'add a passkey to your existing wallet' : 'create or restore with passkey'}
      </h2>
      {showWalletExistsBanner && (
        <p
          style={{
            margin: '0 0 14px',
            fontSize: 12.5,
            lineHeight: 1.45,
            padding: '10px 12px',
            borderRadius: 8,
            border: '1px solid rgba(124, 92, 252, 0.35)',
            background: 'rgba(124, 92, 252, 0.08)',
          }}
        >
          a chromatika wallet already exists on this device. open the side panel to unlock it
          normally, or enter your existing password below to register this passkey as an
          additional unlock method on the existing wallet.
        </p>
      )}
      <p style={{ margin: '0 0 18px', fontSize: 13, lineHeight: 1.55, opacity: 0.85 }}>
        face id, fingerprint, or pin - your device's passkey owns a sui-base ika dwallet vault.
        addresses on every supported chain (sui, solana, evm, btc, aptos) come from the dwallet's
        mpc layer.
      </p>
      {isFreshBootstrap && (
        <p style={{ margin: '0 0 18px', fontSize: 12.5, lineHeight: 1.5, opacity: 0.75 }}>
          already onboarded a chromatika passkey before? continuing with the same passkey
          re-derives the same dwallet automatically - your existing accounts will reappear after
          unlock. recovery via platform sync (icloud keychain, google password manager,
          1password, etc.) works the same way across devices.
        </p>
      )}

      <label className="ws-password-label" style={{ display: 'block', marginBottom: 12 }}>
        <span>
          {walletExists === true
            ? 'your existing chromatika password (to unlock + add this passkey)'
            : 'password (optional — leave empty for passkey-only unlock)'}
        </span>
        <input
          className="ws-password-input"
          type="password"
          autoComplete={isFreshBootstrap ? 'new-password' : 'current-password'}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={busy}
          placeholder={walletExists === true ? '' : 'optional'}
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
          placeholder={isBootstrap ? 'default' : 'passkey'}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          disabled={busy}
          maxLength={32}
        />
      </label>

      {localError && (
        <p role="alert" style={{ color: 'rgba(255,99,132,0.95)', fontSize: 13, lineHeight: 1.4, margin: '0 0 12px' }}>
          {localError}
        </p>
      )}

      <button
        type="button"
        className="ws-choose-btn ws-choose-btn--primary"
        onClick={start}
        disabled={busy}
      >
        {busy ? 'waiting for passkey…' : 'continue'}
      </button>
      <button
        type="button"
        className="ws-choose-btn ws-choose-btn--secondary"
        style={{ marginTop: 10 }}
        onClick={() => {
          setIntent(null);
          setStep('choose');
        }}
        disabled={busy}
      >
        ← back
      </button>
    </div>
  );
}
