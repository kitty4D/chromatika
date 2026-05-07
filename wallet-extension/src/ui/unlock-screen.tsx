import { useEffect, useRef, useState, type FormEvent } from 'react';
import { humanizeUnlockError } from '@/lib/humanize-unlock-error';

/**
 * extra non-password unlock method surfaced on the unlock screen. each entry comes from a
 * v4 vault envelope (passkey-prf, wallet-signature, recovery-words). the parent supplies the
 * click handler: the unlock screen just renders buttons + busy/error state.
 */
export interface ExtraUnlockMethod {
  id: string;
  kind: 'passkey-prf' | 'wallet-signature' | 'recovery-words';
  label: string;
  busy?: boolean;
  /** sub-copy shown under the label, e.g. "face id · fingerprint". */
  hint?: string;
  onClick: () => void;
}

export interface UnlockScreenProps {
  password: string;
  onPasswordChange: (v: string) => void;
  onSubmit: () => void;
  error?: string | null;
  bioEnrolled?: boolean;
  bioBusy?: boolean;
  onBiometricUnlock?: () => void;
  /**
   * non-password unlock methods (passkey / waap / seeker / lazor / recovery-words). when the
   * wallet has at least one of these AND no password envelope, the password input section
   * may be hidden via `hidePasswordSection`. otherwise the extras render below the password
   * form as additional buttons.
   */
  extraMethods?: ExtraUnlockMethod[];
  /** when true, hide the password input + submit. used for passkey-/waap-only wallets. */
  hidePasswordSection?: boolean;
}

/** pure presentational unlock form: no chrome.* / trpc deps, safe to render in the preview harness */
export function UnlockScreen(props: UnlockScreenProps) {
  const {
    password,
    onPasswordChange,
    onSubmit,
    error,
    bioEnrolled,
    bioBusy,
    onBiometricUnlock,
    extraMethods,
    hidePasswordSection,
  } = props;
  const [pressed, setPressed] = useState(false);
  const pressTimerRef = useRef<number | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const showPassword = !hidePasswordSection;
  const passkeyOnlyNoBio =
    hidePasswordSection &&
    !bioEnrolled &&
    (extraMethods?.length === 1 && extraMethods[0]!.kind === 'passkey-prf');

  /** password hidden, biometric is the sole unlock control (no passkey / waap rows) */
  const biometricOnlyNoExtras =
    hidePasswordSection &&
    bioEnrolled &&
    (extraMethods?.length ?? 0) === 0;

  const showPasswordRef = useRef(showPassword);
  showPasswordRef.current = showPassword;

  useEffect(() => () => {
    if (pressTimerRef.current !== null) window.clearTimeout(pressTimerRef.current);
  }, []);

  // side panel can swallow autoFocus on first frame while chrome is still opening the
  // panel: retry on rAF, on a short timeout, and whenever the window regains focus so
  // the password field is ready to type into the moment the surface is interactable.
  useEffect(() => {
    if (!showPassword) return;
    const focusInput = () => inputRef.current?.focus();
    focusInput();
    const raf = window.requestAnimationFrame(focusInput);
    const timer = window.setTimeout(focusInput, 80);
    window.addEventListener('focus', focusInput);
    return () => {
      window.cancelAnimationFrame(raf);
      window.clearTimeout(timer);
      window.removeEventListener('focus', focusInput);
    };
  }, [showPassword]);

  // belt-and-suspenders for the "user just starts typing" case: if focus has wandered
  // off the input (or never landed) but the surface itself has focus, capture the first
  // printable keystroke, route focus to the password field, and inject the character so
  // it isn't dropped. refs keep the listener registered once instead of rebinding per keystroke.
  const passwordRef = useRef(password);
  const onPasswordChangeRef = useRef(onPasswordChange);
  useEffect(() => {
    passwordRef.current = password;
    onPasswordChangeRef.current = onPasswordChange;
  });
  useEffect(() => {
    function onWindowKeyDown(e: KeyboardEvent) {
      if (!showPasswordRef.current) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key.length !== 1) return; // skip Tab/Enter/Arrow/etc.
      const active = document.activeElement as HTMLElement | null;
      const tag = active?.tagName;
      // already typing into a form control or interacting with a button - leave it alone
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'BUTTON' || tag === 'SELECT') return;
      if (active?.isContentEditable) return;
      e.preventDefault();
      inputRef.current?.focus();
      onPasswordChangeRef.current(passwordRef.current + e.key);
    }
    window.addEventListener('keydown', onWindowKeyDown);
    return () => window.removeEventListener('keydown', onWindowKeyDown);
  }, []);

  useEffect(() => {
    if (!passkeyOnlyNoBio || !extraMethods?.[0]) return;
    const { onClick } = extraMethods[0];
    function onPasskeyShortcut(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'Tab' || e.key === 'Escape') return;
      const active = document.activeElement as HTMLElement | null;
      const tag = active?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON' || active?.isContentEditable) return;
      e.preventDefault();
      onClick();
    }
    window.addEventListener('keydown', onPasskeyShortcut, true);
    return () => window.removeEventListener('keydown', onPasskeyShortcut, true);
  }, [passkeyOnlyNoBio, extraMethods]);

  useEffect(() => {
    if (!biometricOnlyNoExtras || !onBiometricUnlock) return;
    const runBio = onBiometricUnlock;
    function onBiometricShortcut(e: KeyboardEvent) {
      if (bioBusy) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'Tab' || e.key === 'Escape') return;
      const active = document.activeElement as HTMLElement | null;
      const tag = active?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON' || active?.isContentEditable) return;
      e.preventDefault();
      runBio();
    }
    window.addEventListener('keydown', onBiometricShortcut, true);
    return () => window.removeEventListener('keydown', onBiometricShortcut, true);
  }, [biometricOnlyNoExtras, onBiometricUnlock, bioBusy]);

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pressTimerRef.current !== null) window.clearTimeout(pressTimerRef.current);
    setPressed(true);
    pressTimerRef.current = window.setTimeout(() => {
      setPressed(false);
      pressTimerRef.current = null;
    }, 140);
    onSubmit();
  }

  const sloganCopy = (() => {
    if (showPassword && (extraMethods?.length ?? 0) > 0) return 'unlock with password or passkey.';
    if (!showPassword) return 'tap your unlock method.';
    return 'one password. every chain.';
  })();

  const displayError = humanizeUnlockError(error);

  return (
    <form className="sp-unlockScreen" onSubmit={handleSubmit}>
      <div className="sp-unlockBrand">
        <img src="/chromatika-clean-key.png" alt="" width={100} height={100} className="sp-unlockLogo" />
        <p className="sp-unlockSlogan">{sloganCopy}</p>
      </div>
      {showPassword && (
        <div className="sp-unlockFieldWrap">
          <input
            ref={inputRef}
            type="password"
            placeholder="Unlock with Password"
            className="sp-input sp-unlockField"
            value={password}
            onChange={(e) => onPasswordChange(e.target.value)}
            autoFocus
          />
          {displayError && <div className="sp-error">{displayError}</div>}
        </div>
      )}
      <div className="sp-unlockFooter">
        {!showPassword && displayError ? (
          <div className="sp-error sp-unlockFooterError" role="alert">
            {displayError}
          </div>
        ) : null}
        {showPassword && (
          <button
            type="submit"
            className={`sp-btn sp-btnPrimary sp-unlockPrimary${pressed ? ' sp-unlockPrimary--pressed' : ''}`}
          >
            unlock
          </button>
        )}
        {bioEnrolled && (
          <button
            type="button"
            className="sp-btn sp-unlockBio"
            disabled={bioBusy}
            onClick={() => onBiometricUnlock?.()}
          >
            {bioBusy ? 'unlocking…' : 'unlock with biometrics'}
          </button>
        )}
        {extraMethods && extraMethods.length > 0 && (
          <div className="sp-unlockExtras">
            {extraMethods.map((m) => (
              <button
                key={m.id}
                type="button"
                className="sp-btn sp-unlockExtra"
                disabled={Boolean(m.busy)}
                onClick={m.onClick}
              >
                <span className="sp-unlockExtraLabel">{m.busy ? 'unlocking…' : m.label}</span>
                {m.hint && <span className="sp-unlockExtraHint">{m.hint}</span>}
              </button>
            ))}
          </div>
        )}
      </div>
    </form>
  );
}
